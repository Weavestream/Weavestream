import type { DriverOAuthDescriptor } from '@weavestream/shared';
import { DriverAuthError, DriverRateLimitError, type IntegrationContext } from '../integration-driver.js';
import { fetchWithRetry, parseRetryAfter } from '../driver-utils.js';
import { oauthFetch } from '../../oauth/oauth-token.js';
import { parseCsv } from './microsoft-365.csv.js';

/**
 * Microsoft Graph plumbing for the Microsoft 365 driver. Every request goes
 * through `oauthFetch` (egress guard, app-only token per tenant). Reads are
 * GETs; the only POST is `$batch` and its sub-requests are fixed to GET. The
 * single write Weavestream ever makes (the report concealment setting) lives
 * in `microsoft-365.report-settings.ts`, which the sync never imports.
 * Graph error text is never echoed: errors carry the status and our own
 * fixed message.
 */

export const GRAPH = 'https://graph.microsoft.com/v1.0';

/** Application permissions, grouped by why Weavestream needs them. */
export const MICROSOFT_PERMISSION_GROUPS: ReadonlyArray<{ label: string; scopes: string[] }> = [
  {
    label: 'Directory, licences and domains',
    scopes: [
      'User.Read.All',
      'GroupMember.Read.All',
      'Organization.Read.All',
      'LicenseAssignment.Read.All',
      'Domain.Read.All',
      'RoleManagement.Read.Directory',
      'MailboxSettings.Read',
    ],
  },
  { label: 'Sign-ins, MFA and usage reports', scopes: ['AuditLog.Read.All', 'Reports.Read.All'] },
  { label: 'Security', scopes: ['SecurityEvents.Read.All', 'SecurityAlert.Read.All'] },
  { label: 'Intune devices', scopes: ['DeviceManagementManagedDevices.Read.All'] },
  { label: 'Optional: read the report names setting', scopes: ['ReportSettings.Read.All'] },
  {
    label: 'Optional: let Weavestream turn report name concealment off/on for a customer',
    scopes: ['ReportSettings.ReadWrite.All'],
  },
];

/** Reads `GET /admin/reportSettings` (ReportSettings.ReadWrite.All also can). */
export const REPORT_SETTINGS_READ = 'ReportSettings.Read.All';
/** The only write permission; lets the admin action PATCH `displayConcealedNames`. */
export const REPORT_SETTINGS_WRITE = 'ReportSettings.ReadWrite.All';

/** Not needed for a sync; a tenant that did not grant them still passes Check setup. */
export const MICROSOFT_OPTIONAL_PERMISSIONS: readonly string[] = [REPORT_SETTINGS_READ, REPORT_SETTINGS_WRITE];

/** Everything a tenant may grant: a role outside this list is refused as excess. */
export const MICROSOFT_PERMISSIONS = MICROSOFT_PERMISSION_GROUPS.flatMap((g) => g.scopes);

export const MICROSOFT_REQUIRED_PERMISSIONS = MICROSOFT_PERMISSIONS.filter((p) => !MICROSOFT_OPTIONAL_PERMISSIONS.includes(p));

/** Reads Intune managed devices (the Computers and Mobile devices resources). */
export const INTUNE_PERMISSION = 'DeviceManagementManagedDevices.Read.All';

/**
 * Why Intune devices cannot be read, for the identified signals only; null
 * means an unidentified failure that must fail the run (or, in Check setup,
 * get a neutral note):
 * - HTTP 400 `BadRequest` "Request not applicable to target tenant.": the
 *   tenant has no active Intune licence
 *   (learn.microsoft.com/en-us/answers/questions/1063413).
 * - HTTP 401 `UnknownError` while the permission IS granted: also no Intune
 *   licence (what Graph answers managedDevices on such a tenant, seen live).
 *   Any other 401 with the permission granted is a token or consent problem
 *   and is not identified.
 * - HTTP 403 while the app is not known to hold the permission, or HTTP 401
 *   while the granted roles are known to lack it.
 */
export function intuneUnavailableMessage(error: unknown, roles: readonly string[] | null): string | null {
  const unlicensed = 'Intune is not licensed in this tenant, so computers and mobile devices are skipped.';
  if (error instanceof GraphRequestError && error.notApplicableToTenant) return unlicensed;
  if (!(error instanceof GraphAccessError)) return null;
  if (roles?.includes(INTUNE_PERMISSION)) {
    return error.status === 401 && error.graphCode === 'UnknownError' ? unlicensed : null;
  }
  if (roles && (error.status === 401 || error.status === 403)) {
    return `${INTUNE_PERMISSION} is not granted in this tenant, so computers and mobile devices are skipped. Add it on the app, then a Global Administrator presses Reconnect.`;
  }
  if (error.status !== 403) return null;
  return `Intune devices are not available (needs Microsoft Intune and ${INTUNE_PERMISSION}), so computers and mobile devices are skipped.`;
}

/** True when the granted roles can read the report concealment setting. */
export function canReadReportSettings(roles: readonly string[]): boolean {
  return roles.includes(REPORT_SETTINGS_READ) || roles.includes(REPORT_SETTINGS_WRITE);
}

/**
 * Hosts a usage-report 302 may point at (Microsoft's report download
 * service, e.g. reportsncu.office.com). Anything else is refused.
 */
const REPORT_DOWNLOAD_HOST_SUFFIXES = ['.office.com', '.office.net', '.microsoft.com'];

export function isReportDownloadHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return REPORT_DOWNLOAD_HOST_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

export const MICROSOFT_365_OAUTH: DriverOAuthDescriptor = {
  provider: 'microsoft',
  consentFlow: 'admin_consent',
  authorizeUrl: 'https://login.microsoftonline.com/organizations/v2.0/adminconsent',
  tokenUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
  clientCredentialsScope: 'https://graph.microsoft.com/.default',
  scopes: MICROSOFT_PERMISSIONS,
  scopeGroups: MICROSOFT_PERMISSION_GROUPS.map((g) => ({ label: g.label, scopes: [...g.scopes] })),
};

/** A Graph 401/403: a permission not granted, or a licence (P1, Intune, Defender) the tenant lacks. */
export class GraphAccessError extends DriverAuthError {
  constructor(message: string, readonly graphCode: string | null = null, readonly status: number | null = null) {
    super(message);
    this.name = 'GraphAccessError';
  }
}

/** Any other non-OK Graph response; carries the status and Graph's error code only. */
export class GraphRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    /** Graph's 400 "Request not applicable to target tenant." (no licence for the API). */
    readonly notApplicableToTenant = false,
  ) {
    super(message);
    this.name = 'GraphRequestError';
  }
}

/**
 * Graph's `error.code` (an identifier), else null, and whether the error is
 * the fixed "Request not applicable to target tenant." The message is only
 * compared, never kept.
 */
export async function graphError(res: Response): Promise<{ code: string | null; notApplicableToTenant: boolean }> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: unknown; message?: unknown } } | null;
  const raw = body?.error?.code;
  const code = typeof raw === 'string' && /^[A-Za-z0-9_.]{1,80}$/.test(raw) ? raw : null;
  const message = body?.error?.message;
  const notApplicableToTenant =
    res.status === 400 &&
    code === 'BadRequest' &&
    typeof message === 'string' &&
    /^request not applicable to target tenant\.?$/i.test(message.trim());
  return { code, notApplicableToTenant };
}

/** Graph's `error.code` (an identifier, never the message), else null. */
export async function graphErrorCode(res: Response): Promise<string | null> {
  return (await graphError(res)).code;
}

/** Only Graph v1.0 URLs are ever requested with the token (including `@odata.nextLink`). */
export function assertGraphUrl(url: string): string {
  if (!url.startsWith(`${GRAPH}/`)) throw new GraphRequestError('Microsoft Graph returned an unexpected link.', 0, null);
  return url;
}

/** Entra ID P1 is missing (sign-in activity, MFA registration). */
export const P1_CODES = new Set(['Authentication_RequestFromNonPremiumTenantOrB2CTenant']);

async function failure(res: Response, what: string): Promise<never> {
  if (res.status === 429) {
    throw new DriverRateLimitError(
      `Microsoft Graph rate limit reached reading ${what}.`,
      parseRetryAfter(res.headers.get('Retry-After'), 30_000),
    );
  }
  const { code, notApplicableToTenant } = await graphError(res);
  if (code && P1_CODES.has(code)) {
    throw new GraphAccessError('Not available (needs Entra ID P1).', code);
  }
  if (res.status === 401 || res.status === 403) {
    throw new GraphAccessError(
      `Microsoft denied access to ${what} (HTTP ${res.status}). Run Check setup to see which permission is missing; a Global Administrator then presses Reconnect.`,
      code,
      res.status,
    );
  }
  throw new GraphRequestError(`Microsoft Graph request for ${what} failed (HTTP ${res.status}).`, res.status, code, notApplicableToTenant);
}

function send(ctx: IntegrationContext, url: string, headers: Record<string, string> = {}, redirect: 'error' | 'manual' = 'error') {
  return oauthFetch(ctx, MICROSOFT_365_OAUTH, assertGraphUrl(url), {
    method: 'GET',
    headers: { Accept: 'application/json', ...headers },
    redirect,
    serviceName: 'Microsoft 365',
  });
}

export async function graphGet<T>(ctx: IntegrationContext, url: string, what: string, headers?: Record<string, string>): Promise<T> {
  const res = await send(ctx, url, headers);
  if (!res.ok) return failure(res, what);
  return (await res.json()) as T;
}

/** A `$count` request (advanced query: needs `ConsistencyLevel: eventual`). */
export async function graphCount(ctx: IntegrationContext, url: string, what: string): Promise<number> {
  const res = await send(ctx, url, { ConsistencyLevel: 'eventual', Accept: 'text/plain' });
  if (!res.ok) return failure(res, what);
  const n = Number((await res.text()).trim());
  if (!Number.isFinite(n) || n < 0) throw new GraphRequestError(`Microsoft Graph returned no count for ${what}.`, res.status, null);
  return n;
}

export interface GraphPage<T> {
  value?: T[];
  '@odata.nextLink'?: string;
}

/** Every page of a listing (follows `@odata.nextLink`), capped at `maxItems`. */
export async function graphListAll<T>(
  ctx: IntegrationContext,
  firstUrl: string,
  what: string,
  maxItems = 50_000,
  headers?: Record<string, string>,
): Promise<T[]> {
  const out: T[] = [];
  let url: string | undefined = firstUrl;
  for (let page = 0; url && page < 1_000; page += 1) {
    const body: GraphPage<T> = await graphGet<GraphPage<T>>(ctx, url, what, headers);
    out.push(...(body.value ?? []));
    if (out.length > maxItems) {
      throw new GraphAccessError(`Not shown: the tenant has more than ${maxItems.toLocaleString('en-US')} entries for ${what}, above what one sync holds.`);
    }
    url = body['@odata.nextLink'];
  }
  return out;
}

/** Max sub-requests in one JSON batch (Graph limit). */
export const BATCH_SIZE = 20;

export interface BatchResult<T> {
  id: string;
  status: number;
  body?: T;
}

/**
 * One `$batch` of up to 20 GET sub-requests (relative Graph URLs). The
 * method is fixed here so a batch can never carry a write. A throttled
 * sub-request raises a rate limit for the whole page.
 */
export async function graphBatchGet<T>(
  ctx: IntegrationContext,
  requests: Array<{ id: string; url: string }>,
  what: string,
): Promise<BatchResult<T>[]> {
  if (requests.length === 0) return [];
  if (requests.length > BATCH_SIZE) throw new Error('A Graph batch holds at most 20 requests.');
  for (const r of requests) {
    if (!r.url.startsWith('/') || r.url.startsWith('//')) throw new Error('Batch URLs are relative Graph paths.');
  }
  const res = await oauthFetch(ctx, MICROSOFT_365_OAUTH, `${GRAPH}/$batch`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: requests.map((r) => ({ id: r.id, method: 'GET', url: r.url })) }),
    redirect: 'error',
    serviceName: 'Microsoft 365',
  });
  if (!res.ok) return failure(res, what);
  const body = (await res.json()) as {
    responses?: Array<{ id?: string; status?: number; body?: T; headers?: Record<string, string> }>;
  };
  const out: BatchResult<T>[] = [];
  for (const r of body.responses ?? []) {
    if (typeof r.id !== 'string' || typeof r.status !== 'number') continue;
    if (r.status === 429) {
      const retry = r.headers?.['Retry-After'] ?? r.headers?.['retry-after'] ?? null;
      throw new DriverRateLimitError(`Microsoft Graph rate limit reached reading ${what}.`, parseRetryAfter(retry, 30_000));
    }
    out.push({ id: r.id, status: r.status, body: r.body });
  }
  return out;
}

/**
 * A usage report as CSV rows. Graph v1.0 answers with a 302 to a short-lived
 * pre-authenticated download URL; it is followed here through the egress
 * guard WITHOUT the bearer token (the token is for Graph only). An inline
 * CSV body is accepted too.
 */
export async function graphReportCsv(
  ctx: IntegrationContext,
  path: string,
  what: string,
): Promise<Array<Record<string, string>>> {
  const res = await send(ctx, `${GRAPH}/reports/${path}`, { Accept: 'text/csv, application/json' }, 'manual');
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    await res.body?.cancel().catch(() => undefined);
    let target: URL;
    try {
      target = new URL(location ?? '');
    } catch {
      throw new GraphRequestError(`Microsoft Graph returned no download link for ${what}.`, res.status, null);
    }
    if (target.protocol !== 'https:' || !isReportDownloadHost(target.hostname) || target.username || target.password) {
      throw new GraphRequestError(`Microsoft Graph returned an unsafe download link for ${what}.`, res.status, null);
    }
    const download = await fetchWithRetry(target.toString(), {
      method: 'GET',
      headers: { Accept: 'text/csv' },
      redirect: 'error',
      timeoutMs: ctx.http.timeoutMs,
      maxRetries: ctx.http.maxRetries,
      backoffMs: ctx.http.backoffMs,
      correlationId: ctx.correlationId,
      serviceName: 'Microsoft 365 reports',
    });
    if (!download.ok) throw new GraphRequestError(`Downloading ${what} failed (HTTP ${download.status}).`, download.status, null);
    return parseCsv(await download.text());
  }
  if (!res.ok) return failure(res, what);
  return parseCsv(await res.text());
}

export interface MicrosoftOrganization {
  id?: string;
  displayName?: string;
  createdDateTime?: string;
  verifiedDomains?: Array<{ name?: string; isDefault?: boolean; isInitial?: boolean }>;
}

export async function getOrganization(ctx: IntegrationContext): Promise<MicrosoftOrganization & { id: string }> {
  const body = await graphGet<GraphPage<MicrosoftOrganization>>(
    ctx,
    `${GRAPH}/organization?$select=id,displayName,createdDateTime,verifiedDomains`,
    'the organization',
  );
  const org = body.value?.[0];
  if (!org?.id) throw new GraphRequestError('Microsoft Graph returned no organization.', 200, null);
  return { ...org, id: org.id };
}

/** Graph GET /admin/reportSettings: true when the tenant conceals names in usage reports. */
export async function readReportConcealment(ctx: IntegrationContext): Promise<boolean> {
  const body = await graphGet<{ displayConcealedNames?: unknown }>(ctx, `${GRAPH}/admin/reportSettings`, 'the report settings');
  if (typeof body.displayConcealedNames !== 'boolean') {
    throw new GraphRequestError('Microsoft Graph returned no report setting.', 200, null);
  }
  return body.displayConcealedNames;
}
