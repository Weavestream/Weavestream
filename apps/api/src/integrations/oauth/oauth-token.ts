import { z } from 'zod';
import { decodeJwt } from 'jose';
import type { DriverOAuthDescriptor } from '@weavestream/shared';
import { DriverAuthError, type IntegrationContext } from '../drivers/integration-driver.js';
import { fetchWithRetry, type FetchWithRetryOpts } from '../drivers/driver-utils.js';

/**
 * Shared OAuth (authorization-code + refresh-token) plumbing for drivers
 * whose descriptor declares `oauth`. The framework stores the refresh
 * token in `IntegrationSecret` (see `IntegrationOAuthService`); drivers
 * only ever ask for a short-lived access token through
 * `getOAuthAccessToken` / `oauthFetch`.
 *
 * Every provider call goes through `fetchWithRetry` (egress guard). No
 * token, code or provider error text is ever logged or put in an error
 * message: errors carry the HTTP status and the OAuth `error` code only.
 */

/** Instance OAuth app credentials, injected into the driver context by the framework. */
export interface OAuthClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Non-secret marker of the stored app row (id + updatedAt); changes on every save. */
  readonly version?: string;
  /** Client secret expiry (YYYY-MM-DD) as entered by the operator, when known. */
  readonly secretExpiresAt?: string | null;
}

/** Decrypted shape of an authorization-code connection's secret (Google). */
export interface StoredOAuthSecret {
  refreshToken: string;
  grantedScopes: string[];
  connectedAs?: string;
  connectedAt: string;
}

const storedOAuthSecretSchema = z.object({
  refreshToken: z.string().min(1),
  grantedScopes: z.array(z.string()),
  connectedAs: z.string().optional(),
  connectedAt: z.string(),
});

export function parseStoredOAuthSecret(secret: unknown): StoredOAuthSecret | null {
  const parsed = storedOAuthSecretSchema.safeParse(secret);
  return parsed.success ? parsed.data : null;
}

/** Entra tenant ids are GUIDs; anything else is never put in a token URL. */
export const TENANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Decrypted shape of an admin-consent connection's secret (Microsoft). No user or refresh token: only the verified tenant, what was
 * granted, and the admin's report-names choice.
 */
export interface StoredAdminConsent {
  tenantId: string;
  tenantName?: string;
  grantedRoles: string[];
  consentedAt: string;
  reportNames?: 'shown' | 'hidden';
}

const storedAdminConsentSchema = z.object({
  tenantId: z.string().regex(TENANT_ID_RE),
  tenantName: z.string().max(256).optional(),
  grantedRoles: z.array(z.string().max(256)).max(100),
  consentedAt: z.string(),
  reportNames: z.enum(['shown', 'hidden']).optional(),
});

export function parseStoredAdminConsent(secret: unknown): StoredAdminConsent | null {
  const parsed = storedAdminConsentSchema.safeParse(secret);
  return parsed.success ? parsed.data : null;
}

export function isAdminConsent(oauth: DriverOAuthDescriptor): boolean {
  return oauth.consentFlow === 'admin_consent';
}

/**
 * The token endpoint of one tenant (admin consent). Throws on anything but a
 * GUID or the literal `organizations` (used only by the client Check setup).
 */
export function tenantTokenUrl(oauth: DriverOAuthDescriptor, tenantId: string): string {
  if (!TENANT_ID_RE.test(tenantId) && tenantId !== 'organizations') throw new Error('Invalid tenant id');
  return oauth.tokenUrl.replace('{tenant}', tenantId.toLowerCase());
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
});
export type OAuthTokenResponse = z.infer<typeof tokenResponseSchema>;

/**
 * A token endpoint refusal. `code` is the OAuth `error` value and
 * `aadsts` the first Entra `error_codes` number (Microsoft only), never the
 * description.
 */
export class OAuthTokenError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly aadsts: number | null = null,
  ) {
    super(`OAuth token request failed (HTTP ${status}${code ? `, ${code}` : ''}${aadsts ? `, AADSTS${aadsts}` : ''})`);
    this.name = 'OAuthTokenError';
  }
}

type HttpDefaults = IntegrationContext['http'];

async function postTokenRequest(
  oauth: DriverOAuthDescriptor,
  params: Record<string, string>,
  http: HttpDefaults,
  correlationId: string,
  tokenUrl: string = oauth.tokenUrl,
): Promise<OAuthTokenResponse> {
  const res = await fetchWithRetry(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(params).toString(),
    redirect: 'error',
    timeoutMs: http.timeoutMs,
    maxRetries: http.maxRetries,
    backoffMs: http.backoffMs,
    correlationId,
    serviceName: `${oauth.provider} OAuth`,
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const code =
      body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error.slice(0, 64)
        : null;
    const first = body && typeof body === 'object' ? (body as { error_codes?: unknown }).error_codes : undefined;
    const aadsts = Array.isArray(first) && Number.isSafeInteger(first[0]) ? (first[0] as number) : null;
    throw new OAuthTokenError(res.status, code, aadsts);
  }
  const parsed = tokenResponseSchema.safeParse(body);
  if (!parsed.success) throw new OAuthTokenError(res.status, 'invalid_response');
  return parsed.data;
}

/**
 * Exchange an authorization code (PKCE) for tokens. No retries: a code is
 * single use, so a retried request after a lost response would only fail
 * with `invalid_grant`.
 */
export function exchangeAuthorizationCode(
  oauth: DriverOAuthDescriptor,
  client: OAuthClientCredentials,
  input: { code: string; codeVerifier: string; redirectUri: string },
  http: HttpDefaults,
  correlationId: string,
): Promise<OAuthTokenResponse> {
  return postTokenRequest(
    oauth,
    {
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    },
    { ...http, maxRetries: 0 },
    correlationId,
  );
}

/**
 * Email of the account that approved the grant, read from the ID token
 * returned by the token endpoint. The token came straight from the
 * provider over TLS, so per OIDC Core 3.1.3.7 its signature need not be
 * re-verified for this display-only value. Returns undefined when absent.
 */
export function connectedAsFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  try {
    const email = decodeJwt(idToken).email;
    return typeof email === 'string' && email.length <= 320 ? email : undefined;
  } catch {
    // A malformed ID token only costs the "connected as" label.
    return undefined;
  }
}

/**
 * Client-credentials token for one tenant (admin consent). Never cached
 * here; `getOAuthAccessToken` caches per integration + credential version.
 */
export function mintClientCredentialsToken(
  oauth: DriverOAuthDescriptor,
  client: OAuthClientCredentials,
  tenantId: string,
  http: HttpDefaults,
  correlationId: string,
): Promise<OAuthTokenResponse> {
  return postTokenRequest(
    oauth,
    {
      grant_type: 'client_credentials',
      client_id: client.clientId,
      client_secret: client.clientSecret,
      scope: oauth.clientCredentialsScope ?? '',
    },
    http,
    correlationId,
    tenantTokenUrl(oauth, tenantId),
  );
}

/**
 * Claims Weavestream reads from a client-credentials access token: the
 * tenant (`tid`), the app (`appid` / `azp`) and the granted application
 * permissions (`roles`). The token came straight from the token endpoint
 * over TLS, so its signature is not re-verified. Null when the token is not
 * a readable JWT (Microsoft may make Graph tokens opaque): callers then
 * fall back to a Graph check of the tenant.
 */
export function appTokenClaims(accessToken: string): { tid: string | null; appId: string | null; roles: string[] } | null {
  try {
    const claims = decodeJwt(accessToken);
    const tid = typeof claims.tid === 'string' ? claims.tid : null;
    const appId = typeof claims.appid === 'string' ? claims.appid : typeof claims.azp === 'string' ? claims.azp : null;
    const roles = Array.isArray(claims.roles) ? claims.roles.filter((r): r is string => typeof r === 'string').slice(0, 100) : [];
    return { tid, appId, roles };
  } catch {
    // Opaque token: the caller verifies the tenant through Graph instead.
    return null;
  }
}

/**
 * Fixed text for a refused client-credentials request, by Entra AADSTS code
 * (learn.microsoft.com/entra/identity-platform/reference-error-codes).
 * Never the provider's description.
 */
export function adminConsentTokenMessage(e: OAuthTokenError): { reconnect: boolean; message: string } {
  switch (e.aadsts) {
    case 7000215:
      return { reconnect: false, message: 'Microsoft rejected the client secret of the Microsoft app (AADSTS7000215). Save the current secret on the integration\'s App tab.' };
    case 7000222:
      return { reconnect: false, message: 'The client secret of the Microsoft app has expired (AADSTS7000222). Create a new secret in Entra and save it on the integration\'s App tab.' };
    case 700016:
    case 65001:
    case 500011:
      return { reconnect: true, message: 'The customer tenant no longer has this app, or its consent was removed. A Global Administrator must press Reconnect and approve again.' };
    case 7000112:
      return { reconnect: true, message: 'The app is disabled in the customer tenant (AADSTS7000112). Enable the enterprise application there, or press Reconnect.' };
    case 90002:
      return { reconnect: true, message: 'Microsoft cannot find the connected tenant (AADSTS90002). It may have been deleted. Press Reconnect.' };
    default:
      if (e.code === 'invalid_client' || e.code === 'unauthorized_client') {
        return { reconnect: false, message: 'Microsoft rejected the app credentials. Check the Microsoft app on the integration\'s App tab.' };
      }
      return { reconnect: false, message: `Microsoft refused the token request (HTTP ${e.status}). Try again later.` };
  }
}

/** AADSTS codes `adminConsentTokenMessage` maps to a fix the operator must make (secret, app, consent, tenant). */
const ADMIN_CONSENT_AUTH_AADSTS = new Set([7000215, 7000222, 700016, 65001, 500011, 7000112, 90002]);

export function isAdminConsentAuthFailure(e: OAuthTokenError): boolean {
  return (
    (e.aadsts !== null && ADMIN_CONSENT_AUTH_AADSTS.has(e.aadsts)) ||
    e.code === 'invalid_client' ||
    e.code === 'unauthorized_client'
  );
}

/** Best-effort revocation; the caller wipes the stored secret regardless. */
export async function revokeOAuthToken(
  oauth: DriverOAuthDescriptor,
  token: string,
  http: HttpDefaults,
  correlationId: string,
): Promise<boolean> {
  if (!oauth.revokeUrl) return false;
  const res = await fetchWithRetry(oauth.revokeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
    redirect: 'error',
    timeoutMs: http.timeoutMs,
    maxRetries: 0,
    backoffMs: http.backoffMs,
    correlationId,
    serviceName: `${oauth.provider} OAuth`,
  });
  return res.ok;
}

// ---------------------------------------------------------------------
// Access-token cache (NinjaOne pattern)
// ---------------------------------------------------------------------

interface CachedAccessToken {
  token: string;
  expiresAt: number;
  /** `IntegrationContext.credentialVersion` it was minted under: a reconnect or app change misses the cache. */
  version: string;
}

/** Refresh this long before the provider's stated expiry. */
const EXPIRY_SKEW_MS = 60_000;
/** Used when the provider omits `expires_in`. */
const DEFAULT_TTL_MS = 10 * 60_000;
const accessTokenCache = new Map<string, CachedAccessToken>();

/**
 * Test-only: drop every cached access token.
 *
 * @internal only `*.spec.ts` should import this.
 */
export function __resetOAuthAccessTokenCacheForTests(): void {
  accessTokenCache.clear();
}

function requireOAuthMaterial(ctx: IntegrationContext): {
  client: OAuthClientCredentials;
  stored: StoredOAuthSecret;
  /** Null when the context lacks an integration id or version marker: no caching then. */
  cache: { key: string; version: string } | null;
} {
  if (!ctx.oauthClient) {
    throw new DriverAuthError(
      'The OAuth app for this integration is not configured. An administrator can set it up on its App tab.',
    );
  }
  const stored = parseStoredOAuthSecret(ctx.secret);
  if (!stored) {
    throw new DriverAuthError('This client tenant is not connected. Reconnect it on the Connections tab.');
  }
  // Keyed by non-secret row markers, never by a hash of the token or client secret.
  return {
    client: ctx.oauthClient,
    stored,
    cache: cacheOf(ctx),
  };
}

/**
 * Return a valid access token for the integration, refreshing it with the
 * stored refresh token when the cached one is missing, stale, or was
 * minted from different credentials. `forceRefresh` skips the cache (used
 * after a 401). A revoked or expired grant (`invalid_grant`) becomes a
 * `DriverAuthError`, which pauses the integration and asks for Reconnect.
 */
export async function getOAuthAccessToken(
  ctx: IntegrationContext,
  oauth: DriverOAuthDescriptor,
  opts: { forceRefresh?: boolean } = {},
): Promise<string> {
  if (isAdminConsent(oauth)) return getAdminConsentAccessToken(ctx, oauth, opts);
  const { client, stored, cache } = requireOAuthMaterial(ctx);
  const cached = cache ? accessTokenCache.get(cache.key) : undefined;
  if (
    !opts.forceRefresh &&
    cache &&
    cached &&
    cached.version === cache.version &&
    cached.expiresAt > Date.now()
  ) {
    return cached.token;
  }
  if (cache) accessTokenCache.delete(cache.key);

  let tokens: OAuthTokenResponse;
  try {
    // shortcut: a rotated refresh_token in this response is ignored (Google
    // does not rotate); persist it here when a rotating provider is added.
    tokens = await postTokenRequest(
      oauth,
      {
        grant_type: 'refresh_token',
        refresh_token: stored.refreshToken,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      },
      ctx.http,
      ctx.correlationId,
    );
  } catch (e) {
    if (e instanceof OAuthTokenError && e.code === 'invalid_grant') {
      throw new DriverAuthError(
        'The OAuth connection was revoked or has expired. Reconnect the integration.',
      );
    }
    if (e instanceof OAuthTokenError && (e.code === 'invalid_client' || e.code === 'unauthorized_client')) {
      throw new DriverAuthError(
        'The provider rejected the OAuth app credentials. Check the OAuth app on the App tab.',
      );
    }
    throw e;
  }

  const ttlMs = tokens.expires_in ? tokens.expires_in * 1_000 : DEFAULT_TTL_MS;
  if (cache) {
    accessTokenCache.set(cache.key, {
      token: tokens.access_token,
      version: cache.version,
      expiresAt: Date.now() + Math.max(ttlMs - EXPIRY_SKEW_MS, 0),
    });
  }
  return tokens.access_token;
}

/**
 * One cache slot per connection (client tenant), so two tenants of one
 * integration never share or evict each other's token. Without a connection
 * id (non-connection drivers) the slot is the integration.
 */
function cacheOf(ctx: IntegrationContext): { key: string; version: string } | null {
  if (!ctx.integrationId || !ctx.credentialVersion) return null;
  const key = ctx.connectionId ? `conn:${ctx.integrationId}:${ctx.connectionId}` : `id:${ctx.integrationId}`;
  return { key, version: ctx.credentialVersion };
}

/** The verified tenant of an admin-consent integration (DriverAuthError when not connected). */
export function requireAdminConsent(ctx: IntegrationContext): StoredAdminConsent {
  const stored = parseStoredAdminConsent(ctx.secret);
  if (!stored) {
    throw new DriverAuthError('This client tenant is not connected. Reconnect it on the Connections tab.');
  }
  return stored;
}

/**
 * Admin consent: an app-only token for the stored tenant, minted with
 * client credentials (no refresh token exists). Cached per connection and
 * credential version, so a reconnect or a new app secret misses the cache.
 */
async function getAdminConsentAccessToken(
  ctx: IntegrationContext,
  oauth: DriverOAuthDescriptor,
  opts: { forceRefresh?: boolean },
): Promise<string> {
  if (!ctx.oauthClient) {
    throw new DriverAuthError(
      'The OAuth app for this integration is not configured. An administrator can set it up on its App tab.',
    );
  }
  const stored = requireAdminConsent(ctx);
  const cache = cacheOf(ctx);
  const cached = cache ? accessTokenCache.get(cache.key) : undefined;
  if (!opts.forceRefresh && cache && cached && cached.version === cache.version && cached.expiresAt > Date.now()) {
    return cached.token;
  }
  if (cache) accessTokenCache.delete(cache.key);
  let tokens: OAuthTokenResponse;
  try {
    tokens = await mintClientCredentialsToken(oauth, ctx.oauthClient, stored.tenantId, ctx.http, ctx.correlationId);
  } catch (e) {
    // Only a known credential or consent failure pauses the integration; anything else is retried.
    if (e instanceof OAuthTokenError && isAdminConsentAuthFailure(e)) {
      throw new DriverAuthError(adminConsentTokenMessage(e).message);
    }
    throw e;
  }
  const ttlMs = tokens.expires_in ? tokens.expires_in * 1_000 : DEFAULT_TTL_MS;
  if (cache) {
    accessTokenCache.set(cache.key, {
      token: tokens.access_token,
      version: cache.version,
      expiresAt: Date.now() + Math.max(ttlMs - EXPIRY_SKEW_MS, 0),
    });
  }
  return tokens.access_token;
}

/**
 * `fetchWithRetry` with a Bearer access token. On a 401 the token is
 * refreshed once and the request retried, so a token revoked or expired
 * early on the provider side recovers without waiting for the cache TTL.
 */
export async function oauthFetch(
  ctx: IntegrationContext,
  oauth: DriverOAuthDescriptor,
  url: string,
  opts: Omit<FetchWithRetryOpts, 'timeoutMs' | 'maxRetries' | 'backoffMs' | 'correlationId'>,
): Promise<Response> {
  const send = async (forceRefresh: boolean) => {
    const token = await getOAuthAccessToken(ctx, oauth, { forceRefresh });
    return fetchWithRetry(url, {
      ...opts,
      headers: { ...opts.headers, Authorization: `Bearer ${token}` },
      timeoutMs: ctx.http.timeoutMs,
      maxRetries: ctx.http.maxRetries,
      backoffMs: ctx.http.backoffMs,
      correlationId: ctx.correlationId,
    });
  };
  const first = await send(false);
  if (first.status !== 401) return first;
  return send(true);
}
