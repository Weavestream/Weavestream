import { Injectable } from '@nestjs/common';
import { createRemoteJWKSet, customFetch, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { verifyIdToken, type VerifiedIdToken } from './id-token.js';
import { SsoConfigService, SSO_CALLBACK_PATH, type SsoResolvedConfig } from './sso-config.service.js';

export { SSO_CALLBACK_PATH };

/** Fetch with the transport the config's source calls for (see `fetcherFor`). */
export type SsoFetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Environment-configured SSO is operator-trusted: the global `fetch`, with
 * redirects refused.
 */
export function fetcherFor(_source: SsoResolvedConfig['source']): SsoFetcher {
  return (url, init) => fetch(url, { ...init, redirect: 'error' });
}

export const HTTP_TIMEOUT_MS = 10_000;
const METADATA_TTL_MS = 60 * 60 * 1000;

/** Failure talking to the identity provider. Carries a fixed reason, no body. */
export class SsoProviderError extends Error {
  constructor(readonly reason: 'discovery_failed' | 'token_exchange_failed') {
    super(reason);
    this.name = 'SsoProviderError';
  }
}

const endpoint = z.string().url();
export const metadataSchema = z.object({
  issuer: z.string().min(1),
  authorization_endpoint: endpoint,
  token_endpoint: endpoint,
  jwks_uri: endpoint,
});
export type OidcMetadata = z.infer<typeof metadataSchema>;

const tokenResponseSchema = z.object({ id_token: z.string().min(1) });

/**
 * Talks to the OIDC identity provider: discovery (cached), the authorization
 * URL, the code exchange and ID-token verification. Configuration comes from
 * `SsoConfigService` (the environment); every endpoint the
 * provider advertises is held to https, and a database-configured issuer is
 * fetched through the SSRF guard (see `fetcherFor`).
 */
@Injectable()
export class SsoOidcService {
  private metadataCache: { key: string; value: OidcMetadata; expiresAt: number } | null = null;
  private metadataInflight: { key: string; promise: Promise<OidcMetadata> } | null = null;
  private jwks: { key: string; getKey: JWTVerifyGetKey } | null = null;

  constructor(private readonly config: SsoConfigService) {}

  async enabled(): Promise<boolean> {
    return (await this.config.get()).enabled;
  }

  /** Configured issuer, exactly as set (matched verbatim against `iss`). */
  async issuer(): Promise<string> {
    return (await this.requireConfigured()).issuer;
  }

  async issuerHost(): Promise<string> {
    try {
      return new URL(await this.issuer()).host;
    } catch {
      return 'invalid';
    }
  }

  /** The URL registered at the identity provider as the redirect URI. */
  redirectUri(): string {
    return this.config.callbackUrl();
  }

  async metadata(): Promise<OidcMetadata> {
    const cfg = await this.requireConfigured();
    // Keyed on source + issuer so a changed setting never serves the old
    // provider's endpoints or keys.
    const key = `${cfg.source}|${cfg.issuer}`;
    const now = Date.now();
    if (this.metadataCache && this.metadataCache.key === key && this.metadataCache.expiresAt > now) {
      return this.metadataCache.value;
    }
    // Concurrent logins share one discovery request.
    if (!this.metadataInflight || this.metadataInflight.key !== key) {
      const promise = this.fetchMetadata(cfg).finally(() => {
        if (this.metadataInflight?.key === key) this.metadataInflight = null;
      });
      this.metadataInflight = { key, promise };
    }
    const value = await this.metadataInflight.promise;
    this.metadataCache = { key, value, expiresAt: Date.now() + METADATA_TTL_MS };
    return value;
  }

  /**
   * Authorization request URL. `reauthenticate` is the step-up variant:
   * `prompt=login` forces a fresh credential entry and `max_age=0` demands a
   * fresh `auth_time`.
   */
  async authorizationUrl(params: {
    state: string;
    nonce: string;
    challenge: string;
    reauthenticate: boolean;
    /** Self-service linking: let the person choose which provider account to bind. */
    selectAccount?: boolean;
  }): Promise<string> {
    const cfg = await this.requireConfigured();
    const meta = await this.metadata();
    const url = new URL(meta.authorization_endpoint);
    const q = url.searchParams;
    q.set('client_id', cfg.clientId);
    q.set('response_type', 'code');
    q.set('redirect_uri', this.redirectUri());
    q.set('scope', cfg.scopes);
    q.set('state', params.state);
    q.set('nonce', params.nonce);
    q.set('code_challenge', params.challenge);
    q.set('code_challenge_method', 'S256');
    q.set('response_mode', 'query');
    if (params.reauthenticate) {
      q.set('prompt', 'login');
      q.set('max_age', '0');
    } else if (params.selectAccount) {
      q.set('prompt', 'select_account');
    }
    return url.toString();
  }

  /** Exchange the authorization code (with the PKCE verifier) for an ID token. */
  async exchangeCode(code: string, verifier: string): Promise<string> {
    const cfg = await this.requireConfigured();
    const meta = await this.metadata();
    let body: unknown;
    try {
      const res = await fetcherFor(cfg.source)(meta.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        // client_secret_post: what Entra accepts for a confidential web client.
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: this.redirectUri(),
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!res.ok) throw new SsoProviderError('token_exchange_failed');
      body = await res.json();
    } catch (err) {
      if (err instanceof SsoProviderError) throw err;
      throw new SsoProviderError('token_exchange_failed');
    }
    const parsed = tokenResponseSchema.safeParse(body);
    if (!parsed.success) throw new SsoProviderError('token_exchange_failed');
    return parsed.data.id_token;
  }

  /** Verify an ID token against the issuer's keys. Throws `IdTokenError`. */
  async verifyIdToken(idToken: string, nonce: string): Promise<VerifiedIdToken> {
    const cfg = await this.requireConfigured();
    const meta = await this.metadata();
    return verifyIdToken(idToken, this.keysFor(cfg, meta.jwks_uri), {
      issuer: cfg.issuer,
      clientId: cfg.clientId,
      nonce,
      allowedTenantId: cfg.allowedTenantId,
    });
  }

  /** One remote JWKS per source + URI: jose caches the keys and honours cooldowns. */
  private keysFor(cfg: ConfiguredOidc, jwksUri: string): JWTVerifyGetKey {
    const key = `${cfg.source}|${jwksUri}`;
    if (!this.jwks || this.jwks.key !== key) {
      const fetcher = fetcherFor(cfg.source);
      this.jwks = {
        key,
        getKey: createRemoteJWKSet(new URL(jwksUri), {
          timeoutDuration: HTTP_TIMEOUT_MS,
          cacheMaxAge: METADATA_TTL_MS,
          // The key set is fetched through the same guard as discovery.
          [customFetch]: (url: string, options: { headers: Headers | Record<string, string>; method: string }) =>
            fetcher(url, {
              method: options.method,
              headers: options.headers as RequestInit['headers'],
            }),
        }),
      };
    }
    return this.jwks.getKey;
  }

  private async fetchMetadata(cfg: ConfiguredOidc): Promise<OidcMetadata> {
    const url = `${cfg.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    try {
      const res = await fetcherFor(cfg.source)(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!res.ok) throw new SsoProviderError('discovery_failed');
      const meta = metadataSchema.parse(await res.json());
      // The document must describe the issuer we asked about (OIDC Discovery
      // 4.3), or a hijacked or mistyped URL could substitute its own keys.
      if (meta.issuer !== cfg.issuer) throw new SsoProviderError('discovery_failed');
      for (const u of [meta.authorization_endpoint, meta.token_endpoint, meta.jwks_uri]) {
        if (!isAllowedEndpoint(u, cfg.issuer)) throw new SsoProviderError('discovery_failed');
      }
      return meta;
    } catch (err) {
      if (err instanceof SsoProviderError) throw err;
      throw new SsoProviderError('discovery_failed');
    }
  }

  private async requireConfigured(): Promise<ConfiguredOidc> {
    const c = await this.config.get();
    if (!c.enabled || !c.issuer || !c.clientId || !c.clientSecret) {
      throw new Error('Single sign-on is not configured');
    }
    return {
      source: c.source,
      issuer: c.issuer,
      clientId: c.clientId,
      clientSecret: c.clientSecret,
      scopes: c.scopes,
      allowedTenantId: c.allowedTenantId,
    };
  }
}

interface ConfiguredOidc {
  source: SsoResolvedConfig['source'];
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  allowedTenantId?: string;
}

/** https only; plain http solely for a loopback issuer in local development. */
export function isAllowedEndpoint(raw: string, issuerUrl: string): boolean {
  const u = new URL(raw);
  if (u.protocol === 'https:') return true;
  const issuer = new URL(issuerUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'];
  return u.protocol === 'http:' && loopback.includes(u.hostname) && loopback.includes(issuer.hostname);
}
