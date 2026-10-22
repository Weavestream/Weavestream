import { generateKeyPairSync, hkdfSync } from 'node:crypto';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { McpClientPolicy } from '@weavestream/shared';
import type { Configuration, KoaContextWithOIDC, Provider } from 'oidc-provider';
import { EnvService } from '../config/env.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { safeFetch } from '../common/egress/safe-fetch.js';
import { McpConnectionsService, type McpRevokeReason } from './mcp-connections.service.js';
import { oauthAdapterFactory } from './oauth-adapter.js';
import {
  areAllowedRedirects,
  connectionAllowed,
  FETCH_HOSTS,
  isAllowedClientId,
  MCP_SCOPE,
  mcpResourceUrl,
  OAUTH_COOKIE_NAMES,
  OAUTH_MOUNT_PATH,
  TTL,
} from './mcp-oauth.constants.js';

/**
 * Discovery fields that only make sense for an OpenID Provider. Weavestream
 * is a plain OAuth authorization server for its MCP endpoint; it never
 * issues ID tokens, so it does not advertise any of this.
 */
const OIDC_ONLY_METADATA = [
  'acr_values_supported',
  'claim_types_supported',
  'claims_parameter_supported',
  'claims_supported',
  'id_token_signing_alg_values_supported',
  'jwks_uri',
  'request_parameter_supported',
  'request_uri_parameter_supported',
  'require_request_uri_registration',
  'subject_types_supported',
  'userinfo_endpoint',
];

/** The authorization endpoint and its resume step (`/auth/<uid>`). */
const AUTHORIZATION_ROUTE = /^\/auth(\/[^/]+)?$/;

/** The provider session cookie and its signature companion. */
const PROVIDER_SESSION_COOKIES: ReadonlySet<string> = new Set([
  OAUTH_COOKIE_NAMES.session,
  `${OAUTH_COOKIE_NAMES.session}.sig`,
  `${OAUTH_COOKIE_NAMES.session}.legacy`,
  `${OAUTH_COOKIE_NAMES.session}.legacy.sig`,
]);

/** A `Cookie` header without the named cookies; undefined when none remain. */
export function withoutCookies(header: string | undefined, names: ReadonlySet<string>): string | undefined {
  if (!header) return header;
  const kept = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !names.has(part.slice(0, part.indexOf('=') === -1 ? part.length : part.indexOf('='))));
  return kept.length ? kept.join('; ') : undefined;
}

/** Upper bound on a fetched client document or JWKS. */
const FETCH_MAX_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 2_500;

/**
 * The OAuth authorization server for remote MCP clients (AI apps such as
 * Claude and ChatGPT), built on `oidc-provider`. Which apps it accepts is the
 * admin's client policy, read on every request (see `mcp-oauth.constants.ts`).
 * It is NOT a second login system: it never sees a
 * password or an MFA code. When it needs a user, it sends the browser to the
 * consent page, which requires a normal Weavestream session (login + MFA)
 * and a step-up to approve.
 *
 * The library is ESM-only and this package emits CommonJS, so it is loaded
 * with a lazy `import()` that `tsc` turns into `require()` (Node ≥ 22.12
 * loads ESM through `require` when the graph has no top-level await; see
 * `uploads.service.ts` for the same pattern).
 */
@Injectable()
export class OAuthProviderService implements OnModuleInit {
  private readonly log = new Logger(OAuthProviderService.name);
  private instance: Provider | null = null;
  private handler: ReturnType<Provider['callback']> | null = null;
  /** The `APP_URL` origin: the issuer and the base of every public URL. */
  readonly issuer: string;
  /** The MCP endpoint's canonical URL: the only resource and token audience. */
  readonly resource: string;

  constructor(
    private readonly env: EnvService,
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly connections: McpConnectionsService,
  ) {
    this.issuer = new URL(env.values.APP_URL).origin;
    this.resource = mcpResourceUrl(this.issuer);
  }

  async onModuleInit(): Promise<void> {
    const lib = await import('oidc-provider');
    this.instance = this.build(lib.Provider, lib.errors);
  }

  get provider(): Provider {
    if (!this.instance) throw new Error('OAuth provider is not initialised yet.');
    return this.instance;
  }

  /** The provider as a Node request handler, built once. */
  get callback(): ReturnType<Provider['callback']> {
    this.handler ??= this.provider.callback();
    return this.handler;
  }

  /**
   * The provider builds URLs and the cookie `Secure` flag from the forwarded
   * host and protocol. The API has never relied on the values web sends, so
   * they are pinned to `APP_URL` before any provider call.
   */
  pinPublicOrigin(headers: Record<string, string | string[] | undefined>): void {
    const url = new URL(this.issuer);
    headers['x-forwarded-host'] = url.host;
    headers['x-forwarded-proto'] = url.protocol.slice(0, -1);
  }

  private build(ProviderClass: typeof Provider, errors: typeof import('oidc-provider').errors): Provider {
    const provider = new ProviderClass(this.issuer, this.configuration(errors));
    // Behind web; the forwarded headers are pinned per request (above).
    provider.proxy = true;

    provider.use(async (ctx, next) => {
      // Explicit, so URL generation never depends on deriving the mount path
      // from `originalUrl` (a rewritten query breaks that derivation).
      ctx.mountPath = OAUTH_MOUNT_PATH;
      // The provider's own browser session is never read. It would remember
      // who last finished an authorization in this browser, and on resume
      // refuse a different approving account with a logout form for routes
      // this server never exposes (two Weavestream users in one browser, or
      // overlapping requests). It decides nothing here — every authorization
      // needs consent from a live Weavestream session — so each one starts
      // and resumes on a fresh, empty provider session instead.
      if (AUTHORIZATION_ROUTE.test(ctx.path)) {
        ctx.req.headers.cookie = withoutCookies(ctx.req.headers.cookie, PROVIDER_SESSION_COOKIES);
      }
      // OIDC is core to the library and cannot be configured away. Dropping
      // `openid` from every authorization request means no ID token can be
      // issued, whatever a client asks for.
      if (ctx.path === '/auth' && typeof ctx.query.scope === 'string') {
        const scope = ctx.query.scope
          .split(' ')
          .filter((s) => s && s !== 'openid')
          .join(' ');
        ctx.query = { ...ctx.query, scope };
      }
      await next();
      const oidcCtx = ctx as unknown as KoaContextWithOIDC;
      if (oidcCtx.oidc?.route === 'discovery' && ctx.body && typeof ctx.body === 'object') {
        const body = { ...(ctx.body as Record<string, unknown>) };
        body.scopes_supported = [MCP_SCOPE];
        for (const key of OIDC_ONLY_METADATA) delete body[key];
        // Registration is always on in the library (the provider is built
        // once); it is served and advertised only while any app may connect.
        if ((await this.settings.mcpClientPolicy()) !== 'any') delete body.registration_endpoint;
        ctx.body = body;
      }
    });

    provider.on('grant.revoked', (ctx: KoaContextWithOIDC | undefined, grantId: string) => {
      const route = ctx?.oidc?.route;
      const reason: McpRevokeReason =
        route === 'token' ? 'token_reuse' : route === 'revocation' ? 'client_revoked' : 'grant_revoked';
      void this.connections.revokeByGrant(grantId, reason).catch((err: unknown) => {
        // The grant and its tokens are already gone, so nothing usable is
        // left; this only records the connection as revoked.
        this.log.error(`Could not mark connection revoked: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    provider.on('server_error', (_ctx: unknown, err: Error) => {
      this.log.error(`OAuth server error: ${err.message}`);
    });

    return provider;
  }

  private configuration(errors: typeof import('oidc-provider').errors): Configuration {
    const resource = this.resource;
    return {
      adapter: oauthAdapterFactory({
        prisma: this.prisma,
        invalidGrant: (description) => new errors.InvalidGrant(description),
        invalidClientAuth: (description) => new errors.InvalidClientAuth(description),
        onReplay: (grantId) => this.connections.revokeByGrant(grantId, 'token_reuse'),
      }),
      // Never the library's public development keys. Nothing is signed with
      // this key (opaque access tokens, no ID tokens); it exists only because
      // client validation requires an ID-token algorithm to be available.
      jwks: { keys: [ephemeralSigningKey()] },
      clientDefaults: {
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        id_token_signed_response_alg: 'ES256',
      },
      enabledJWA: {
        idTokenSigningAlgValues: ['ES256'],
        // ChatGPT signs its client assertions with RS256.
        clientAuthSigningAlgValues: ['RS256', 'PS256', 'ES256'],
      },
      clientAuthMethods: ['none', 'private_key_jwt'],
      responseTypes: ['code'],
      scopes: [MCP_SCOPE],
      pkce: { required: () => true },
      features: {
        devInteractions: { enabled: false },
        // Dynamic client registration of public clients, for apps with no
        // client metadata document (local apps on a loopback redirect). The
        // route is served only in mode `any`, with the switch on, and after
        // `dcr-metadata.ts` checked the request (the controller). No initial
        // access token; no registration access token, because registration
        // management (read, update, delete) stays off.
        registration: { enabled: true, initialAccessToken: false, issueRegistrationAccessToken: false },
        registrationManagement: { enabled: false },
        introspection: { enabled: false },
        userinfo: { enabled: false },
        rpInitiatedLogout: { enabled: false },
        pushedAuthorizationRequests: { enabled: false },
        dPoP: { enabled: false },
        revocation: {
          enabled: true,
          allowedPolicy: async (_ctx, client, token) => token.clientId === client.clientId,
        },
        clientIdMetadataDocument: {
          enabled: true,
          // Experimental in the library; the pinned version implements draft-02.
          ack: 'draft-02',
          allowFetch: async (_ctx, clientId) => isAllowedClientId(clientId, await this.settings.mcpClientPolicy()),
          // Runs on every lookup, including one served from the library's
          // document cache (which skips `allowFetch`), so the client id is
          // checked again here: a document cached in mode `any` is refused
          // once the policy is narrowed.
          allowClient: async (_ctx, client) => {
            const policy = await this.settings.mcpClientPolicy();
            return isAllowedClientId(client.clientId, policy) && areAllowedRedirects(client.redirectUris ?? [], policy);
          },
        },
        resourceIndicators: {
          enabled: true,
          defaultResource: () => resource,
          useGrantedResource: () => true,
          getResourceServerInfo: (_ctx, indicator) => {
            if (indicator !== resource) throw new errors.InvalidTarget();
            return {
              scope: MCP_SCOPE,
              audience: resource,
              accessTokenFormat: 'opaque',
              accessTokenTTL: TTL.accessToken,
            };
          },
        },
      },
      issueRefreshToken: () => true,
      rotateRefreshToken: true,
      // A client revocation of any token ends the grant, so one
      // `grant.revoked` event covers it and the connection never looks live
      // with no tokens.
      revokeGrantPolicy: () => true,
      // The library binds tokens to its 10-minute browser session unless
      // `offline_access` was granted, which it never is here. Revocation is
      // enforced through the connection instead.
      expiresWithSession: () => false,
      // Only the grant this interaction's consent just created — never one
      // remembered on the provider session — so every authorization needs
      // consent.
      loadExistingGrant: async (ctx) => {
        const grantId = ctx.oidc.result?.consent?.grantId;
        return grantId ? ctx.oidc.provider.Grant.find(grantId) : undefined;
      },
      ttl: {
        AccessToken: TTL.accessToken,
        AuthorizationCode: TTL.authorizationCode,
        RefreshToken: TTL.refreshToken,
        Grant: TTL.grant,
        Session: TTL.session,
        Interaction: TTL.interaction,
      },
      interactions: { url: (_ctx, interaction) => `/api/v1/oauth-consent/${interaction.uid}` },
      cookies: {
        names: OAUTH_COOKIE_NAMES,
        keys: [cookieKey(this.env.values.COOKIE_SIGNING_KEY)],
        long: { httpOnly: true, sameSite: 'lax' },
        short: { httpOnly: true, sameSite: 'lax' },
      },
      // Runs on every code and refresh exchange, so revocation, deactivation,
      // an unfinished MFA enrollment, the instance switch and the client
      // policy all stop the next token.
      findAccount: async (_ctx, sub, token) => {
        if (!(await this.settings.mcpRemoteEnabled())) return undefined;
        const user = await this.prisma.user.findUnique({
          where: { id: sub },
          select: { isActive: true, mfaEnforcementCompletedAt: true },
        });
        if (!user?.isActive || user.mfaEnforcementCompletedAt === null) return undefined;
        const grantId = (token as { grantId?: string } | undefined)?.grantId;
        if (grantId) {
          const connection = await this.connections.findActiveByGrant(grantId);
          if (!connection || connection.userId !== sub) return undefined;
          if (!connectionAllowed(await this.settings.mcpClientPolicy(), connection)) return undefined;
        }
        return { accountId: sub, claims: () => ({ sub }) };
      },
      // Errors that cannot be redirected to the client (bad client_id or
      // redirect_uri) go to the browser as JSON: no HTML is built here.
      renderError: (ctx, out) => {
        ctx.type = 'application/json';
        ctx.body = { error: out.error, error_description: out.error_description };
      },
      // Only hosts the client policy allows, through the project's egress guard.
      fetch: async (input, init) => guardedFetch(await this.settings.mcpClientPolicy(), input, init),
    };
  }
}

/**
 * Client documents and their JWKS, through `safeFetch` (SSRF guard, size cap,
 * timeout). `claude_chatgpt`: https on `FETCH_HOSTS` only, no port. `any`: any
 * https URL. The deadline covers the whole body, not only the headers: in
 * mode `any` the host is chosen by whoever starts an authorization.
 */
export async function guardedFetch(
  policy: McpClientPolicy,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const allowed =
    url.protocol === 'https:' && (policy === 'any' || (!url.port && FETCH_HOSTS.has(url.hostname)));
  if (!allowed) {
    throw new Error(`Refusing to fetch ${url.hostname}: not an allowed client host.`);
  }
  // The library passes its own undici `dispatcher`; `safeFetch` brings its
  // own connection guard. The library's `signal` (its own 2.5 s timeout) is
  // kept, next to ours.
  const { dispatcher: _dispatcher, signal, ...rest } = (init ?? {}) as RequestInit & {
    dispatcher?: unknown;
  };
  return safeFetch(url.href, {
    ...rest,
    signal: signal ?? null,
    timeoutMs: FETCH_TIMEOUT_MS,
    timeoutCoversBody: true,
    maxResponseBytes: FETCH_MAX_BYTES,
  });
}

/** A per-process ES256 key that never leaves memory. */
function ephemeralSigningKey() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { ...privateKey.export({ format: 'jwk' }), alg: 'ES256', use: 'sig' };
}

/** Cookie signing key derived from `COOKIE_SIGNING_KEY`, domain-separated. */
function cookieKey(secret: string): string {
  return Buffer.from(
    hkdfSync('sha256', secret, Buffer.alloc(0), 'weavestream:oauth-provider-cookies:v1', 32),
  ).toString('base64url');
}
