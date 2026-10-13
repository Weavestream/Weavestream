import { Logger } from '@nestjs/common';
import { setDefaultFetchForTests, setDefaultResolveForTests } from '../../common/egress/safe-fetch.js';
import { integrationConnectionSecretAad } from '../../crypto/integration-secret-encryption.service.js';
import { Microsoft365Driver } from '../drivers/microsoft-365/microsoft-365.driver.js';
import { MICROSOFT_PERMISSIONS } from '../drivers/microsoft-365/microsoft-365.graph.js';
import { IntegrationOAuthService, classifyConsentError, oauthStateKey } from './integration-oauth.service.js';
import {
  __resetOAuthAccessTokenCacheForTests,
  getOAuthAccessToken,
  parseStoredAdminConsent,
} from './oauth-token.js';

const INTEGRATION_ID = '00000000-0000-4000-8000-000000000071';
const TENANT = '11111111-2222-4333-8444-555555555555';
const OTHER_TENANT = '99999999-2222-4333-8444-555555555555';
const CONN = '00000000-0000-4000-8000-0000000000c1';
const USER = { id: 'user-1' } as never;
const OTHER_USER = { id: 'user-2' } as never;
const META = { ip: '127.0.0.1', userAgent: 'jest' };
const CLIENT = { clientId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', clientSecret: 'test-client-secret', version: 'app-1@v1' };
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const ORG_URL = 'https://graph.microsoft.com/v1.0/organization';
const driver = new Microsoft365Driver();

/** An unsigned JWT: the service reads claims from the token endpoint's answer, never verifies a signature. */
function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.sig`;
}
const token = (claims: Record<string, unknown> = {}) =>
  jwt({ tid: TENANT, appid: CLIENT.clientId, roles: MICROSOFT_PERMISSIONS, ...claims });

const crypto = {
  encrypt: (plaintext: string, aad: string) => `enc[${aad}]${plaintext}`,
  decrypt: (blob: string, aad: string) => {
    const prefix = `enc[${aad}]`;
    if (!blob.startsWith(prefix)) throw new Error('aad mismatch');
    return blob.slice(prefix.length);
  },
};

type Reply = { status?: number; body: unknown };

function scriptFetch(table: Record<string, Reply | Reply[]>) {
  const calls: Array<{ url: string; method: string; body?: string; headers?: Record<string, string> }> = [];
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  setDefaultFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined, headers: init?.headers as Record<string, string> });
    const key = keys.find((k) => url.startsWith(k));
    if (!key) throw new Error(`unscripted fetch ${url}`);
    const entry = table[key]!;
    const reply = Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]!) : entry;
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);
  setDefaultResolveForTests(async () => ['1.2.3.4']);
  return calls;
}

function setup(opts: { secret?: object | null } = {}) {
  const store = new Map<string, string>();
  const redis = {
    set: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
    getdel: jest.fn(async (k: string) => {
      const v = store.get(k) ?? null;
      store.delete(k);
      return v;
    }),
  };
  type Row = { id: string; integrationId: string; externalOrgId: string; secretCiphertext: string; displayName: string | null; status: string; connectedAt: Date; lastErrorAt: Date | null };
  const rows: Row[] = opts.secret
    ? [{
        id: CONN,
        integrationId: INTEGRATION_ID,
        externalOrgId: TENANT,
        displayName: 'Contoso',
        status: 'ok',
        connectedAt: new Date('2026-10-01T00:00:00.000Z'),
        lastErrorAt: null,
        secretCiphertext: crypto.encrypt(JSON.stringify(opts.secret), integrationConnectionSecretAad(INTEGRATION_ID, CONN)),
      }]
    : [];
  const match = (r: Row, where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v);
  const prisma = {
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(prisma)),
    integration: {
      findUnique: jest.fn(async () => ({ id: INTEGRATION_ID, driver: 'microsoft-365', config: {} })),
    },
    integrationOAuthApp: { findUnique: jest.fn(async () => ({ id: 'app-1', secretExpiresAt: new Date(Date.now() + 10 * 86_400_000) })) },
    integrationConnection: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => match(r, where))),
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => match(r, where)) ?? null),
      create: jest.fn(async ({ data }: { data: Row }) => {
        if (rows.some((r) => r.externalOrgId === data.externalOrgId)) throw Object.assign(new Error('unique'), { code: 'P2002' });
        rows.push({ ...data, lastErrorAt: data.lastErrorAt ?? null });
        return data;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => Object.assign(rows.find((r) => r.id === where.id)!, data)),
      deleteMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const i = rows.findIndex((r) => match(r, where));
        if (i >= 0) rows.splice(i, 1);
        return { count: i >= 0 ? 1 : 0 };
      }),
    },
    integrationCompanyMapping: { findMany: jest.fn(async () => []) },
    integrationSyncRunCompanyResult: { groupBy: jest.fn(async () => []) },
  };
  const drivers = {
    has: () => true,
    describe: () => driver.descriptor,
    kindOf: () => 'pull',
    get: () => driver,
  };
  const audit = {
    log: jest.fn(async (_entry: unknown) => undefined),
    // Same row, written with the transaction client.
    logWithClient: jest.fn(async (_tx: unknown, entry: unknown): Promise<undefined> => audit.log(entry)),
  };
  const apps = {
    getClient: jest.fn(async () => CLIENT),
    redirectUri: () => 'https://ws.example.test/api/v1/admin/integrations/oauth/callback',
  };
  const env = { values: { APP_URL: 'https://ws.example.test', INTEGRATION_HTTP_TIMEOUT_MS: 5_000, INTEGRATION_HTTP_MAX_RETRIES: 0, INTEGRATION_HTTP_BACKOFF_MS: 1 } };
  const service = new IntegrationOAuthService(prisma as never, { client: redis } as never, env as never, audit as never, crypto as never, drivers as never, apps as never);
  // No real propagation wait in tests.
  (service as unknown as { sleep: () => Promise<void> }).sleep = async () => undefined;
  const stored = () => {
    const row = rows[0];
    return row ? parseStoredAdminConsent(JSON.parse(crypto.decrypt(row.secretCiphertext, integrationConnectionSecretAad(INTEGRATION_ID, row.id)))) : null;
  };
  return { service, redis, store, prisma, audit, stored, rows };
}

async function startState(service: IntegrationOAuthService, actor = USER, connectionId?: string): Promise<{ state: string; url: URL }> {
  const { authorizeUrl } = await service.start(actor, INTEGRATION_ID, connectionId ? { connectionId } : {});
  const url = new URL(authorizeUrl);
  return { state: url.searchParams.get('state')!, url };
}

beforeEach(() => {
  __resetOAuthAccessTokenCacheForTests();
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  setDefaultFetchForTests(null);
  setDefaultResolveForTests(null);
});

describe('admin consent: start', () => {
  it('opens the organizations adminconsent URL with .default, no PKCE, and a state bound to user + integration', async () => {
    const { service, store } = setup();
    const { state, url } = await startState(service);
    expect(`${url.origin}${url.pathname}`).toBe('https://login.microsoftonline.com/organizations/v2.0/adminconsent');
    expect(url.searchParams.get('client_id')).toBe(CLIENT.clientId);
    expect(url.searchParams.get('scope')).toBe('https://graph.microsoft.com/.default');
    expect(url.searchParams.get('redirect_uri')).toContain('/oauth/callback');
    expect(url.searchParams.has('code_challenge')).toBe(false);
    expect(JSON.parse(store.get(oauthStateKey(state))!)).toEqual({ integrationId: INTEGRATION_ID, userId: 'user-1', connectionId: null, flow: 'admin_consent' });
  });
});

describe('admin consent: callback', () => {
  it('verifies the tenant by token tid and Graph, stores tenant, roles and name, never a refresh token', async () => {
    const { service, audit, stored } = setup();
    const calls = scriptFetch({
      [TOKEN_URL]: { body: { access_token: token(), expires_in: 3600 } },
      [ORG_URL]: { body: { value: [{ id: TENANT, displayName: 'Contoso' }] } },
    });
    const { state } = await startState(service);
    const landing = await service.callback(USER, { state, tenant: TENANT, admin_consent: 'True' }, META);
    expect(landing).toBe(`https://ws.example.test/admin/integrations/${INTEGRATION_ID}?tab=connections&oauth=connected`);
    expect(stored()).toMatchObject({ tenantId: TENANT, tenantName: 'Contoso', grantedRoles: MICROSOFT_PERMISSIONS });
    expect(JSON.stringify(stored())).not.toMatch(/refresh/i);
    const tokenCall = calls.find((c) => c.url === TOKEN_URL)!;
    expect(new URLSearchParams(tokenCall.body).get('grant_type')).toBe('client_credentials');
    expect(new URLSearchParams(tokenCall.body).get('scope')).toBe('https://graph.microsoft.com/.default');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'integration.oauth.connect',
      after: expect.objectContaining({ tenantId: TENANT, missingScopes: [] }),
    }));
  });

  it('rejects a forged tenant parameter: the token tid decides', async () => {
    const { service, stored, audit } = setup();
    scriptFetch({
      [`https://login.microsoftonline.com/${OTHER_TENANT}/oauth2/v2.0/token`]: { body: { access_token: token({ tid: TENANT }), expires_in: 3600 } },
    });
    const { state } = await startState(service);
    const landing = await service.callback(USER, { state, tenant: OTHER_TENANT, admin_consent: 'True' }, META);
    expect(landing).toContain('oauth=failed&reason=tenant_unverified');
    expect(stored()).toBeNull();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'integration.oauth.connect.failed', after: expect.objectContaining({ reason: 'tenant_mismatch' }) }));
  });

  it('rejects when Graph reports another tenant even if the token has no tid', async () => {
    const { service, stored } = setup();
    scriptFetch({
      [TOKEN_URL]: { body: { access_token: 'opaque-token', expires_in: 3600 } },
      [ORG_URL]: { body: { value: [{ id: OTHER_TENANT, displayName: 'Fabrikam' }] } },
    });
    const { state } = await startState(service);
    expect(await service.callback(USER, { state, tenant: TENANT, admin_consent: 'True' }, META)).toContain('reason=tenant_unverified');
    expect(stored()).toBeNull();
  });

  it('rejects a non-GUID tenant without any token request', async () => {
    const { service } = setup();
    const calls = scriptFetch({});
    const { state } = await startState(service);
    expect(await service.callback(USER, { state, tenant: '../evil', admin_consent: 'True' }, META)).toContain('reason=tenant_unverified');
    expect(calls).toHaveLength(0);
  });

  it('refuses a grant wider than the permission list', async () => {
    const { service, stored } = setup();
    scriptFetch({
      [TOKEN_URL]: { body: { access_token: token({ roles: [...MICROSOFT_PERMISSIONS, 'Directory.ReadWrite.All'] }), expires_in: 3600 } },
      [ORG_URL]: { body: { value: [{ id: TENANT, displayName: 'Contoso' }] } },
    });
    const { state } = await startState(service);
    expect(await service.callback(USER, { state, tenant: TENANT, admin_consent: 'True' }, META)).toContain('reason=excess_permissions');
    expect(stored()).toBeNull();
  });

  it('connects with missing roles and records which ones (Check setup asks for re-consent)', async () => {
    const { service, stored, audit } = setup();
    scriptFetch({
      [TOKEN_URL]: { body: { access_token: token({ roles: ['User.Read.All'] }), expires_in: 3600 } },
      [ORG_URL]: { body: { value: [{ id: TENANT, displayName: 'Contoso' }] } },
    });
    const { state } = await startState(service);
    expect(await service.callback(USER, { state, tenant: TENANT, admin_consent: 'True' }, META)).toContain('oauth=connected');
    expect(stored()?.grantedRoles).toEqual(['User.Read.All']);
    const after = (audit.log.mock.calls.at(-1) as unknown as [{ after: { missingScopes: string[] } }])[0].after;
    expect(after.missingScopes).toContain('AuditLog.Read.All');
  });

  it('retries while a fresh consent propagates (AADSTS700016), then connects', async () => {
    const { service } = setup();
    const calls = scriptFetch({
      [TOKEN_URL]: [
        { status: 400, body: { error: 'unauthorized_client', error_codes: [700016] } },
        { body: { access_token: token(), expires_in: 3600 } },
      ],
      [ORG_URL]: { body: { value: [{ id: TENANT, displayName: 'Contoso' }] } },
    });
    const { state } = await startState(service);
    expect(await service.callback(USER, { state, tenant: TENANT, admin_consent: 'True' }, META)).toContain('oauth=connected');
    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(2);
  });

  it('accepts a state once, only from the same user, and only before it expires', async () => {
    const { service, redis, audit } = setup();
    scriptFetch({
      [TOKEN_URL]: { body: { access_token: token(), expires_in: 3600 } },
      [ORG_URL]: { body: { value: [{ id: TENANT, displayName: 'Contoso' }] } },
    });
    const first = await startState(service);
    expect(await service.callback(USER, { state: first.state, tenant: TENANT, admin_consent: 'True' }, META)).toContain('connected');
    // Reuse.
    expect(await service.callback(USER, { state: first.state, tenant: TENANT, admin_consent: 'True' }, META)).toBe('https://ws.example.test/admin/integrations?oauth=failed');
    // Other user.
    const second = await startState(service);
    expect(await service.callback(OTHER_USER, { state: second.state, tenant: TENANT, admin_consent: 'True' }, META)).toContain('oauth=failed');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ after: expect.objectContaining({ reason: 'user_mismatch' }) }));
    // Expired: Redis no longer has it.
    const third = await startState(service);
    redis.getdel.mockResolvedValueOnce(null);
    expect(await service.callback(USER, { state: third.state, tenant: TENANT, admin_consent: 'True' }, META)).toBe('https://ws.example.test/admin/integrations?oauth=failed');
  });

  it('maps an error callback to a fixed reason and never stores or echoes the description', async () => {
    const { service, audit } = setup();
    const calls = scriptFetch({});
    const { state } = await startState(service);
    const description = 'AADSTS90094: <script>alert(1)</script> secret detail';
    const landing = await service.callback(USER, { state, error: 'access_denied', error_description: description }, META);
    expect(landing).toBe(`https://ws.example.test/admin/integrations/${INTEGRATION_ID}?tab=connections&oauth=failed&reason=admin_required`);
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('script');
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('secret detail');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ after: expect.objectContaining({ reason: 'provider_denied', providerError: 'access_denied', aadsts: 90094 }) }));
    expect(calls).toHaveLength(0);
  });

  it('classifies consent errors with a bounded allowlist', () => {
    expect(classifyConsentError({ error: 'access_denied', error_description: 'AADSTS65004: declined' })).toEqual({ providerError: 'access_denied', aadsts: 65004, landing: 'consent_declined' });
    expect(classifyConsentError({ error: 'weird<b>', error_description: 42 })).toEqual({ providerError: 'other', aadsts: null, landing: 'consent_declined' });
  });

  it('keeps the report-names choice on a reconnect of the same connection', async () => {
    const { service, stored } = setup({ secret: { tenantId: TENANT, grantedRoles: [], consentedAt: '2026-10-01T00:00:00.000Z', reportNames: 'shown' } });
    scriptFetch({
      [TOKEN_URL]: { body: { access_token: token(), expires_in: 3600 } },
      [ORG_URL]: { body: { value: [{ id: TENANT, displayName: 'Contoso' }] } },
    });
    const { state } = await startState(service, USER, CONN);
    expect(await service.callback(USER, { state, tenant: TENANT, admin_consent: 'True' }, META)).toContain('oauth=connected');
    expect(stored()?.reportNames).toBe('shown');
  });

  it('accepts a reconnect of a migrated connection whose tenant id differs only in case', async () => {
    const { service, rows, stored } = setup({ secret: { tenantId: TENANT, grantedRoles: [], consentedAt: '2026-10-01T00:00:00.000Z' } });
    rows[0]!.externalOrgId = TENANT.toUpperCase();
    scriptFetch({
      [TOKEN_URL]: { body: { access_token: token(), expires_in: 3600 } },
      [ORG_URL]: { body: { value: [{ id: TENANT, displayName: 'Contoso' }] } },
    });
    const { state } = await startState(service, USER, CONN);
    expect(await service.callback(USER, { state, tenant: TENANT, admin_consent: 'True' }, META)).toContain('oauth=connected');
    expect(rows).toHaveLength(1);
    expect(stored()?.consentedAt).not.toBe('2026-10-01T00:00:00.000Z');
  });

  it('refuses a new connection for a tenant connected under another case', async () => {
    const { service, rows } = setup({ secret: { tenantId: TENANT, grantedRoles: [], consentedAt: '2026-10-01T00:00:00.000Z' } });
    rows[0]!.externalOrgId = TENANT.toUpperCase();
    scriptFetch({
      [TOKEN_URL]: { body: { access_token: token(), expires_in: 3600 } },
      [ORG_URL]: { body: { value: [{ id: TENANT, displayName: 'Contoso' }] } },
    });
    const { state } = await startState(service);
    expect(await service.callback(USER, { state, tenant: TENANT, admin_consent: 'True' }, META)).toContain('reason=already_connected');
    expect(rows).toHaveLength(1);
  });

  it('refuses a reconnect consented in a different tenant than the connection', async () => {
    const { service, stored, rows } = setup({ secret: { tenantId: TENANT, grantedRoles: [], consentedAt: '2026-10-01T00:00:00.000Z' } });
    scriptFetch({
      [`https://login.microsoftonline.com/${OTHER_TENANT}/oauth2/v2.0/token`]: { body: { access_token: token({ tid: OTHER_TENANT }), expires_in: 3600 } },
      [ORG_URL]: { body: { value: [{ id: OTHER_TENANT, displayName: 'Fabrikam' }] } },
    });
    const { state } = await startState(service, USER, CONN);
    expect(await service.callback(USER, { state, tenant: OTHER_TENANT, admin_consent: 'True' }, META)).toContain('reason=wrong_tenant');
    expect(rows).toHaveLength(1);
    expect(stored()?.tenantId).toBe(TENANT);
  });

  it('connects a second tenant as its own connection', async () => {
    const { service, rows } = setup({ secret: { tenantId: TENANT, grantedRoles: [], consentedAt: '2026-10-01T00:00:00.000Z' } });
    scriptFetch({
      [`https://login.microsoftonline.com/${OTHER_TENANT}/oauth2/v2.0/token`]: { body: { access_token: token({ tid: OTHER_TENANT }), expires_in: 3600 } },
      [ORG_URL]: { body: { value: [{ id: OTHER_TENANT, displayName: 'Fabrikam' }] } },
    });
    const { state } = await startState(service);
    expect(await service.callback(USER, { state, tenant: OTHER_TENANT, admin_consent: 'True' }, META)).toContain('oauth=connected');
    expect(rows.map((r) => r.externalOrgId)).toEqual([TENANT, OTHER_TENANT]);
    expect(rows[1]!.displayName).toBe('Fabrikam');
  });
});

describe('admin consent: connections and disconnect', () => {
  it('shows the tenant name, roles, choice and the app secret expiry warning', async () => {
    const { service } = setup({ secret: { tenantId: TENANT, tenantName: 'Contoso', grantedRoles: ['User.Read.All'], consentedAt: '2026-10-01T00:00:00.000Z', reportNames: 'hidden' } });
    const list = await service.listConnections(INTEGRATION_ID);
    expect(list.connections[0]).toMatchObject({ id: CONN, displayName: 'Contoso', externalOrgId: TENANT, grantedScopes: ['User.Read.All'], connectedAs: null, reportNames: 'hidden', status: 'ok' });
    expect(list.appSecretExpiryWarning).toMatch(/expires on .* \(in \d+ days\)/);
    expect(list.appSecretExpired).toBe(false);
  });

  it('disconnects by wiping the consent (nothing to revoke) and audits it', async () => {
    const { service, stored, audit } = setup({ secret: { tenantId: TENANT, grantedRoles: [], consentedAt: '2026-10-01T00:00:00.000Z' } });
    const calls = scriptFetch({});
    await service.disconnect(USER, INTEGRATION_ID, CONN, META);
    expect(stored()).toBeNull();
    expect(calls).toHaveLength(0);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'integration.oauth.disconnect', before: { connectionId: CONN, tenantId: TENANT } }));
  });
});

describe('admin consent: access tokens', () => {
  const ctx = (version: string, connectionId?: string, tenantId: string = TENANT) => ({
    config: {},
    secret: { tenantId, grantedRoles: [], consentedAt: '2026-10-01T00:00:00.000Z' },
    oauthClient: CLIENT,
    integrationId: INTEGRATION_ID,
    ...(connectionId ? { connectionId } : {}),
    credentialVersion: version,
    correlationId: 'c',
    http: { timeoutMs: 5_000, maxRetries: 0, backoffMs: 1 },
  });

  it('mints client-credentials tokens per tenant, cached by integration + credentialVersion', async () => {
    const calls = scriptFetch({ [TOKEN_URL]: { body: { access_token: 'tok-1', expires_in: 3600 } } });
    expect(await getOAuthAccessToken(ctx('v1'), driver.descriptor.oauth!)).toBe('tok-1');
    expect(await getOAuthAccessToken(ctx('v1'), driver.descriptor.oauth!)).toBe('tok-1');
    expect(calls).toHaveLength(1);
    // A reconnect or a new app secret changes the version: new token.
    await getOAuthAccessToken(ctx('v2'), driver.descriptor.oauth!);
    expect(calls).toHaveLength(2);
    expect(new URLSearchParams(calls[0]!.body).get('refresh_token')).toBeNull();
  });

  it('caches one token per connection: two tenants never share or evict a token', async () => {
    const otherTokenUrl = `https://login.microsoftonline.com/${OTHER_TENANT}/oauth2/v2.0/token`;
    const calls = scriptFetch({
      [TOKEN_URL]: { body: { access_token: 'tok-a', expires_in: 3600 } },
      [otherTokenUrl]: { body: { access_token: 'tok-b', expires_in: 3600 } },
    });
    const a = ctx(`${CONN}@v1`, CONN);
    const b = ctx('conn-b@v1', '00000000-0000-4000-8000-0000000000c2', OTHER_TENANT);
    expect(await getOAuthAccessToken(a, driver.descriptor.oauth!)).toBe('tok-a');
    expect(await getOAuthAccessToken(b, driver.descriptor.oauth!)).toBe('tok-b');
    expect(await getOAuthAccessToken(a, driver.descriptor.oauth!)).toBe('tok-a');
    expect(await getOAuthAccessToken(b, driver.descriptor.oauth!)).toBe('tok-b');
    expect(calls).toHaveLength(2);
  });

  it('turns AADSTS refusals into fixed DriverAuthError text', async () => {
    scriptFetch({ [TOKEN_URL]: { status: 401, body: { error: 'invalid_client', error_description: 'AADSTS7000222: keys expired, internal detail', error_codes: [7000222] } } });
    await expect(getOAuthAccessToken(ctx('v1'), driver.descriptor.oauth!)).rejects.toThrow(/client secret of the Microsoft app has expired \(AADSTS7000222\)/);
    __resetOAuthAccessTokenCacheForTests();
    scriptFetch({ [TOKEN_URL]: { status: 400, body: { error: 'unauthorized_client', error_codes: [700016] } } });
    await expect(getOAuthAccessToken(ctx('v1'), driver.descriptor.oauth!)).rejects.toThrow(/press Reconnect/);
  });
});
