import { BadRequestException, Logger } from '@nestjs/common';
import { z } from 'zod';
import {
  CUSTOM_API_RESOURCE_KEYS,
  customApiDefinitionSchema,
  customApiRequiredSecretKeys,
  customApiSecretKeyLabel,
  type CustomApiDefinition,
  type CustomApiResourceKey,
  type DriverDescriptor,
  type IntegrationSetupCheck,
  type SourceFieldDto,
  type SourceOrgDto,
} from '@weavestream/shared';
import {
  DriverAuthError,
  DriverResourceUnavailableError,
  type DriverDiagnoseInput,
  type FetchRecordsContext,
  type IntegrationContext,
  type IntegrationDriver,
  type LegacyDriverFetchPage,
  type LegacyDriverRecord,
} from '../integration-driver.js';
import { evictRun, runCached } from '../run-cache.js';
import { CustomApiRequestError, customApiCall } from './custom-api.http.js';
import { RepeatGuard, decodePageState, encodePageState, fetchAllItems, fetchListPage } from './custom-api.pagination.js';
import { SINGLE_ORG_ID, enabledResources, listOrganizations, resourceListSpec } from './custom-api.orgs.js';
import { idAt, parseRecord, sourceFields, toDriverRecord } from './custom-api.records.js';
import { CUSTOM_API_DRIVER_KEY, CUSTOM_API_RECOMMENDED_DESTINATIONS, CUSTOM_API_RESOURCES } from './custom-api.resources.js';
import { CustomApiDefinitionError, diagnoseCustomApi } from './custom-api.diagnose.js';
import { CUSTOM_API_SETUP_GUIDE } from './custom-api.setup-guide.js';

/**
 * Custom API driver (read-only): a generic pull driver for JSON-over-HTTPS
 * APIs that have no built-in driver. The operator describes the API in
 * `config` (customApiDefinitionSchema): authentication, where the
 * organizations are, where the records are, how pages work and which path
 * holds each field. Secret values live in the integration secret under
 * the keys from customApiRequiredSecretKeys.
 *
 * Every request stays on the Base URL origin and path prefix (the OAuth
 * token URL aside) and goes through the egress guard. Records are
 * untrusted: single values only, strings capped, no HTTP body text in any
 * error. See Build_Plan/Integrations/custom-api.md.
 */

const logger = new Logger('CustomApiDriver');

/** Records per page in `field` mode, where one read of all records is cut into pages. */
const FIELD_MODE_PAGE_SIZE = 500;

const fieldCursorSchema = z.object({ chunk: z.number().int().min(0) }).strict();

function encodeFieldCursor(chunk: number): string {
  return Buffer.from(JSON.stringify({ chunk }), 'utf8').toString('base64');
}

function decodeFieldCursor(cursor: string | null): number {
  if (!cursor) return 0;
  try {
    const parsed = fieldCursorSchema.safeParse(JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')));
    return parsed.success ? parsed.data.chunk : 0;
  } catch {
    // A malformed cursor restarts from the first chunk.
    return 0;
  }
}

function isResourceKey(key: string): key is CustomApiResourceKey {
  return (CUSTOM_API_RESOURCE_KEYS as readonly string[]).includes(key);
}

/** The saved definition; a definition that does not validate stops the call with fixed text. */
export function definitionOf(config: Record<string, unknown> | null | undefined): CustomApiDefinition {
  const parsed = customApiDefinitionSchema.safeParse(config ?? {});
  if (!parsed.success) throw new CustomApiDefinitionError();
  return parsed.data;
}

export class CustomApiDriver implements IntegrationDriver {
  readonly key = CUSTOM_API_DRIVER_KEY;

  readonly recommendedDestinations = CUSTOM_API_RECOMMENDED_DESTINATIONS;

  readonly descriptor: DriverDescriptor = {
    key: CUSTOM_API_DRIVER_KEY,
    label: 'Custom API',
    description: 'Connect any JSON API that has no built-in integration.',
    iconKey: CUSTOM_API_DRIVER_KEY,
    // The whole config is the API definition, edited with the definition editor.
    configFields: [],
    // Which keys are needed depends on the definition; validateConfiguration checks the exact set.
    secretFields: [
      { key: 'token', label: 'Token', kind: 'password', required: false, description: 'Bearer authentication.' },
      { key: 'value', label: 'Header value', kind: 'password', required: false, description: 'API key header authentication.' },
      { key: 'password', label: 'Password', kind: 'password', required: false, description: 'Basic authentication.' },
      { key: 'clientId', label: 'Client ID', kind: 'password', required: false, description: 'OAuth client credentials.' },
      { key: 'clientSecret', label: 'Client secret', kind: 'password', required: false, description: 'OAuth client credentials.' },
    ],
    secretBoundConfigKeys: ['baseUrl', 'auth.tokenUrl'],
    setupGuide: CUSTOM_API_SETUP_GUIDE,
    resources: CUSTOM_API_RESOURCES,
    capabilities: {
      kind: 'pull',
      listSourceOrgs: true,
      dryRun: true,
      ticketing: false,
      reconstructionCompleteness: false,
      apiDefinition: true,
    },
  };

  /**
   * The definition must validate, and the secret must hold exactly the
   * keys the definition needs (auth method + secret headers): nothing
   * missing, and nothing left over from an earlier method. A definition
   * with no authentication needs no secret at all.
   */
  validateConfiguration(
    config: Record<string, unknown> | null | undefined,
    secret: Record<string, unknown> | null | undefined,
  ): void {
    const parsed = customApiDefinitionSchema.safeParse(config ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'ValidationError',
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    const required = customApiRequiredSecretKeys(parsed.data);
    const present = Object.keys(secret ?? {});
    if (required.length === 0) {
      if (present.length > 0) {
        throw new BadRequestException('This API definition uses no credentials. Clear the saved credentials.');
      }
      return;
    }
    const values = secret ?? {};
    const missing = required.filter((key) => typeof values[key] !== 'string' || values[key] === '' || (values[key] as string).length > 8_192);
    const extra = present.filter((key) => !required.includes(key));
    if (missing.length > 0 || extra.length > 0) {
      const names = required.map(customApiSecretKeyLabel);
      throw new BadRequestException(`The credentials do not match the authentication of this definition. Enter all of: ${names.join(', ')}.`);
    }
  }

  requiresSecret(config: Record<string, unknown>): boolean {
    const parsed = customApiDefinitionSchema.safeParse(config ?? {});
    // An invalid definition keeps the default: a secret is required.
    return parsed.success ? customApiRequiredSecretKeys(parsed.data).length > 0 : true;
  }

  diagnose(input: DriverDiagnoseInput): Promise<IntegrationSetupCheck> {
    if (input.mode !== 'connection') {
      return Promise.resolve({ ok: false, passedStepIds: [], failures: [{ stepId: null, message: 'Custom API has no OAuth app to check.' }] });
    }
    return diagnoseCustomApi(() => this.reachApi(input.ctx));
  }

  async testConnection(ctx: IntegrationContext): Promise<{ ok: true; details?: string }> {
    const orgs = await this.reachApi(ctx);
    return { ok: true, details: `Connected to the API (${orgs} organizations).` };
  }

  /**
   * One real call to the API for Test connection and Check setup; returns
   * the organization count. Endpoint and field modes read the organizations
   * from the API. Single mode has a fixed organization and no
   * organizations request, so it reads the first page of the first
   * enabled resource: otherwise wrong credentials or a wrong host would
   * pass both checks without a request.
   */
  private async reachApi(ctx: IntegrationContext): Promise<number> {
    const definition = definitionOf(ctx.config);
    const call = customApiCall(ctx, definition, 'shared');
    if (definition.organizations.mode === 'single') {
      const first = enabledResources(definition)[0];
      if (!first) {
        throw new CustomApiRequestError('The saved API definition has no resource turned on. Turn on Devices or Other assets, save, then check again.', null);
      }
      await fetchListPage(call, resourceListSpec(first.resource), {}, null);
    }
    return (await listOrganizations(call)).length;
  }

  listSourceOrgs(ctx: IntegrationContext): Promise<SourceOrgDto[]> {
    const definition = definitionOf(ctx.config);
    return listOrganizations(customApiCall(ctx, definition, 'shared'));
  }

  async listSourceFields(
    ctx: IntegrationContext & { externalOrgId: string; resourceKey: string },
  ): Promise<SourceFieldDto[]> {
    if (!isResourceKey(ctx.resourceKey)) return [];
    const parsed = customApiDefinitionSchema.safeParse(ctx.config ?? {});
    const resource = parsed.success ? parsed.data.resources[ctx.resourceKey] : null;
    return sourceFields(ctx.resourceKey, resource?.enabled ? resource : null);
  }

  async fetchRecords(ctx: FetchRecordsContext, cursor: string | null): Promise<LegacyDriverFetchPage> {
    if (!isResourceKey(ctx.resourceKey)) throw new Error(`Unknown Custom API resource: ${ctx.resourceKey}`);
    const resourceKey = ctx.resourceKey;
    const definition = definitionOf(ctx.config);
    const resource = definition.resources[resourceKey];
    if (!resource.enabled) {
      throw new DriverResourceUnavailableError('the API definition turns this resource off.');
    }
    const call = customApiCall(ctx, definition, 'shared');
    const snapshotAt = ctx.snapshotAt ?? new Date().toISOString();
    const orgs = definition.organizations;

    let items: unknown[];
    let next: string | null;
    if (orgs.mode === 'field') {
      // One read of all records for each organization's walk, cut into
      // pages; this org keeps its own. The run cache key holds the walk's
      // snapshotAt, so each mapped organization reads the whole list again.
      const all = await runCached(ctx, snapshotAt, `all:${resourceKey}`, () => fetchAllItems(call, resourceListSpec(resource), {}));
      const mine = all.filter((item) => idAt(item, resource.orgIdPath!) === ctx.externalOrgId);
      const chunk = decodeFieldCursor(cursor);
      items = mine.slice(chunk * FIELD_MODE_PAGE_SIZE, (chunk + 1) * FIELD_MODE_PAGE_SIZE);
      next = (chunk + 1) * FIELD_MODE_PAGE_SIZE < mine.length ? encodeFieldCursor(chunk + 1) : null;
    } else {
      // Tenant isolation: only an organization this API lists may feed a company.
      if (orgs.mode === 'single') {
        if (ctx.externalOrgId !== SINGLE_ORG_ID) {
          throw new DriverAuthError('The mapped organization is not part of this integration. Map the organization listed under Organizations.');
        }
      } else {
        const known = await runCached(ctx, snapshotAt, 'orgs', () => listOrganizations(call));
        if (!known.some((org) => org.externalId === ctx.externalOrgId)) {
          throw new DriverAuthError('The mapped organization is not returned by the API. Map an organization listed under Organizations.');
        }
      }
      const state = decodePageState(cursor, resource.pagination.style);
      const guard = await runCached(ctx, snapshotAt, `pages:${ctx.externalOrgId}:${resourceKey}`, async () => new RepeatGuard());
      const page = await fetchListPage(call, resourceListSpec(resource), orgs.mode === 'endpoint' ? { orgId: ctx.externalOrgId } : {}, state);
      guard.checkPage(page.items);
      guard.check(page.next);
      items = page.items;
      next = encodePageState(page.next);
    }

    const records: LegacyDriverRecord[] = [];
    const seenIds = new Set<string>();
    let withoutId = 0;
    let otherOrg = 0;
    for (const item of items) {
      const parsed = parseRecord(item, resourceKey, resource);
      if (!parsed) {
        withoutId += 1;
        continue;
      }
      // IDOR backstop: a record that names another organization is never
      // synced into this one's company.
      if (orgs.mode === 'endpoint' && resource.orgIdPath && parsed.orgId !== ctx.externalOrgId) {
        otherOrg += 1;
        continue;
      }
      if (seenIds.has(parsed.externalId)) continue;
      seenIds.add(parsed.externalId);
      records.push(toDriverRecord(resourceKey, resource, parsed));
    }
    if (otherOrg > 0) {
      logger.warn(
        { integrationId: ctx.integrationId, correlationId: ctx.correlationId, resourceKey, dropped: otherOrg },
        'custom api dropped records of another organization',
      );
    }
    if (withoutId > 0) {
      logger.debug({ integrationId: ctx.integrationId, correlationId: ctx.correlationId, resourceKey, skipped: withoutId }, 'custom api skipped records without an id');
    }

    if (next === null) evictRun(ctx, snapshotAt);
    return { records, hasMore: next !== null, cursor: next, snapshotAt };
  }
}
