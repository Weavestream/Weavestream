import {
  customApiDefinitionSchema,
  customApiRequiredSecretKeys,
  formatPath,
  parsePath,
  type CustomApiAuth,
  type CustomApiDefinitionInput,
  type CustomApiHeader,
} from '@weavestream/shared';

/**
 * Custom API definition editor helpers. The editor's state is the
 * definition itself (`CustomApiDefinitionInput`); an input the admin has
 * not filled yet holds `''`. `cleanDefinition` drops those blanks before
 * the shared schema validates the draft, so an empty optional path is
 * "not set" rather than an invalid path.
 */

export type CustomApiDraft = CustomApiDefinitionInput;
export type CustomApiDraftAuth = CustomApiDefinitionInput['auth'];

/** Issues by joined path (`resources.devices.idPath`); `''` holds issues for the whole definition. */
export type DraftIssues = Map<string, string>;

/**
 * The definition a new integration starts with when nothing is imported:
 * one organization, Items off. The admin completes it on the
 * Credentials tab.
 */
export function newDefinition(baseUrl: string, auth: CustomApiDraftAuth): CustomApiDraft {
  return {
    version: 1,
    baseUrl,
    auth,
    headers: [],
    organizations: { mode: 'single' },
    resources: { items: { enabled: false } },
  };
}

/** The empty auth object of a method, with every field of that method blank. */
export function emptyAuth(method: CustomApiAuth['method']): CustomApiDraftAuth {
  switch (method) {
    case 'header':
      return { method, headerName: '' };
    case 'basic':
      return { method, username: '' };
    case 'oauth_client_credentials':
      return { method, tokenUrl: '', scope: '', clientAuth: 'body' };
    default:
      return { method };
  }
}

/** The saved config as a draft. Never throws: a stored config is shown as it is. */
export function draftFromConfig(config: Record<string, unknown>): CustomApiDraft {
  return config as unknown as CustomApiDraft;
}

/**
 * A POST body the admin typed that is not valid JSON. It stays in the
 * draft (not the last valid body), so the shared schema refuses the draft
 * ("The body must be plain JSON": a class instance is not plain JSON) and
 * Save, Test and Export stay blocked until the text is fixed.
 */
export class InvalidJsonBody {
  constructor(readonly text: string) {}
}

/**
 * Query parameter rows with 2 or more equal names. An object cannot hold
 * them, so the rows stay in the draft as they are; the shared schema
 * refuses a class instance as the query, and Save, Test and Export stay
 * blocked until a name is changed.
 */
export class DuplicateQueryNames {
  constructor(readonly rows: ReadonlyArray<readonly [string, string]>) {}
}

/**
 * JSON with the keys of every object sorted. PostgreSQL stores the config
 * as JSONB, which changes the key order, so a text compare of the saved
 * config and the draft must not depend on it.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

// Blank strings are meaningful here: a header value, a query value, and
// anything inside a POST body are sent as they are.
const KEEP_BLANKS_UNDER = new Set(['query', 'body']);

/** The draft without blank inputs: what is validated, tested, saved and exported. */
export function cleanDefinition(draft: CustomApiDraft): Record<string, unknown> {
  return clean(draft, null) as Record<string, unknown>;
}

function clean(value: unknown, key: string | null): unknown {
  if (Array.isArray(value)) return value.map((item) => clean(item, null));
  if (!value || typeof value !== 'object') return value;
  if (key !== null && KEEP_BLANKS_UNDER.has(key)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === '' && k !== 'value' && k !== 'recordsPath') continue;
    if (v === undefined) continue;
    out[k] = clean(v, k);
  }
  return out;
}

/** Validates the draft with the shared schema; issues are keyed by their joined path. */
export function issuesOf(draft: CustomApiDraft): DraftIssues {
  const parsed = customApiDefinitionSchema.safeParse(cleanDefinition(draft));
  const issues: DraftIssues = new Map();
  if (parsed.success) return issues;
  for (const issue of parsed.error.issues) {
    const key = issue.path.join('.');
    if (!issues.has(key)) issues.set(key, issue.message);
  }
  return issues;
}

/** Exactly the secret keys this draft needs: the auth method's keys, then `header:<name>` for each secret header. */
export function secretKeysFor(draft: Pick<CustomApiDraft, 'auth' | 'headers'>): string[] {
  const headers = (draft.headers ?? []).filter((header): header is CustomApiHeader => Boolean(header?.name));
  return customApiRequiredSecretKeys({ auth: draft.auth as CustomApiAuth, headers });
}

/** The bundle to send: exactly `keys`, nothing left over from an earlier method. */
export function secretBundle(keys: readonly string[], values: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = values[key];
    if (typeof value === 'string' && value !== '') out[key] = value;
  }
  return out;
}

/** True when every key has a value. */
export function bundleComplete(keys: readonly string[], values: Record<string, unknown>): boolean {
  return keys.every((key) => typeof values[key] === 'string' && values[key] !== '');
}

function originOf(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return new URL(value).origin;
  } catch {
    return 'invalid';
  }
}

/**
 * The Base URL or token URL moved to another host. A UI hint only: the
 * server refuses the save (or a Test with the saved secret) until the
 * credentials are entered again.
 */
export function secretBoundOriginChanged(saved: Record<string, unknown>, draft: CustomApiDraft): boolean {
  const savedAuth = (saved.auth ?? {}) as Record<string, unknown>;
  const draftAuth = draft.auth as Record<string, unknown>;
  return (
    originOf(saved.baseUrl) !== originOf(draft.baseUrl) ||
    originOf(savedAuth.tokenUrl) !== originOf(draftAuth.tokenUrl)
  );
}

/** The path in its canonical form, for matching a typed path to a key-list path. */
export function canonicalPath(path: string): string | null {
  try {
    return formatPath(parsePath(path));
  } catch {
    return null;
  }
}

/** A download name from the integration name; never a path. */
export function exportFileName(name: string): string {
  const safe = name
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} ._-]+/gu, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${safe.length > 0 && !/^\.+$/.test(safe) ? safe : 'definition'}.custom-api.json`;
}

type EndpointOrganizations = Extract<CustomApiDraft['organizations'], { mode: 'endpoint' }>;
export type DraftRequest = EndpointOrganizations['request'];
export type DraftPagination = NonNullable<EndpointOrganizations['pagination']>;
export type DraftResource = Extract<NonNullable<CustomApiDraft['resources']['items']>, { enabled: true }>;
export type DraftField = NonNullable<DraftResource['fields']>[number];

export function emptyRequest(): DraftRequest {
  return { method: 'GET', path: '', query: {} };
}

export function emptyPagination(style: DraftPagination['style']): DraftPagination {
  switch (style) {
    case 'page':
      return { style, firstPage: 1, pageSize: 100, totalPath: '' };
    case 'offset':
      return { style, pageSize: 100, totalPath: '' };
    case 'cursor':
      return { style, cursorPath: '' };
    case 'next_url':
      return { style, nextUrlPath: '' };
    default:
      return { style };
  }
}

export function emptyOrganizations(mode: CustomApiDraft['organizations']['mode']): CustomApiDraft['organizations'] {
  return mode === 'endpoint'
    ? { mode, request: emptyRequest(), recordsPath: '', idPath: '', namePath: '', pagination: { style: 'none' } }
    : { mode };
}

export function emptyResource(): DraftResource {
  return {
    enabled: true,
    request: emptyRequest(),
    recordsPath: '',
    pagination: { style: 'none' },
    idPath: '',
    namePath: '',
    matchPath: '',
    orgIdPath: '',
    orgNamePath: '',
    fields: [],
    recordUrl: '',
  };
}

export interface CustomApiSavePlan {
  issues: DraftIssues;
  /** The secret keys the draft needs. */
  keys: string[];
  configChanged: boolean;
  /** Show the secret inputs: the admin chose to rotate, or the change needs new credentials. */
  entering: boolean;
  /** Why the change needs the credentials entered again; null when it does not. */
  secretReason: string | null;
  /** The secret part of the PATCH body. */
  secretPatch: { secret?: Record<string, string>; clearSecret?: true };
  /** Why Save is refused now; null when it may go. */
  blocked: string | null;
}

/**
 * What a Credentials-tab save sends for a Custom API draft, and whether
 * it may go. The server applies the same rules (a full bundle with
 * exactly the needed keys; new credentials when a secret-bound host
 * changes); this keeps the admin from a save that would be refused.
 */
export function customApiSavePlan(input: {
  saved: Record<string, unknown>;
  hasSecret: boolean;
  draft: CustomApiDraft;
  values: Record<string, unknown>;
  rotate: boolean;
}): CustomApiSavePlan {
  const { saved, hasSecret, draft, values, rotate } = input;
  const issues = issuesOf(draft);
  const keys = secretKeysFor(draft);
  const configChanged = stableJson(cleanDefinition(draft)) !== stableJson(saved);
  let savedKeys: string[] = [];
  try {
    savedKeys = secretKeysFor(draftFromConfig(saved));
  } catch {
    // A saved config this UI cannot read: treat it as having no keys.
  }
  const keysChanged = [...keys].sort().join('\n') !== [...savedKeys].sort().join('\n');

  let secretReason: string | null = null;
  if (keys.length > 0 && configChanged) {
    if (!hasSecret) secretReason = 'Enter the credentials for this API.';
    else if (keysChanged) secretReason = 'The authentication changed. Enter the new credentials.';
    else if (secretBoundOriginChanged(saved, draft)) secretReason = 'The host changed. Enter the credentials again for the new host.';
  }
  const entering = keys.length > 0 && (rotate || secretReason !== null);
  const complete = bundleComplete(keys, values);
  const anyTyped = keys.some((key) => typeof values[key] === 'string' && values[key] !== '');

  const secretPatch: CustomApiSavePlan['secretPatch'] =
    keys.length === 0
      ? hasSecret ? { clearSecret: true } : {}
      : entering && complete ? { secret: secretBundle(keys, values) } : {};

  let blocked: string | null = null;
  if (configChanged && issues.size > 0) {
    blocked = `Fix ${issues.size === 1 ? 'the problem' : `${issues.size} problems`} in the API definition.`;
  } else if (secretReason && !complete) {
    blocked = secretReason;
  } else if (entering && anyTyped && !complete) {
    blocked = 'Enter every credential, or cancel the rotation.';
  }
  return { issues, keys, configChanged, entering, secretReason, secretPatch, blocked };
}

/** The definition or the credentials in the form differ from what is saved. */
export function planHasChanges(plan: CustomApiSavePlan): boolean {
  return plan.configChanged || Object.keys(plan.secretPatch).length > 0;
}

/** The create request's config and secret: the whole definition, and exactly the keys it needs. */
export function customApiCreatePayload(
  draft: CustomApiDraft,
  values: Record<string, unknown>,
): { config: Record<string, unknown>; secret?: Record<string, string> } {
  const keys = secretKeysFor(draft);
  return keys.length > 0
    ? { config: cleanDefinition(draft), secret: secretBundle(keys, values) }
    : { config: cleanDefinition(draft) };
}

/** The section a create-dialog Test reads: the organizations, or in single mode Items when it is on. */
export function createTestSection(draft: CustomApiDraft): 'organizations' | 'items' | null {
  if (draft.organizations.mode !== 'single') return 'organizations';
  return draft.resources.items?.enabled ? 'items' : null;
}
