import { z } from 'zod';
import { fetchWithRetry } from '../driver-utils.js';
import {
  DriverAuthError,
  DriverRateLimitError,
  type IntegrationContext,
} from '../integration-driver.js';
import {
  BREEZE_ENDPOINT_BY_RESOURCE,
  breezeEnvelopeSchema,
  breezeRecordSchemaByEndpoint,
  breezeResourceKeySchema,
  breezeSourceEndpointSchema,
  sanitizeBreezeText,
  type BreezeOrganization,
  type BreezePartnerEnvelope,
  type BreezeResourceKey,
  type BreezeSourceEndpoint,
} from './breeze.schemas.js';

const configSchema = z.object({ baseUrl: z.string().min(1).max(2_048) }).strict();
const secretSchema = z.object({ apiKey: z.string().min(1).max(8_192) }).strict();
const uuidSchema = z.string().uuid();
const timestampSchema = z.string().datetime({ offset: true });
const FAN_OUT_RESOURCES = new Set<BreezeResourceKey>([
  'network-equipment',
  'virtual-machines',
  'subnets',
  'ip-reservations',
  'device-relationships',
  'automation-relations',
]);

export type BreezePartnerApiContext = IntegrationContext;

export function validateBreezeConfiguration(
  config: Record<string, unknown> | null | undefined,
  secret: Record<string, unknown> | null | undefined,
): void {
  if (config) {
    const parsed = configSchema.parse(config);
    buildBreezeUrl(parsed.baseUrl, 'organizations', new URLSearchParams());
  }
  if (secret) secretSchema.parse(secret);
}

export class BreezePartnerApiClient {
  async testConnection(ctx: BreezePartnerApiContext): Promise<void> {
    await this.request(ctx, 'organizations', new URLSearchParams({ limit: '1' }));
  }

  async listOrganizations(ctx: BreezePartnerApiContext): Promise<BreezeOrganization[]> {
    const organizations = new Map<string, BreezeOrganization>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let snapshotAt: string | null = null;
    for (let pageNumber = 1; pageNumber <= 1_000; pageNumber += 1) {
      const query = new URLSearchParams({ limit: '500' });
      if (cursor) query.set('cursor', cursor);
      const page = await this.request<BreezeOrganization>(ctx, 'organizations', query);
      if (snapshotAt && page.snapshotAt !== snapshotAt) {
        throw new Error('Breeze partner API snapshot changed during traversal.');
      }
      snapshotAt ??= page.snapshotAt;
      for (const organization of page.data) organizations.set(organization.id, organization);
      if (!page.hasMore) return [...organizations.values()];
      if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
        throw new Error('Breeze partner API cursor did not advance.');
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new Error('Breeze partner API traversal exceeded 1000 pages.');
  }

  async fetchPage(
    ctx: BreezePartnerApiContext,
    input: {
      resource: BreezeResourceKey;
      externalOrgId: string;
      cursor: string | null;
      updatedSince: string | null;
    },
  ): Promise<BreezePartnerEnvelope<unknown>> {
    const resource = breezeResourceKeySchema.safeParse(input.resource);
    if (!resource.success) throw new Error('Unknown Breeze resource.');
    const externalOrgId = uuidSchema.parse(input.externalOrgId);
    const query = new URLSearchParams({ orgId: externalOrgId });
    if (input.updatedSince !== null)
      query.set('updatedSince', timestampSchema.parse(input.updatedSince));
    if (input.cursor !== null) query.set('cursor', input.cursor);
    query.set('limit', FAN_OUT_RESOURCES.has(resource.data) ? '20' : '500');
    const page = await this.request(ctx, BREEZE_ENDPOINT_BY_RESOURCE[resource.data], query);
    if (input.cursor !== null && page.nextCursor === input.cursor) {
      throw new Error('Breeze partner API cursor did not advance.');
    }
    return page;
  }

  private async request<T = unknown>(
    ctx: BreezePartnerApiContext,
    rawEndpoint: BreezeSourceEndpoint,
    query: URLSearchParams,
  ): Promise<BreezePartnerEnvelope<T>> {
    const endpoint = breezeSourceEndpointSchema.parse(rawEndpoint);
    const { baseUrl } = configSchema.parse(ctx.config);
    const { apiKey } = secretSchema.parse(ctx.secret);
    const url = buildBreezeUrl(baseUrl, endpoint, query);
    let response: Response;
    try {
      response = await fetchWithRetry(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'X-API-Key': apiKey },
        redirect: 'manual',
        timeoutMs: ctx.http.timeoutMs,
        maxRetries: ctx.http.maxRetries,
        backoffMs: ctx.http.backoffMs,
        correlationId: ctx.correlationId,
        serviceName: 'Breeze partner API',
      });
    } catch (error) {
      if (error instanceof DriverRateLimitError) throw error;
      // Egress-guard refusals carry an already-redacted URL + reason and
      // fetchWithRetry rethrows them precisely so the operator can see
      // why the destination was refused — pass them through unmasked.
      if (error instanceof Error && error.name === 'EgressBlockedError') throw error;
      // The replacement message stays generic because upstream error text
      // could echo request material; the original failure travels on
      // `cause` so describeError / log serializers can surface it.
      throw new Error('Breeze partner API request failed.', { cause: error });
    }
    if (response.status === 401 || response.status === 403) {
      throw new DriverAuthError('Breeze partner API credentials were rejected.');
    }
    if (!response.ok) {
      throw new Error(`Breeze partner API request failed (${response.status}).`);
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch (error) {
      throw new Error('Breeze partner API returned invalid response data.', { cause: error });
    }
    if (
      !raw ||
      typeof raw !== 'object' ||
      (raw as Record<string, unknown>)['schemaVersion'] !== '1'
    ) {
      throw new Error('Breeze partner API returned invalid response data.');
    }
    try {
      const schema = breezeEnvelopeSchema(breezeRecordSchemaByEndpoint[endpoint]);
      const validated = schema.parse(raw);
      return schema.parse(sanitizeBreezeText(validated)) as BreezePartnerEnvelope<T>;
    } catch (error) {
      throw new Error('Breeze partner API returned invalid response data.', { cause: error });
    }
  }
}

function buildBreezeUrl(
  baseUrl: string,
  endpoint: BreezeSourceEndpoint,
  query: URLSearchParams,
): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('Breeze baseUrl is invalid.');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      'Breeze baseUrl must be an HTTP(S) URL without credentials, query, or fragment.',
    );
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, '')}/api/v1/partner-api/${endpoint}`;
  parsed.search = query.toString();
  return parsed.toString();
}
