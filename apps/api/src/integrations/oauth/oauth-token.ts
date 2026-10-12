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

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
});
export type OAuthTokenResponse = z.infer<typeof tokenResponseSchema>;

/** A token endpoint refusal. `code` is the OAuth `error` value, never its description. */
export class OAuthTokenError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`OAuth token request failed (HTTP ${status}${code ? `, ${code}` : ''})`);
    this.name = 'OAuthTokenError';
  }
}

type HttpDefaults = IntegrationContext['http'];

async function postTokenRequest(
  oauth: DriverOAuthDescriptor,
  params: Record<string, string>,
  http: HttpDefaults,
  correlationId: string,
): Promise<OAuthTokenResponse> {
  const res = await fetchWithRetry(oauth.tokenUrl, {
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
    throw new OAuthTokenError(res.status, code);
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
