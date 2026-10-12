import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  oauthSecretExpiryWarning,
  type DriverOAuthDescriptor,
  type IntegrationConnection,
  type IntegrationConnections,
  type IntegrationOAuthStartResponse,
  type StartIntegrationConnectionInput,
} from '@weavestream/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RedisService } from '../../redis/redis.service.js';
import { EnvService } from '../../config/env.service.js';
import { AuditLogService } from '../../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../../audit/audit-actions.js';
import {
  IntegrationSecretEncryptionService,
  integrationConnectionSecretAad,
} from '../../crypto/integration-secret-encryption.service.js';
import { isUniqueConstraintError } from '../../prisma/prisma-errors.js';
import { IntegrationDriverRegistry } from '../drivers/integration-driver.registry.js';
import type { AuthedUser } from '../../common/current-user.decorator.js';
import type { RequestMeta } from '../../common/request-meta.js';
import { IntegrationOAuthAppService } from './integration-oauth-app.service.js';
import {
  OAuthTokenError,
  TENANT_ID_RE,
  appTokenClaims,
  connectedAsFromIdToken,
  exchangeAuthorizationCode,
  isAdminConsent,
  mintClientCredentialsToken,
  parseStoredAdminConsent,
  parseStoredOAuthSecret,
  revokeOAuthToken,
  type OAuthClientCredentials,
  type StoredAdminConsent,
  type StoredOAuthSecret,
} from './oauth-token.js';

/** Authorization requests expire after ten minutes. */
export const OAUTH_STATE_TTL_SEC = 600;

/**
 * Pending authorization requests live in Redis under a SHA-256 of the
 * state, so lookup is an exact key match (no timing-sensitive compare in
 * process) and a Redis dump never holds a usable state value.
 */
export function oauthStateKey(state: string): string {
  return `integration-oauth:state:${createHash('sha256').update(state).digest('hex')}`;
}

/**
 * A pending authorization request. `connectionId` is the intent: null
 * connects a new client tenant, a connection id reconnects exactly that
 * connection (and only with the same tenant).
 */
const pendingStateSchema = z.union([
  z.object({
    integrationId: z.string().uuid(),
    userId: z.string().min(1),
    connectionId: z.string().uuid().nullable(),
    codeVerifier: z.string().min(43).max(128),
  }),
  z.object({
    integrationId: z.string().uuid(),
    userId: z.string().min(1),
    connectionId: z.string().uuid().nullable(),
    flow: z.literal('admin_consent'),
  }),
]);

export interface OAuthCallbackQuery {
  code?: unknown;
  state?: unknown;
  error?: unknown;
  /** Admin consent (Microsoft): the tenant that consented. Never trusted; verified by token. */
  tenant?: unknown;
  admin_consent?: unknown;
  error_description?: unknown;
}

/**
 * Fixed reason codes the landing URL may carry (`?oauth=failed&reason=`);
 * the web app maps each to fixed text. Provider error text never travels.
 */
export type LandingReason =
  | 'consent_declined'
  | 'admin_required'
  | 'tenant_unverified'
  | 'excess_permissions'
  | 'app_not_configured'
  | 'token_failed'
  | 'already_connected'
  | 'wrong_tenant'
  | 'connection_missing';

/** Provider `error` values recorded in the audit row; anything else is 'other'. */
const KNOWN_PROVIDER_ERRORS = new Set([
  'access_denied',
  'invalid_request',
  'invalid_scope',
  'unauthorized_client',
  'consent_required',
  'interaction_required',
  'server_error',
  'temporarily_unavailable',
]);

/** AADSTS codes meaning "an admin who can grant application permissions must approve". */
const ADMIN_REQUIRED_AADSTS = new Set([90094, 90099, 65001]);

/**
 * Classify an admin-consent error callback into fixed values. The
 * description is only scanned for an AADSTS number; it is never stored,
 * logged or echoed.
 */
export function classifyConsentError(query: OAuthCallbackQuery): {
  providerError: string;
  aadsts: number | null;
  landing: LandingReason;
} {
  const raw = typeof query.error === 'string' ? query.error.slice(0, 64) : '';
  const providerError = KNOWN_PROVIDER_ERRORS.has(raw) ? raw : 'other';
  const desc = typeof query.error_description === 'string' ? query.error_description.slice(0, 2048) : '';
  const match = /AADSTS(\d{5,7})/.exec(desc);
  const aadsts = match ? Number(match[1]) : null;
  const landing: LandingReason =
    aadsts !== null && ADMIN_REQUIRED_AADSTS.has(aadsts) ? 'admin_required' : 'consent_declined';
  return { providerError, aadsts, landing };
}

/** Attempts and spacing while a fresh consent propagates (the service principal can lag). */
export const CONSENT_PROPAGATION_ATTEMPTS = 3;
export const CONSENT_PROPAGATION_DELAY_MS = 2_000;

type FailureReason =
  | 'state_invalid'
  | 'user_mismatch'
  | 'provider_denied'
  | 'not_oauth'
  | 'app_not_configured'
  | 'token_exchange'
  | 'no_refresh_token'
  | 'excess_scopes'
  | 'tenant_invalid'
  | 'tenant_mismatch'
  | 'already_connected'
  | 'reconnect_wrong_tenant'
  | 'connection_missing';

/** Identity scopes and the names Google reports them under; never counted as excess. */
const IDENTITY_SCOPES = new Set([
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
]);

/** Granted scopes outside what the descriptor requested (identity scopes ignored). */
export function excessScopes(granted: readonly string[], requested: readonly string[]): string[] {
  const allowed = new Set(requested);
  return granted.filter((scope) => !allowed.has(scope) && !IDENTITY_SCOPES.has(scope));
}

type Fail = (
  reason: FailureReason,
  provider: string | null,
  extra?: Record<string, unknown>,
  landing?: LandingReason,
) => Promise<string>;

/** The connection a verified grant is about to be stored as. */
interface VerifiedGrant {
  provider: string;
  externalOrgId: string;
  displayName: string | null;
  /** Builds the stored secret; `previous` is the reconnected connection's own secret, if readable. */
  secret: (previous: Record<string, unknown> | null) => StoredOAuthSecret | StoredAdminConsent;
  auditAfter: Record<string, unknown>;
}

/**
 * Connections of OAuth integrations: one per client tenant. Google uses the
 * authorization-code flow (with PKCE S256), Microsoft admin consent.
 *
 * The state is 32 random bytes, single use (Redis GETDEL), valid for ten
 * minutes, and bound to the user who started the flow, the integration and
 * the intent (a new connection, or Reconnect of one connection id). The
 * callback only accepts it from that same signed-in user; a reconnect only
 * stores a grant for the connection's own tenant, and a new connection is
 * refused for a tenant that is already connected. Each grant is stored
 * encrypted on its connection row (AAD bound to connection + integration).
 * Provider error text is never echoed: the browser lands on the
 * integration's Connections tab with `?oauth=connected` or `?oauth=failed`.
 */
@Injectable()
export class IntegrationOAuthService {
  private readonly logger = new Logger(IntegrationOAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly env: EnvService,
    private readonly audit: AuditLogService,
    private readonly crypto: IntegrationSecretEncryptionService,
    private readonly drivers: IntegrationDriverRegistry,
    private readonly apps: IntegrationOAuthAppService,
  ) {}

  async listConnections(integrationId: string): Promise<IntegrationConnections> {
    const { oauth } = await this.requireOAuthIntegration(integrationId);
    const app = await this.prisma.integrationOAuthApp.findUnique({
      where: { integrationId },
      select: { id: true, secretExpiresAt: true },
    });
    const expiry = app?.secretExpiresAt?.toISOString().slice(0, 10) ?? null;
    const rows = await this.prisma.integrationConnection.findMany({
      where: { integrationId },
      orderBy: [{ displayName: 'asc' }, { externalOrgId: 'asc' }],
    });
    const lastSync = await this.lastSyncByTenant(integrationId);
    const consent = isAdminConsent(oauth);
    const connections: IntegrationConnection[] = rows.map((row) => {
      const raw = this.readSecret(integrationId, row.id, row.secretCiphertext);
      const stored = consent ? parseStoredAdminConsent(raw) : null;
      const grant = consent ? null : parseStoredOAuthSecret(raw);
      const readable = consent ? Boolean(stored) : Boolean(grant);
      return {
        id: row.id,
        externalOrgId: row.externalOrgId,
        displayName: row.displayName,
        connectedAs: grant?.connectedAs ?? null,
        connectedAt: row.connectedAt.toISOString(),
        grantedScopes: stored?.grantedRoles ?? grant?.grantedScopes ?? [],
        status: readable && row.status === 'ok' ? 'ok' : 'needs_reconnect',
        lastErrorAt: row.lastErrorAt ? row.lastErrorAt.toISOString() : null,
        lastSyncAt: lastSync.get(row.externalOrgId) ?? null,
        reportNames: stored?.reportNames ?? null,
      };
    });
    return {
      provider: oauth.provider,
      appConfigured: Boolean(app),
      redirectUri: this.apps.redirectUri(),
      appSecretExpiryWarning: oauthSecretExpiryWarning(expiry),
      appSecretExpired: expiry !== null && expiry < new Date().toISOString().slice(0, 10),
      connections,
    };
  }

  async start(
    actor: AuthedUser,
    integrationId: string,
    input: StartIntegrationConnectionInput = {},
  ): Promise<IntegrationOAuthStartResponse> {
    const { oauth } = await this.requireOAuthIntegration(integrationId);
    const connectionId = input.connectionId ?? null;
    if (connectionId) {
      const exists = await this.prisma.integrationConnection.findFirst({
        where: { id: connectionId, integrationId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException('Connection not found.');
    }
    const client = await this.apps.getClient(integrationId);
    if (!client) {
      throw new BadRequestException(
        'The OAuth app of this integration is not configured. Set it up on the App tab first.',
      );
    }
    const state = randomBytes(32).toString('base64url');
    if (isAdminConsent(oauth)) {
      // Admin consent has no code and no PKCE: the state alone binds the
      // round trip to this user, integration and connection intent.
      await this.redis.client.set(
        oauthStateKey(state),
        JSON.stringify({ integrationId, userId: actor.id, connectionId, flow: 'admin_consent' }),
        'EX',
        OAUTH_STATE_TTL_SEC,
      );
      const url = new URL(oauth.authorizeUrl);
      url.searchParams.set('client_id', client.clientId);
      url.searchParams.set('scope', oauth.clientCredentialsScope ?? '');
      url.searchParams.set('redirect_uri', this.apps.redirectUri());
      url.searchParams.set('state', state);
      return { authorizeUrl: url.toString() };
    }
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    await this.redis.client.set(
      oauthStateKey(state),
      JSON.stringify({ integrationId, userId: actor.id, connectionId, codeVerifier }),
      'EX',
      OAUTH_STATE_TTL_SEC,
    );

    const url = new URL(oauth.authorizeUrl);
    for (const [k, v] of Object.entries(oauth.extraAuthorizeParams ?? {})) {
      url.searchParams.set(k, v);
    }
    // Reserved parameters are set last so a descriptor can never override them.
    url.searchParams.set('client_id', client.clientId);
    url.searchParams.set('redirect_uri', this.apps.redirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', oauth.scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { authorizeUrl: url.toString() };
  }

  /**
   * Complete the flow. Never throws: always returns the absolute web URL
   * to redirect the browser to.
   */
  async callback(actor: AuthedUser, query: OAuthCallbackQuery, meta: RequestMeta): Promise<string> {
    const state = typeof query.state === 'string' && query.state.length <= 256 ? query.state : null;
    if (!state) return this.landing(null, false);

    let pending: z.infer<typeof pendingStateSchema> | null = null;
    try {
      const raw = await this.redis.client.getdel(oauthStateKey(state));
      const parsed = raw ? pendingStateSchema.safeParse(JSON.parse(raw)) : null;
      pending = parsed?.success ? parsed.data : null;
    } catch (e) {
      this.logger.error({ err: (e as Error).message }, 'OAuth state lookup failed');
    }
    if (!pending) {
      // Unknown, expired or already used. No integration to attribute it to.
      this.logger.warn({ userId: actor.id }, 'OAuth callback with an invalid or reused state');
      return this.landing(null, false);
    }
    const { integrationId, connectionId } = pending;
    const fail: Fail = async (reason, provider, extra = {}, landingReason) => {
      await this.audit.log({
        actorId: actor.id,
        action: AUDIT_ACTIONS.integration.oauthConnectFailed,
        entityType: 'Integration',
        entityId: integrationId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: { provider, reason, connectionId, ...extra },
      });
      return this.landing(integrationId, false, landingReason);
    };

    if (pending.userId !== actor.id) return fail('user_mismatch', null);
    const verified = 'flow' in pending
      ? await this.adminConsentCallback(integrationId, query, fail)
      : await this.authorizationCodeCallback(integrationId, pending.codeVerifier, query, fail);
    if (typeof verified === 'string') return verified;
    return this.storeConnection(actor, integrationId, connectionId, verified, meta, fail);
  }

  /** Google: exchange the code, then read which customer (tenant) granted it. */
  private async authorizationCodeCallback(
    integrationId: string,
    codeVerifier: string,
    query: OAuthCallbackQuery,
    fail: Fail,
  ): Promise<VerifiedGrant | string> {
    if (query.error !== undefined) return fail('provider_denied', null);
    const code = typeof query.code === 'string' && query.code.length <= 2048 ? query.code : null;
    if (!code) return fail('provider_denied', null);

    let row;
    let oauth: DriverOAuthDescriptor;
    try {
      ({ row, oauth } = await this.requireOAuthIntegration(integrationId));
    } catch {
      // Deleted mid-flow, or its driver no longer uses OAuth.
      return fail('not_oauth', null);
    }
    if (isAdminConsent(oauth)) return fail('state_invalid', oauth.provider);
    const client = await this.clientOrNull(integrationId);
    if (!client) return fail('app_not_configured', oauth.provider, {}, 'app_not_configured');

    const correlationId = randomUUID();
    let tokens;
    try {
      tokens = await exchangeAuthorizationCode(
        oauth,
        client,
        { code, codeVerifier, redirectUri: this.apps.redirectUri() },
        this.httpDefaults(),
        correlationId,
      );
    } catch (e) {
      this.logger.warn(
        { err: (e as Error).message, integrationId, correlationId },
        'OAuth code exchange failed',
      );
      return fail('token_exchange', oauth.provider);
    }
    if (!tokens.refresh_token) return fail('no_refresh_token', oauth.provider);

    const grantedScopes = tokens.scope
      ? tokens.scope.split(/\s+/).filter(Boolean).slice(0, 100)
      : oauth.scopes;
    // A grant wider than requested is never stored. A narrower one connects;
    // Check setup then reports the missing permissions.
    const excess = excessScopes(grantedScopes, oauth.scopes);
    if (excess.length > 0) return fail('excess_scopes', oauth.provider, { excessScopes: excess.slice(0, 20) });
    const secret: StoredOAuthSecret = {
      refreshToken: tokens.refresh_token,
      grantedScopes,
      connectedAt: new Date().toISOString(),
    };
    const connectedAs = connectedAsFromIdToken(tokens.id_token);
    if (connectedAs) secret.connectedAs = connectedAs;

    // Which tenant granted it decides the connection: ask the provider with
    // the fresh grant (no cache: no credential version).
    const driver = this.drivers.kindOf(row.driver) === 'pull' ? this.drivers.get(row.driver) : null;
    let org: { externalId: string; name: string } | undefined;
    try {
      [org] = driver
        ? await driver.listSourceOrgs({
            config: (row.config ?? {}) as Record<string, unknown>,
            secret: secret as unknown as Record<string, unknown>,
            integrationId,
            oauthClient: client,
            http: this.httpDefaults(),
            correlationId,
          })
        : [];
    } catch (e) {
      this.logger.warn({ err: (e as Error).message, integrationId, correlationId }, 'Reading the connected tenant failed');
    }
    if (!org?.externalId || org.externalId.length > 256) {
      return fail('tenant_invalid', oauth.provider, {}, 'tenant_unverified');
    }
    return {
      provider: oauth.provider,
      externalOrgId: org.externalId,
      displayName: org.name ? org.name.slice(0, 256) : null,
      secret: () => secret,
      auditAfter: { provider: oauth.provider, tenantId: org.externalId, grantedScopes },
    };
  }

  /**
   * Admin consent (Microsoft). The callback's `tenant` is only a claim: a
   * client-credentials token is minted for it, the token's `tid` must equal
   * it, and the driver re-reads the tenant through the provider API. The
   * granted application permissions come from the token's `roles`. No user
   * or refresh token is stored.
   */
  private async adminConsentCallback(
    integrationId: string,
    query: OAuthCallbackQuery,
    fail: Fail,
  ): Promise<VerifiedGrant | string> {
    let row;
    let oauth: DriverOAuthDescriptor;
    try {
      ({ row, oauth } = await this.requireOAuthIntegration(integrationId));
    } catch {
      return fail('not_oauth', null);
    }
    if (!isAdminConsent(oauth)) return fail('not_oauth', oauth.provider);
    if (query.error !== undefined) {
      const { providerError, aadsts, landing } = classifyConsentError(query);
      return fail('provider_denied', oauth.provider, { providerError, aadsts }, landing);
    }
    const tenantId =
      typeof query.tenant === 'string' && TENANT_ID_RE.test(query.tenant) ? query.tenant.toLowerCase() : null;
    if (!tenantId || String(query.admin_consent).toLowerCase() !== 'true') {
      return fail('tenant_invalid', oauth.provider, {}, 'tenant_unverified');
    }
    const client = await this.clientOrNull(integrationId);
    if (!client) return fail('app_not_configured', oauth.provider, {}, 'app_not_configured');

    const correlationId = randomUUID();
    const driver = this.drivers.kindOf(row.driver) === 'pull' ? this.drivers.get(row.driver) : null;
    let accessToken: string | null = null;
    let roles: string[] = [];
    let tokenTid: string | null = null;
    let lastAadsts: number | null = null;
    // A fresh consent can take a few seconds to reach the token service:
    // retry an unknown-app answer or an empty role list a couple of times.
    for (let attempt = 1; attempt <= CONSENT_PROPAGATION_ATTEMPTS; attempt += 1) {
      try {
        const tokens = await mintClientCredentialsToken(oauth, client, tenantId, this.httpDefaults(), correlationId);
        const claims = appTokenClaims(tokens.access_token);
        accessToken = tokens.access_token;
        roles = claims?.roles ?? [];
        tokenTid = claims?.tid?.toLowerCase() ?? null;
        if (claims?.appId && claims.appId.toLowerCase() !== client.clientId.toLowerCase()) {
          return fail('tenant_mismatch', oauth.provider, { tenantId, check: 'app_id' }, 'tenant_unverified');
        }
        if (roles.length > 0 || !claims || attempt === CONSENT_PROPAGATION_ATTEMPTS) break;
      } catch (e) {
        lastAadsts = e instanceof OAuthTokenError ? e.aadsts : null;
        this.logger.warn(
          { err: (e as Error).message, integrationId, correlationId, attempt },
          'Admin consent token request failed',
        );
        const propagating = lastAadsts === 700016 || lastAadsts === 65001;
        if (!propagating || attempt === CONSENT_PROPAGATION_ATTEMPTS) break;
      }
      await this.sleep(CONSENT_PROPAGATION_DELAY_MS);
    }
    if (!accessToken) {
      return fail('token_exchange', oauth.provider, { tenantId, aadsts: lastAadsts }, 'token_failed');
    }
    if (tokenTid !== null && tokenTid !== tenantId) {
      return fail('tenant_mismatch', oauth.provider, { tenantId, check: 'tid' }, 'tenant_unverified');
    }
    let tenantName: string | null = null;
    if (driver?.verifyConsentedTenant) {
      try {
        ({ tenantName } = await driver.verifyConsentedTenant({
          accessToken,
          tenantId,
          http: this.httpDefaults(),
          correlationId,
        }));
      } catch (e) {
        this.logger.warn({ err: (e as Error).message, integrationId, correlationId }, 'Consented tenant check failed');
        return fail('tenant_mismatch', oauth.provider, { tenantId, check: 'provider' }, 'tenant_unverified');
      }
    } else if (tokenTid === null) {
      // Neither the token nor the driver can prove the tenant: never store it.
      return fail('tenant_mismatch', oauth.provider, { tenantId, check: 'unverifiable' }, 'tenant_unverified');
    }
    const excess = excessScopes(roles, oauth.scopes);
    if (excess.length > 0) {
      return fail('excess_scopes', oauth.provider, { tenantId, excessScopes: excess.slice(0, 20) }, 'excess_permissions');
    }
    const missing = oauth.scopes.filter((s) => !roles.includes(s));
    const name = tenantName ? tenantName.slice(0, 256) : null;
    return {
      provider: oauth.provider,
      externalOrgId: tenantId,
      displayName: name,
      // Keep the report-names choice across a reconnect of the same connection.
      secret: (previous) => {
        const before = parseStoredAdminConsent(previous);
        return {
          tenantId,
          grantedRoles: roles,
          consentedAt: new Date().toISOString(),
          ...(name ? { tenantName: name } : {}),
          ...(before?.tenantId === tenantId && before.reportNames ? { reportNames: before.reportNames } : {}),
        };
      },
      auditAfter: { provider: oauth.provider, tenantId, grantedScopes: roles, missingScopes: missing },
    };
  }

  /**
   * Store a verified grant on the connection the flow was started for. A
   * reconnect must come back with the connection's own tenant; a new
   * connection must be for a tenant not connected yet.
   */
  private async storeConnection(
    actor: AuthedUser,
    integrationId: string,
    connectionId: string | null,
    grant: VerifiedGrant,
    meta: RequestMeta,
    fail: Fail,
  ): Promise<string> {
    const now = new Date();
    let id: string;
    if (connectionId) {
      const existing = await this.prisma.integrationConnection.findFirst({
        where: { id: connectionId, integrationId },
      });
      if (!existing) return fail('connection_missing', grant.provider, {}, 'connection_missing');
      // Tenant ids are compared without case: connections migrated by an earlier build kept their mapping's spelling.
      if (existing.externalOrgId.toLowerCase() !== grant.externalOrgId.toLowerCase()) {
        return fail(
          'reconnect_wrong_tenant',
          grant.provider,
          { tenantId: grant.externalOrgId, expectedTenantId: existing.externalOrgId },
          'wrong_tenant',
        );
      }
      const previous = this.readSecret(integrationId, existing.id, existing.secretCiphertext);
      const secretCiphertext = this.crypto.encrypt(
        JSON.stringify(grant.secret(previous)),
        integrationConnectionSecretAad(integrationId, existing.id),
      );
      await this.prisma.integrationConnection.update({
        where: { id: existing.id },
        data: {
          secretCiphertext,
          status: 'ok',
          connectedAt: now,
          connectedBy: actor.id,
          lastErrorAt: null,
          ...(grant.displayName ? { displayName: grant.displayName } : {}),
        },
      });
      id = existing.id;
    } else {
      const connected = await this.prisma.integrationConnection.findMany({
        where: { integrationId },
        select: { externalOrgId: true },
      });
      if (connected.some((c) => c.externalOrgId.toLowerCase() === grant.externalOrgId.toLowerCase())) {
        return fail('already_connected', grant.provider, { tenantId: grant.externalOrgId }, 'already_connected');
      }
      id = randomUUID();
      const secretCiphertext = this.crypto.encrypt(
        JSON.stringify(grant.secret(null)),
        integrationConnectionSecretAad(integrationId, id),
      );
      try {
        await this.prisma.integrationConnection.create({
          data: {
            id,
            integrationId,
            externalOrgId: grant.externalOrgId,
            displayName: grant.displayName,
            secretCiphertext,
            status: 'ok',
            connectedAt: now,
            connectedBy: actor.id,
          },
        });
      } catch (e) {
        if (!isUniqueConstraintError(e)) throw e;
        // One tenant is connected once per integration: use Reconnect on its row.
        return fail('already_connected', grant.provider, { tenantId: grant.externalOrgId }, 'already_connected');
      }
    }
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.integration.oauthConnect,
      entityType: 'Integration',
      entityId: integrationId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { ...grant.auditAfter, connectionId: id, reconnect: connectionId !== null },
    });
    return this.landing(integrationId, true);
  }

  async disconnect(actor: AuthedUser, integrationId: string, connectionId: string, meta: RequestMeta): Promise<void> {
    const { oauth } = await this.requireOAuthIntegration(integrationId);
    const row = await this.prisma.integrationConnection.findFirst({ where: { id: connectionId, integrationId } });
    if (!row) throw new NotFoundException('Connection not found.');
    // An unreadable secret is still wiped: revocation is skipped (no token
    // to send), and the audit row says why. Admin consent has no token to
    // revoke: the customer removes the enterprise app in their tenant.
    const raw = this.readSecret(integrationId, row.id, row.secretCiphertext);
    const unreadable = isAdminConsent(oauth) ? !parseStoredAdminConsent(raw) : !parseStoredOAuthSecret(raw);
    const stored = isAdminConsent(oauth) ? null : parseStoredOAuthSecret(raw);
    let revoked = false;
    if (stored && oauth.revokeUrl) {
      const correlationId = randomUUID();
      try {
        revoked = await revokeOAuthToken(oauth, stored.refreshToken, this.httpDefaults(), correlationId);
      } catch (e) {
        // Best effort: the local secret is wiped either way, and the
        // provider drops unused grants on its own.
        this.logger.warn(
          { err: (e as Error).message, integrationId, connectionId, correlationId },
          'OAuth token revocation failed',
        );
      }
    }
    await this.prisma.integrationConnection.deleteMany({ where: { id: row.id, integrationId } });
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.integration.oauthDisconnect,
      entityType: 'Integration',
      entityId: integrationId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { connectionId: row.id, tenantId: row.externalOrgId },
      after: {
        provider: oauth.provider,
        revoked,
        ...(unreadable ? { reason: 'secret_unreadable' } : {}),
      },
    });
  }

  private async requireOAuthIntegration(integrationId: string) {
    const row = await this.prisma.integration.findUnique({ where: { id: integrationId } });
    if (!row) throw new NotFoundException(`Integration ${integrationId} not found`);
    const oauth = this.drivers.has(row.driver) ? this.drivers.describe(row.driver).oauth : undefined;
    if (!oauth) throw new BadRequestException('This integration does not connect with OAuth.');
    return { row, oauth };
  }

  private async clientOrNull(integrationId: string): Promise<OAuthClientCredentials | null> {
    try {
      return await this.apps.getClient(integrationId);
    } catch {
      return null;
    }
  }

  /**
   * Decrypt a connection's stored grant. Null when it cannot be decrypted
   * or parsed (key rotated, damaged): the UI then offers Reconnect.
   */
  private readSecret(integrationId: string, connectionId: string, ciphertext: string): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(
        this.crypto.decrypt(ciphertext, integrationConnectionSecretAad(integrationId, connectionId)),
      );
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch (e) {
      this.logger.error(
        { err: (e as Error).message, integrationId, connectionId },
        'failed to decrypt integration connection secret',
      );
      return null;
    }
  }

  /** Latest finished sync per tenant (mapping external org id). */
  private async lastSyncByTenant(integrationId: string): Promise<Map<string, string>> {
    const mappings = await this.prisma.integrationCompanyMapping.findMany({
      where: { integrationId },
      select: { id: true, externalOrgId: true },
    });
    const out = new Map<string, string>();
    if (mappings.length === 0) return out;
    const latest = await this.prisma.integrationSyncRunCompanyResult.groupBy({
      by: ['integrationCompanyMappingId'],
      where: { integrationCompanyMappingId: { in: mappings.map((m) => m.id) }, finishedAt: { not: null } },
      _max: { finishedAt: true },
    });
    const tenantOf = new Map(mappings.map((m) => [m.id, m.externalOrgId]));
    for (const row of latest) {
      const tenant = tenantOf.get(row.integrationCompanyMappingId);
      const at = row._max.finishedAt?.toISOString();
      if (!tenant || !at) continue;
      const current = out.get(tenant);
      if (!current || at > current) out.set(tenant, at);
    }
    return out;
  }

  /** Separate so specs can skip the propagation wait. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private landing(integrationId: string | null, ok: boolean, reason?: LandingReason): string {
    const base = this.env.values.APP_URL.replace(/\/+$/, '');
    const path = integrationId ? `/admin/integrations/${integrationId}` : '/admin/integrations';
    const tab = integrationId ? 'tab=connections&' : '';
    return `${base}${path}?${tab}oauth=${ok ? 'connected' : 'failed'}${!ok && reason ? `&reason=${reason}` : ''}`;
  }

  private httpDefaults() {
    return {
      timeoutMs: this.env.values.INTEGRATION_HTTP_TIMEOUT_MS,
      maxRetries: this.env.values.INTEGRATION_HTTP_MAX_RETRIES,
      backoffMs: this.env.values.INTEGRATION_HTTP_BACKOFF_MS,
    };
  }
}
