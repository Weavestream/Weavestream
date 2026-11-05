import {
  CUSTOM_API_DEVICE_STANDARD_FIELDS,
  CUSTOM_API_LIMITS,
  listScalarPaths,
  parsePath,
  readPath,
  type CustomApiDefinition,
  type CustomApiResource,
  type CustomApiTestField,
  type CustomApiTestKey,
  type CustomApiTestRecord,
  type CustomApiTestResponse,
  type CustomApiTestSection,
  type PathPart,
} from '@weavestream/shared';
import { DriverAuthError, DriverRateLimitError, type IntegrationContext } from '../integration-driver.js';
import { STANDARD_FIELDS } from '../standard-resources.js';
import { isSensitiveKey, scanSensitiveMaterial } from '../../sensitive-material.js';
import { CustomApiAuthError, CustomApiRequestError, customApiCall } from './custom-api.http.js';
import { fetchListPage } from './custom-api.pagination.js';
import { SINGLE_ORG_ID, SINGLE_ORG_NAME, enabledResources, orgsFromItems, resourceListSpec } from './custom-api.orgs.js';

/**
 * Test for one section of a draft definition: reads 1 page and returns
 * the record count, whether more pages follow, up to 5 parsed records and
 * a key list of the first record. Nothing upstream is returned raw.
 *
 * Masking: every sample is checked on its full value, before it is cut
 * to 80 characters, with its source path as context. A value is masked
 * when any key on its path names a credential, or when the scan of
 * `{ <last key>: value }` is not `safe` (a scan over its bounds counts as
 * sensitive). The same rule covers the key list and every mapped value,
 * by source path, never by the operator's label.
 *
 * Probes never use the shared OAuth token cache (`tokenCache: 'none'`).
 */

export const MASK = '••••';

type Scalar = string | number | boolean;
type ProbeOutcome = CustomApiTestResponse extends infer R ? (R extends unknown ? Omit<R, 'correlationId'> : never) : never;

export interface ProbeInput {
  definition: CustomApiDefinition;
  secret: Record<string, unknown>;
  section: CustomApiTestSection;
  orgId?: string;
  http: IntegrationContext['http'];
  correlationId: string;
}

/** A sample of one value at its source path. */
export function sampleValue(parts: readonly PathPart[], value: Scalar | null): { value: string | null; masked: boolean } {
  if (value === null) return { value: null, masked: false };
  if (parts.some((part) => typeof part === 'string' && isSensitiveKey(part))) return { value: MASK, masked: true };
  const lastKey = [...parts].reverse().find((part): part is string => typeof part === 'string') ?? 'value';
  if (scanSensitiveMaterial({ [lastKey]: value }) !== 'safe') return { value: MASK, masked: true };
  return { value: String(value).slice(0, CUSTOM_API_LIMITS.testSampleLength), masked: false };
}

function sampleAt(item: unknown, path: string | undefined): string | null {
  if (!path) return null;
  const parts = parsePath(path);
  const read = readPath(item, parts);
  return read.kind === 'value' ? sampleValue(parts, read.value).value : null;
}

function field(item: unknown, key: string, label: string, path: string): CustomApiTestField {
  const parts = parsePath(path);
  const read = readPath(item, parts);
  if (read.kind === 'missing') return { key, label, path, value: null, masked: false, warning: 'missing' };
  if (read.kind === 'not_scalar') return { key, label, path, value: null, masked: false, warning: 'not_scalar' };
  const sample = sampleValue(parts, read.value);
  return { key, label, path, value: sample.value, masked: sample.masked, warning: null };
}

export function keyList(item: unknown): CustomApiTestKey[] {
  if (item === undefined) return [];
  return listScalarPaths(item, { maxEntries: CUSTOM_API_LIMITS.testKeys }).map((entry) => {
    const sample = sampleValue(entry.parts, entry.value === null ? null : entry.value);
    return { path: entry.path, type: entry.type, sample: sample.value, masked: sample.masked };
  });
}

export function testRecord(item: unknown, resource: CustomApiResource): CustomApiTestRecord {
  const fields: CustomApiTestField[] = [];
  if ('standardFields' in resource) {
    for (const key of CUSTOM_API_DEVICE_STANDARD_FIELDS) {
      const path = resource.standardFields[key];
      if (path) fields.push(field(item, key, STANDARD_FIELDS[key].label, path));
    }
  }
  for (const extra of resource.extraFields) fields.push(field(item, extra.key, extra.label, extra.path));
  return {
    id: sampleAt(item, resource.idPath),
    name: sampleAt(item, resource.namePath),
    match: sampleAt(item, resource.matchPath),
    fields,
  };
}

function failure(section: CustomApiTestSection, message: string, status: number | null): ProbeOutcome {
  return { ok: false, section, message, status };
}

/** Driver failures as fixed text; anything else is rethrown for the caller's generic message. */
function asFailure(section: CustomApiTestSection, e: unknown): ProbeOutcome {
  if (e instanceof CustomApiRequestError) return failure(section, e.message, e.status);
  if (e instanceof CustomApiAuthError) return failure(section, e.message, e.status);
  if (e instanceof DriverAuthError) return failure(section, 'The credentials for this API are missing. Enter them, then test again.', null);
  if (e instanceof DriverRateLimitError) return failure(section, 'The API is rate limiting requests. Wait a minute, then test again.', 429);
  throw e;
}

export async function runProbe(input: ProbeInput): Promise<ProbeOutcome> {
  const { definition, section } = input;
  const call = customApiCall(
    { config: {}, secret: input.secret, http: input.http, correlationId: input.correlationId },
    definition,
    'none',
  );
  try {
    if (section === 'organizations') {
      const orgs = definition.organizations;
      if (orgs.mode === 'single') {
        return { ok: true, section, recordCount: 1, hasMore: false, records: [{ id: SINGLE_ORG_ID, name: SINGLE_ORG_NAME, match: null, fields: [] }], keys: [] };
      }
      if (orgs.mode === 'endpoint') {
        const page = await fetchListPage(call, { request: orgs.request, recordsPath: orgs.recordsPath, pagination: orgs.pagination }, {}, null);
        const records = page.items.slice(0, CUSTOM_API_LIMITS.testOrganizations).map((item) => ({
          id: sampleAt(item, orgs.idPath),
          name: sampleAt(item, orgs.namePath),
          match: null,
          fields: [],
        }));
        return { ok: true, section, recordCount: page.items.length, hasMore: page.next !== null, records, keys: keyList(page.items[0]) };
      }
      const first = enabledResources(definition).find(({ resource }) => resource.orgIdPath);
      if (!first?.resource.orgIdPath) return failure(section, 'Turn on a resource and set its organization id path first.', null);
      const page = await fetchListPage(call, resourceListSpec(first.resource), {}, null);
      const found = orgsFromItems(page.items, first.resource.orgIdPath, first.resource.orgNamePath).slice(0, CUSTOM_API_LIMITS.testOrganizations);
      // The ids and names come from record values: mask them by their source paths too.
      const idParts = parsePath(first.resource.orgIdPath);
      const nameParts = first.resource.orgNamePath ? parsePath(first.resource.orgNamePath) : idParts;
      const records = found.map((org) => ({
        id: sampleValue(idParts, org.externalId).value,
        name: sampleValue(nameParts, org.name).value,
        match: null,
        fields: [],
      }));
      return { ok: true, section, recordCount: found.length, hasMore: page.next !== null, records, keys: keyList(page.items[0]) };
    }

    const resource = definition.resources[section];
    if (!resource.enabled) return failure(section, 'This resource is turned off in the definition.', null);
    const orgVars: { orgId?: string } = {};
    if (definition.organizations.mode === 'endpoint') {
      if (!input.orgId) return failure(section, 'Enter an organization id to test with. Test Organizations first to see the ids.', null);
      orgVars.orgId = input.orgId;
    }
    const page = await fetchListPage(call, resourceListSpec(resource), orgVars, null);
    return {
      ok: true,
      section,
      recordCount: page.items.length,
      hasMore: page.next !== null,
      records: page.items.slice(0, CUSTOM_API_LIMITS.testRecords).map((item) => testRecord(item, resource)),
      keys: keyList(page.items[0]),
    };
  } catch (e) {
    return asFailure(section, e);
  }
}
