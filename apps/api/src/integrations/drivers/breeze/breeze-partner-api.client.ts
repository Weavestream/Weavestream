import { stripTrailingSlashes } from '@weavestream/shared';
import { z } from 'zod';
import { fetchWithRetry } from '../driver-utils.js';
import { sourceVersionLabel } from '../../source-version.js';
import {
  DriverAuthError,
  DriverRateLimitError,
  DriverSourceVersionHoldError,
  type IntegrationContext,
} from '../integration-driver.js';
import {
  BREEZE_ENDPOINT_BY_RESOURCE,
  breezeEnvelopeSchema,
  breezeOrganizationSchema,
  breezeResourceKeySchema,
  breezeSourceEndpointSchema,
  readBreezeRecordSafely,
  type BreezeOrganization,
  type BreezePartnerEnvelope,
  type BreezeResourceKey,
  type BreezeSourceEndpoint,
} from './breeze.schemas.js';

const configSchema = z.object({ baseUrl: z.string().min(1).max(2_048) }).strict();
const secretSchema = z.object({ apiKey: z.string().min(1).max(8_192) }).strict();
const uuidSchema = z.guid();
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

/** The partner API schema version this Weavestream release reads. */
export const BREEZE_KNOWN_SCHEMA_VERSION = '1';
const SCHEMA_VERSION_LABEL = /^[A-Za-z0-9._-]{1,32}$/u;
const UNRECOGNIZED_SCHEMA_VERSION = 'unrecognized';

/**
 * Which schema versions a request accepts besides the known one: the
 * version an operator accepted earlier, or any version (an accepting run,
 * or a read that writes nothing, such as the organization picker).
 */
export interface BreezeSchemaVersionPolicy {
  accepted: string | null;
  acceptAny: boolean;
}

const KNOWN_VERSION_ONLY: BreezeSchemaVersionPolicy = { accepted: null, acceptAny: false };
const ANY_VERSION: BreezeSchemaVersionPolicy = { accepted: null, acceptAny: true };

/**
 * The version as a short label safe to show and store, or `unrecognized`
 * when Breeze sent none or something that is not a plain version string.
 */
export function breezeSchemaVersionLabel(raw: unknown): string {
  return typeof raw === 'string' && SCHEMA_VERSION_LABEL.test(raw) ? raw : UNRECOGNIZED_SCHEMA_VERSION;
}

export function unknownSchemaVersionMessage(version: string): string {
  const reported = version === UNRECOGNIZED_SCHEMA_VERSION
    ? 'did not report a partner API schema version Weavestream can read'
    : `reported partner API schema version ${version}, which Weavestream does not know yet`;
  return `Breeze ${reported}. Sync is paused and existing data is kept. An admin can continue with "Accept changes from Breeze RMM".`;
}

export function validateBreezeConfiguration(
  config: Record<string, unknown> | null | undefined,
  secret: Record<string, unknown> | null | undefined,
): void {
  if (config) {
    const parsed = configSchema.parse(config);
    buildBreezeUrl(parsed.baseUrl, 'api/v1/partner-api/organizations', new URLSearchParams());
  }
  if (secret) secretSchema.parse(secret);
}

/** `/health` is a few hundred bytes; anything far larger is not Breeze. */
const HEALTH_MAX_RESPONSE_BYTES = 16_384;

export class BreezePartnerApiClient {
  /**
   * The Breeze server release from `GET {baseUrl}/health` (`version`), or
   * null when Breeze does not report one. The endpoint needs no login, so
   * the API key is not sent. Network failures throw; the caller decides
   * that a missing version never fails anything.
   */
  async readServerVersion(ctx: BreezePartnerApiContext): Promise<string | null> {
    const { baseUrl } = configSchema.parse(ctx.config);
    const response = await fetchWithRetry(buildBreezeUrl(baseUrl, 'health', new URLSearchParams()), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      timeoutMs: ctx.http.timeoutMs,
      timeoutCoversBody: true,
      maxResponseBytes: HEALTH_MAX_RESPONSE_BYTES,
      maxRetries: ctx.http.maxRetries,
      backoffMs: ctx.http.backoffMs,
      correlationId: ctx.correlationId,
      serviceName: 'Breeze health',
    });
    if (!response.ok) return null;
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      // Not JSON: an older Breeze or a proxy page. The version is unknown.
      return null;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return sourceVersionLabel((raw as Record<string, unknown>)['version']);
  }

  /** Reaches the API and reports its schema version; any version passes. */
  async testConnection(ctx: BreezePartnerApiContext): Promise<{ schemaVersion: string }> {
    const page = await this.request(ctx, 'organizations', new URLSearchParams({ limit: '1' }), ANY_VERSION);
    return { schemaVersion: page.schemaVersion };
  }

  async listOrganizations(ctx: BreezePartnerApiContext): Promise<BreezeOrganization[]> {
    const organizations = new Map<string, BreezeOrganization>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let snapshotAt: string | null = null;
    for (let pageNumber = 1; pageNumber <= 1_000; pageNumber += 1) {
      const query = new URLSearchParams({ limit: '500' });
      if (cursor) query.set('cursor', cursor);
      // The picker writes nothing, so a version Weavestream does not know
      // yet does not stop it; records are read one at a time.
      const page = await this.request(ctx, 'organizations', query, ANY_VERSION);
      if (snapshotAt && page.snapshotAt !== snapshotAt) {
        throw new Error('Breeze partner API snapshot changed during traversal.');
      }
      snapshotAt ??= page.snapshotAt;
      for (const raw of page.data) {
        // An organization Weavestream cannot read is left out of the picker
        // rather than failing the whole listing.
        const organization = readBreezeRecordSafely(breezeOrganizationSchema, raw);
        if (organization.success) organizations.set(organization.data.id, organization.data);
      }
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
      acceptedSchemaVersion?: string | null;
      acceptAnySchemaVersion?: boolean;
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
    const page = await this.request(ctx, BREEZE_ENDPOINT_BY_RESOURCE[resource.data], query, {
      accepted: input.acceptedSchemaVersion ?? null,
      acceptAny: input.acceptAnySchemaVersion === true,
    });
    if (input.cursor !== null && page.nextCursor === input.cursor) {
      throw new Error('Breeze partner API cursor did not advance.');
    }
    return page;
  }

  private async request(
    ctx: BreezePartnerApiContext,
    rawEndpoint: BreezeSourceEndpoint,
    query: URLSearchParams,
    versionPolicy: BreezeSchemaVersionPolicy = KNOWN_VERSION_ONLY,
  ): Promise<BreezePartnerEnvelope<unknown>> {
    const endpoint = breezeSourceEndpointSchema.parse(rawEndpoint);
    const { baseUrl } = configSchema.parse(ctx.config);
    const { apiKey } = secretSchema.parse(ctx.secret);
    const url = buildBreezeUrl(baseUrl, `api/v1/partner-api/${endpoint}`, query);
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
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Breeze partner API returned invalid response data.');
    }
    // A schema version Weavestream does not know pauses the sync before any
    // record is read: nothing is written or archived until an operator
    // accepts the version (or a Weavestream release that knows it ships).
    const schemaVersion = breezeSchemaVersionLabel((raw as Record<string, unknown>)['schemaVersion']);
    if (
      schemaVersion !== BREEZE_KNOWN_SCHEMA_VERSION &&
      schemaVersion !== versionPolicy.accepted &&
      !versionPolicy.acceptAny
    ) {
      throw new DriverSourceVersionHoldError(schemaVersion, unknownSchemaVersionMessage(schemaVersion));
    }
    // Only the envelope is validated here. Records are read one at a time by
    // the transform, so one record Weavestream cannot read never fails the
    // page that carries it.
    try {
      const envelope = breezeEnvelopeSchema.parse(raw);
      return { ...envelope, schemaVersion } as BreezePartnerEnvelope<unknown>;
    } catch (error) {
      throw new Error('Breeze partner API returned invalid response data.', { cause: error });
    }
  }
}

/** `path` is a fixed path below the base URL, never request input. */
function buildBreezeUrl(
  baseUrl: string,
  path: 'health' | `api/v1/partner-api/${BreezeSourceEndpoint}`,
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
  parsed.pathname = `${stripTrailingSlashes(parsed.pathname)}/${path}`;
  parsed.search = query.toString();
  return parsed.toString();
}
