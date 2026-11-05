import { z } from 'zod';
import { CustomApiPathError, parsePath } from '../custom-api-path.js';
import { INTEGRATION_SECTION_LIMITS } from './integration-section.js';

/**
 * Custom API definition (v1): how Weavestream reads a JSON-over-HTTPS
 * API that has no built-in driver. Stored in `Integration.config` of a
 * `custom-api` integration. Secret values are never part of it; they
 * live in the integration secret under the keys from
 * `customApiRequiredSecretKeys`.
 *
 * The web form, the import, the API and the driver all validate with
 * this schema. See Build_Plan/Integrations/custom-api.md.
 */

export const CUSTOM_API_LIMITS = {
  /** Serialized definition size. */
  definitionBytes: 64 * 1024,
  headers: 16,
  extraFieldsPerResource: 64,
  queryParams: 32,
  /** Serialized POST body template size. */
  bodyBytes: 16 * 1024,
  /** Records accepted on one page. */
  recordsPerPage: 10_000,
  /** A synced string value; the same cap as a text row of the detail card. */
  stringValue: INTEGRATION_SECTION_LIMITS.textLength,
  /** Test: records returned. */
  testRecords: 5,
  /** Test: organizations returned. */
  testOrganizations: 50,
  /** Test: key list entries. */
  testKeys: 200,
  /** Test: characters of a sample value. */
  testSampleLength: 80,
  /** OAuth token endpoint response size. */
  tokenResponseBytes: 64 * 1024,
} as const;

export const CUSTOM_API_RESOURCE_KEYS = ['devices', 'other_assets'] as const;
export type CustomApiResourceKey = (typeof CUSTOM_API_RESOURCE_KEYS)[number];

/** Standard fields a Devices definition may fill (the STANDARD_FIELDS keys of the Devices pattern). */
export const CUSTOM_API_DEVICE_STANDARD_FIELDS = [
  'hostname',
  'manufacturer',
  'model',
  'operating_system',
  'cpu',
  'ram',
  'storage',
  'mac_address',
  'ip_address',
  'role',
] as const;
export type CustomApiDeviceStandardField = (typeof CUSTOM_API_DEVICE_STANDARD_FIELDS)[number];

export const CUSTOM_API_EXTRA_FIELD_TYPES = [
  'TEXT',
  'NUMBER',
  'BOOLEAN',
  'DATE',
  'DATETIME',
  'URL',
  'EMAIL',
  'IP_ADDRESS',
] as const;
export type CustomApiExtraFieldType = (typeof CUSTOM_API_EXTRA_FIELD_TYPES)[number];

/** Placeholders a request may use. `{updatedSince}` is not in v1: syncs are full. */
export const CUSTOM_API_PLACEHOLDERS = ['orgId', 'cursor', 'page', 'offset', 'limit'] as const;
export type CustomApiPlaceholder = (typeof CUSTOM_API_PLACEHOLDERS)[number];

const PLACEHOLDER_RE = /\{([^{}]*)\}/g;

/** Every `{name}` in a template, in order. */
export function placeholdersIn(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER_RE)].map((match) => match[1]!);
}

/** Header names an operator may not set: the transport owns them, or the auth method does. */
const RESERVED_HEADER_NAMES: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'te',
  'trailer',
  'keep-alive',
  'cookie',
  'authorization',
]);

/** True for a header name the definition may not set (case-insensitive). */
export function isReservedHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return RESERVED_HEADER_NAMES.has(lower) || lower.startsWith('proxy-');
}

/** RFC 9110 token characters. */
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
// eslint-disable-next-line no-control-regex -- matching controls is the point
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const pathSchema = z
  .string()
  .max(256)
  .superRefine((value, ctx) => {
    try {
      parsePath(value);
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: e instanceof CustomApiPathError ? e.message : 'Invalid path.' });
    }
  });
const requiredPathSchema = pathSchema.pipe(z.string().min(1, 'Enter a path.'));

/** HTTPS URL with no credentials, query or fragment; a path prefix is allowed. */
function httpsUrlWithoutExtras(label: string) {
  return z
    .string()
    .min(1)
    .max(2_048)
    .superRefine((value, ctx) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        ctx.addIssue({ code: 'custom', message: `${label} is not a valid URL.` });
        return;
      }
      if (url.protocol !== 'https:') ctx.addIssue({ code: 'custom', message: `${label} must start with https://.` });
      if (!url.hostname) ctx.addIssue({ code: 'custom', message: `${label} has no host.` });
      if (url.username || url.password) ctx.addIssue({ code: 'custom', message: `${label} cannot contain a user name or password.` });
      if (url.search || value.includes('?')) ctx.addIssue({ code: 'custom', message: `${label} cannot contain a query string.` });
      if (url.hash || value.includes('#')) ctx.addIssue({ code: 'custom', message: `${label} cannot contain a fragment.` });
    });
}

const headerSchema = z.union([
  z
    .object({
      name: z.string().regex(HEADER_NAME_RE, 'A header name has letters, digits and - only.'),
      value: z
        .string()
        .max(1_024)
        .refine((value) => !CONTROL_RE.test(value), 'A header value cannot contain control characters.'),
    })
    .strict(),
  z
    .object({
      name: z.string().regex(HEADER_NAME_RE, 'A header name has letters, digits and - only.'),
      secret: z.literal(true),
    })
    .strict(),
]);
export type CustomApiHeader = z.infer<typeof headerSchema>;

const authSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('none') }).strict(),
  z.object({ method: z.literal('bearer') }).strict(),
  z
    .object({
      method: z.literal('header'),
      headerName: z.string().regex(HEADER_NAME_RE, 'A header name has letters, digits and - only.'),
    })
    .strict(),
  z
    .object({
      method: z.literal('basic'),
      username: z
        .string()
        .min(1)
        .max(256)
        .refine((value) => !value.includes(':') && !CONTROL_RE.test(value), 'A user name cannot contain ":" or control characters.'),
    })
    .strict(),
  z
    .object({
      method: z.literal('oauth_client_credentials'),
      tokenUrl: httpsUrlWithoutExtras('Token URL'),
      scope: z
        .string()
        .max(1_024)
        .refine((value) => !CONTROL_RE.test(value), 'A scope cannot contain control characters.')
        .optional(),
      clientAuth: z.enum(['body', 'basic']).default('body'),
    })
    .strict(),
]);
export type CustomApiAuth = z.infer<typeof authSchema>;
export type CustomApiAuthMethod = CustomApiAuth['method'];

const templateString = (max: number) =>
  z.string().max(max).refine((value) => !CONTROL_RE.test(value), 'Control characters are not allowed.');

const requestSchema = z
  .object({
    method: z.enum(['GET', 'POST']).default('GET'),
    path: templateString(1_024)
      .pipe(z.string().min(1).startsWith('/', 'A request path starts with /.'))
      .refine((value) => !value.includes('?') && !value.includes('#'), 'Put query parameters in Query, not in the path.')
      .refine((value) => !value.includes('\\'), 'A request path cannot contain \\.'),
    query: z
      .record(
        z.string().min(1).max(128).refine((key) => !CONTROL_RE.test(key) && placeholdersIn(key).length === 0, 'A query name cannot hold a placeholder.'),
        templateString(1_024),
      )
      .refine((query) => Object.keys(query).length <= CUSTOM_API_LIMITS.queryParams, `At most ${CUSTOM_API_LIMITS.queryParams} query parameters.`)
      .default({}),
    /** POST only: a fixed JSON body. Placeholders are allowed in its string values. */
    body: z.unknown().optional(),
  })
  .strict();
export type CustomApiRequest = z.infer<typeof requestSchema>;

const pageSizeSchema = z.number().int().min(1).max(CUSTOM_API_LIMITS.recordsPerPage);

const paginationSchema = z.discriminatedUnion('style', [
  z.object({ style: z.literal('none') }).strict(),
  z
    .object({
      style: z.literal('page'),
      firstPage: z.number().int().min(0).max(1).default(1),
      pageSize: pageSizeSchema,
      totalPath: pathSchema.optional(),
    })
    .strict(),
  z
    .object({
      style: z.literal('offset'),
      pageSize: pageSizeSchema,
      totalPath: pathSchema.optional(),
    })
    .strict(),
  z
    .object({
      style: z.literal('cursor'),
      cursorPath: requiredPathSchema,
      pageSize: pageSizeSchema.optional(),
    })
    .strict(),
  z.object({ style: z.literal('next_url'), nextUrlPath: requiredPathSchema }).strict(),
  z.object({ style: z.literal('link_header') }).strict(),
]);
export type CustomApiPagination = z.infer<typeof paginationSchema>;
export type CustomApiPaginationStyle = CustomApiPagination['style'];

const organizationsSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('endpoint'),
      request: requestSchema,
      recordsPath: pathSchema.default(''),
      idPath: requiredPathSchema,
      namePath: requiredPathSchema,
      pagination: paginationSchema.default({ style: 'none' }),
    })
    .strict(),
  z.object({ mode: z.literal('field') }).strict(),
  z.object({ mode: z.literal('single') }).strict(),
]);
export type CustomApiOrganizations = z.infer<typeof organizationsSchema>;
export type CustomApiOrganizationMode = CustomApiOrganizations['mode'];

const FIELD_KEY_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
/** Source field keys the driver itself writes; an extra field may not reuse them. */
const RESERVED_FIELD_KEYS: ReadonlySet<string> = new Set([
  'name',
  'match_key',
  'serial_number',
  ...CUSTOM_API_DEVICE_STANDARD_FIELDS,
]);

const extraFieldSchema = z
  .object({
    key: z
      .string()
      .max(60)
      .regex(FIELD_KEY_RE, 'A key has lower-case letters, digits and single underscores, for example agent_version.')
      .refine((key) => !RESERVED_FIELD_KEYS.has(key), 'This key is used by Weavestream. Pick another key.'),
    label: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine((value) => !CONTROL_RE.test(value) && !/<[a-z!/?]/i.test(value), 'A label is plain text.'),
    path: requiredPathSchema,
    type: z.enum(CUSTOM_API_EXTRA_FIELD_TYPES),
  })
  .strict();
export type CustomApiExtraField = z.infer<typeof extraFieldSchema>;

/** Optional record link: HTTPS, `{id}` is the only placeholder. */
const recordUrlSchema = z
  .string()
  .max(2_048)
  .superRefine((value, ctx) => {
    const names = placeholdersIn(value);
    if (!names.includes('id')) ctx.addIssue({ code: 'custom', message: 'An Open in link must contain {id}.' });
    if (names.some((name) => name !== 'id')) ctx.addIssue({ code: 'custom', message: 'An Open in link can use {id} only.' });
    let url: URL;
    try {
      url = new URL(value.replaceAll('{id}', 'id'));
    } catch {
      ctx.addIssue({ code: 'custom', message: 'The Open in link is not a valid URL.' });
      return;
    }
    if (url.protocol !== 'https:') ctx.addIssue({ code: 'custom', message: 'The Open in link must start with https://.' });
    if (url.username || url.password) ctx.addIssue({ code: 'custom', message: 'The Open in link cannot contain a user name or password.' });
    const authority = value.replace(/^https:\/\//i, '').split(/[/?#]/)[0] ?? '';
    if (authority.includes('{')) {
      ctx.addIssue({ code: 'custom', message: '{id} cannot be part of the host of the Open in link.' });
    }
  });

const standardFieldsSchema = z
  .object(Object.fromEntries(CUSTOM_API_DEVICE_STANDARD_FIELDS.map((key) => [key, requiredPathSchema.optional()])) as Record<
    CustomApiDeviceStandardField,
    z.ZodOptional<typeof requiredPathSchema>
  >)
  .strict();

const resourceShape = {
  enabled: z.literal(true),
  request: requestSchema,
  recordsPath: pathSchema.default(''),
  pagination: paginationSchema.default({ style: 'none' }),
  idPath: requiredPathSchema,
  namePath: requiredPathSchema,
  /** The record's own organization id; required in `field` mode, the IDOR backstop in `endpoint` mode. */
  orgIdPath: requiredPathSchema.optional(),
  orgNamePath: requiredPathSchema.optional(),
  extraFields: z.array(extraFieldSchema).max(CUSTOM_API_LIMITS.extraFieldsPerResource).default([]),
  recordUrl: recordUrlSchema.optional(),
} as const;

const disabledResourceSchema = z.object({ enabled: z.literal(false) }).strict();

const devicesSchema = z.discriminatedUnion('enabled', [
  z
    .object({
      ...resourceShape,
      matchPath: requiredPathSchema,
      standardFields: standardFieldsSchema.default({}),
    })
    .strict(),
  disabledResourceSchema,
]);

const otherAssetsSchema = z.discriminatedUnion('enabled', [
  z
    .object({
      ...resourceShape,
      matchPath: requiredPathSchema.optional(),
    })
    .strict(),
  disabledResourceSchema,
]);

export type CustomApiDevicesResource = Extract<z.infer<typeof devicesSchema>, { enabled: true }>;
export type CustomApiOtherAssetsResource = Extract<z.infer<typeof otherAssetsSchema>, { enabled: true }>;
export type CustomApiResource = CustomApiDevicesResource | CustomApiOtherAssetsResource;

/** Placeholders each pagination style feeds. */
function paginationPlaceholders(pagination: CustomApiPagination): Set<string> {
  switch (pagination.style) {
    case 'page':
      return new Set(['page', 'limit']);
    case 'offset':
      return new Set(['offset', 'limit']);
    case 'cursor':
      return new Set(pagination.pageSize ? ['cursor', 'limit'] : ['cursor']);
    default:
      return new Set();
  }
}

/** The placeholder a pagination style must find in the request to move to the next page. */
function requiredPaginationPlaceholder(pagination: CustomApiPagination): string | null {
  switch (pagination.style) {
    case 'page':
      return 'page';
    case 'offset':
      return 'offset';
    case 'cursor':
      return 'cursor';
    default:
      return null;
  }
}

/** Every string inside a JSON value, with a flag for object keys. */
function jsonStrings(value: unknown, out: Array<{ text: string; isKey: boolean }> = [], depth = 0): typeof out {
  if (depth > 16) return out;
  if (typeof value === 'string') out.push({ text: value, isKey: false });
  else if (Array.isArray(value)) for (const item of value) jsonStrings(item, out, depth + 1);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push({ text: key, isKey: true });
      jsonStrings(item, out, depth + 1);
    }
  }
  return out;
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value).every((item) => isJsonValue(item, depth + 1));
  }
  return false;
}

/** Checks one request's placeholders, method and body against what its context allows. */
function checkRequest(
  request: CustomApiRequest,
  allowed: Set<string>,
  pagination: CustomApiPagination,
  path: Array<string | number>,
  ctx: z.RefinementCtx,
): Set<string> {
  const used = new Set<string>();
  const check = (template: string, where: Array<string | number>) => {
    for (const name of placeholdersIn(template)) {
      if (!(CUSTOM_API_PLACEHOLDERS as readonly string[]).includes(name)) {
        ctx.addIssue({ code: 'custom', path: where, message: `{${name}} is not a placeholder. Use ${CUSTOM_API_PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}.` });
      } else if (!allowed.has(name)) {
        ctx.addIssue({ code: 'custom', path: where, message: `{${name}} cannot be used here.` });
      }
      used.add(name);
    }
  };
  check(request.path, [...path, 'path']);
  for (const [key, value] of Object.entries(request.query)) check(value, [...path, 'query', key]);
  if (request.body !== undefined) {
    if (request.method !== 'POST') {
      ctx.addIssue({ code: 'custom', path: [...path, 'body'], message: 'Only a POST request has a body.' });
    } else if (!isJsonValue(request.body)) {
      ctx.addIssue({ code: 'custom', path: [...path, 'body'], message: 'The body must be plain JSON.' });
    } else {
      if (new TextEncoder().encode(JSON.stringify(request.body)).byteLength > CUSTOM_API_LIMITS.bodyBytes) {
        ctx.addIssue({ code: 'custom', path: [...path, 'body'], message: 'The body is larger than 16 KiB.' });
      }
      for (const entry of jsonStrings(request.body)) {
        if (entry.isKey) {
          if (placeholdersIn(entry.text).length > 0) {
            ctx.addIssue({ code: 'custom', path: [...path, 'body'], message: 'Placeholders are allowed in body values only, not in keys.' });
          }
        } else {
          check(entry.text, [...path, 'body']);
        }
      }
    }
  }
  const needed = requiredPaginationPlaceholder(pagination);
  if (needed && !used.has(needed)) {
    ctx.addIssue({ code: 'custom', path: [...path, 'path'], message: `${pagination.style} pagination needs {${needed}} in the request.` });
  }
  return used;
}

export const customApiDefinitionSchema = z
  .object({
    version: z.literal(1),
    baseUrl: httpsUrlWithoutExtras('Base URL'),
    auth: authSchema,
    headers: z.array(headerSchema).max(CUSTOM_API_LIMITS.headers).default([]),
    organizations: organizationsSchema,
    resources: z
      .object({
        devices: devicesSchema.default({ enabled: false }),
        other_assets: otherAssetsSchema.default({ enabled: false }),
      })
      .strict(),
  })
  .strict()
  .superRefine((definition, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(definition)).byteLength > CUSTOM_API_LIMITS.definitionBytes) {
      ctx.addIssue({ code: 'custom', message: 'The definition is larger than 64 KiB.' });
    }

    const authHeader = definition.auth.method === 'header' ? definition.auth.headerName.toLowerCase() : null;
    if (authHeader && isReservedHeaderName(authHeader)) {
      ctx.addIssue({ code: 'custom', path: ['auth', 'headerName'], message: 'This header name cannot be set here.' });
    }
    const seen = new Set<string>();
    definition.headers.forEach((header, index) => {
      const lower = header.name.toLowerCase();
      if (isReservedHeaderName(lower) || lower === authHeader) {
        ctx.addIssue({ code: 'custom', path: ['headers', index, 'name'], message: `"${header.name}" cannot be set here.` });
      }
      if (seen.has(lower)) ctx.addIssue({ code: 'custom', path: ['headers', index, 'name'], message: `"${header.name}" is listed twice.` });
      seen.add(lower);
    });

    const orgs = definition.organizations;
    if (orgs.mode === 'endpoint') {
      checkRequest(orgs.request, paginationPlaceholders(orgs.pagination), orgs.pagination, ['organizations', 'request'], ctx);
    }

    for (const key of CUSTOM_API_RESOURCE_KEYS) {
      const resource = definition.resources[key];
      if (!resource.enabled) continue;
      const allowed = paginationPlaceholders(resource.pagination);
      if (orgs.mode === 'endpoint') allowed.add('orgId');
      const used = checkRequest(resource.request, allowed, resource.pagination, ['resources', key, 'request'], ctx);
      // Endpoint mode runs this request once per mapped organization. Without
      // {orgId} in the request or an organization id path to filter on, every
      // organization would get the same records, and one company's inventory
      // would be copied into every mapped company.
      if (orgs.mode === 'endpoint' && !used.has('orgId') && !resource.orgIdPath) {
        ctx.addIssue({
          code: 'custom',
          path: ['resources', key, 'request', 'path'],
          message: 'Each organization needs its own records. Put {orgId} in the request, or set the organization id path.',
        });
      }
      if (orgs.mode === 'field' && !resource.orgIdPath) {
        ctx.addIssue({ code: 'custom', path: ['resources', key, 'orgIdPath'], message: 'Organization from a field needs the organization id path on every resource.' });
      }
      const keys = new Set<string>();
      resource.extraFields.forEach((field, index) => {
        if (keys.has(field.key)) ctx.addIssue({ code: 'custom', path: ['resources', key, 'extraFields', index, 'key'], message: `"${field.key}" is listed twice.` });
        keys.add(field.key);
      });
    }
  });

export type CustomApiDefinitionInput = z.input<typeof customApiDefinitionSchema>;
export type CustomApiDefinition = z.output<typeof customApiDefinitionSchema>;

/** The secret-bundle key of a secret header. */
export function customApiHeaderSecretKey(name: string): string {
  return `header:${name.toLowerCase()}`;
}

/** Secret keys an auth method needs. */
export const CUSTOM_API_AUTH_SECRET_KEYS: Readonly<Record<CustomApiAuthMethod, readonly string[]>> = {
  none: [],
  bearer: ['token'],
  header: ['value'],
  basic: ['password'],
  oauth_client_credentials: ['clientId', 'clientSecret'],
};

/**
 * Exactly the keys the secret bundle of this definition holds: the auth
 * method's keys, then `header:<lowercase name>` for each secret header.
 * Empty means the definition needs no secret.
 */
export function customApiRequiredSecretKeys(definition: Pick<CustomApiDefinition, 'auth' | 'headers'>): string[] {
  const keys = [...CUSTOM_API_AUTH_SECRET_KEYS[definition.auth.method]];
  for (const header of definition.headers) {
    if ('secret' in header) keys.push(customApiHeaderSecretKey(header.name));
  }
  return keys;
}

export const CUSTOM_API_TEST_SECTIONS = ['organizations', ...CUSTOM_API_RESOURCE_KEYS] as const;
export type CustomApiTestSection = (typeof CUSTOM_API_TEST_SECTIONS)[number];

/** Write-only secret values in a Test request. Never echoed back. */
const testSecretSchema = z
  .record(z.string().min(1).max(128), z.string().min(1).max(8_192))
  .refine((value) => Object.keys(value).length <= CUSTOM_API_LIMITS.headers + 2, 'Too many secret values.');

export const customApiTestRequestSchema = z
  .object({
    definition: customApiDefinitionSchema,
    section: z.enum(CUSTOM_API_TEST_SECTIONS),
    /** External organization id for a resource Test in `endpoint` mode. */
    orgId: z.string().trim().min(1).max(256).optional(),
    /** The full secret bundle for the draft. Required when there is no saved one, or a secret-bound URL changed. */
    secret: testSecretSchema.optional(),
  })
  .strict();
export type CustomApiTestRequest = z.infer<typeof customApiTestRequestSchema>;

export interface CustomApiTestField {
  key: string;
  label: string;
  path: string;
  /** A sample of the value (at most 80 characters), `••••` when masked, null when missing. */
  value: string | null;
  masked: boolean;
  /** `missing` (no value), `not_scalar` (an object or a list), or null. */
  warning: 'missing' | 'not_scalar' | null;
}

export interface CustomApiTestRecord {
  id: string | null;
  name: string | null;
  match: string | null;
  fields: CustomApiTestField[];
}

export interface CustomApiTestKey {
  path: string;
  type: 'string' | 'number' | 'boolean' | 'null';
  sample: string | null;
  masked: boolean;
}

export type CustomApiTestResponse =
  | {
      ok: true;
      section: CustomApiTestSection;
      recordCount: number;
      hasMore: boolean;
      records: CustomApiTestRecord[];
      keys: CustomApiTestKey[];
      correlationId: string;
    }
  | {
      ok: false;
      section: CustomApiTestSection;
      /** Fixed text; never upstream body text. */
      message: string;
      status: number | null;
      correlationId: string;
    };
