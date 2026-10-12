import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import type { DriverDescriptor, DriverOAuthDescriptor } from '@weavestream/shared';
import {
  setDefaultFetchForTests,
  setDefaultResolveForTests,
} from '../../common/egress/safe-fetch.js';
import { integrationConnectionSecretAad } from '../../crypto/integration-secret-encryption.service.js';
import { IntegrationOAuthService, OAUTH_STATE_TTL_SEC, excessScopes, oauthStateKey } from './integration-oauth.service.js';

/**
 * The OAuth framework is exercised with a test-only fake driver: no real
 * OAuth driver is registered yet.
 */
const FAKE_OAUTH: DriverOAuthDescriptor = {
  provider: 'google',
  authorizeUrl: 'https://auth.example.test/authorize?existing=1',
  tokenUrl: 'https://auth.example.test/token',
  revokeUrl: 'https://auth.example.test/revoke',
  scopes: ['openid', 'email', 'scope.read'],
  extraAuthorizeParams: { access_type: 'offline', prompt: 'consent', state: 'attacker', client_id: 'evil' },
};
const FAKE_DRIVER = { key: 'fake-oauth', oauth: FAKE_OAUTH } as unknown as DriverDescriptor;
const PLAIN_DRIVER = { key: 'plain' } as unknown as DriverDescriptor;

const INTEGRATION_ID = '00000000-0000-4000-8000-000000000001';
const CONN_A = '00000000-0000-4000-8000-0000000000a1';
const USER = { id: 'user-1' } as never;
const OTHER_USER = { id: 'user-2' } as never;
const META = { ip: '127.0.0.1', userAgent: 'jest' };
const CLIENT = { clientId: 'client-1', clientSecret: 'test-client-secret' };

function makeRedis() {
  const store = new Map<string, string>();
  const client = {
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    getdel: jest.fn(async (key: string) => {
      const v = store.get(key) ?? null;
      store.delete(key);
      return v;
    }),
  };
  return { client, store };
}

const crypto = {
  encrypt: (plaintext: string, aad: string) => `enc[${aad}]${plaintext}`,
  decrypt: (blob: string, aad: string) => {
    const prefix = `enc[${aad}]`;
    if (!blob.startsWith(prefix)) throw new Error('aad mismatch');
    return blob.slice(prefix.length);
  },
};

interface ConnRow {
  id: string;
  integrationId: string;
  externalOrgId: string;
  displayName: string | null;
  secretCiphertext: string;
  status: string;
  connectedBy: string | null;
  connectedAt: Date;
  lastErrorAt: Date | null;
  updatedAt: Date;
}

function connRow(over: Partial<ConnRow> & { secret?: object }): ConnRow {
  const id = over.id ?? CONN_A;
  return {
    id,
    integrationId: INTEGRATION_ID,
    externalOrgId: 'C-tenant-a',
    displayName: 'tenant-a.example',
    secretCiphertext: over.secretCiphertext
      ?? crypto.encrypt(JSON.stringify(over.secret ?? {}), integrationConnectionSecretAad(INTEGRATION_ID, id)),
    status: 'ok',
    connectedBy: null,
    connectedAt: new Date('2026-01-01T00:00:00.000Z'),
    lastErrorAt: null,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  };
}

function setup(
  opts: {
    driver?: DriverDescriptor;
    client?: typeof CLIENT | null;
    connections?: ConnRow[];
    /** Tenant the fake driver reports for a fresh grant. */
    tenant?: { externalId: string; name: string } | null;
  } = {},
) {
  const redis = makeRedis();
  const connections: ConnRow[] = [...(opts.connections ?? [])];
  const match = (row: ConnRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => (row as unknown as Record<string, unknown>)[k] === v);
  const prisma = {
    integration: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id === INTEGRATION_ID ? { id: INTEGRATION_ID, driver: (opts.driver ?? FAKE_DRIVER).key, config: {} } : null,
      ),
    },
    integrationOAuthApp: {
      findUnique: jest.fn(async () => (opts.client === null ? null : { id: 'app-1', secretExpiresAt: null })),
    },
    integrationConnection: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => connections.filter((r) => match(r, where))),
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => connections.find((r) => match(r, where)) ?? null),
      create: jest.fn(async ({ data }: { data: ConnRow }) => {
        if (connections.some((r) => r.integrationId === data.integrationId && r.externalOrgId === data.externalOrgId)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        const row = { ...data, lastErrorAt: data.lastErrorAt ?? null, updatedAt: data.updatedAt ?? new Date() } as ConnRow;
        connections.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<ConnRow> }) => {
        const row = connections.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
      deleteMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const before = connections.length;
        for (let i = connections.length - 1; i >= 0; i -= 1) if (match(connections[i]!, where)) connections.splice(i, 1);
        return { count: before - connections.length };
      }),
    },
    integrationCompanyMapping: { findMany: jest.fn(async () => []) },
    integrationSyncRunCompanyResult: { groupBy: jest.fn(async () => []) },
  };
  const driver = opts.driver ?? FAKE_DRIVER;
  const listSourceOrgs = jest.fn(async () =>
    opts.tenant === null ? [] : [opts.tenant ?? { externalId: 'C-tenant-a', name: 'tenant-a.example', hint: null }],
  );
  const drivers = {
    has: () => true,
    describe: () => driver,
    kindOf: () => 'pull',
    get: () => ({ listSourceOrgs }),
  };
  const audit = { log: jest.fn(async () => undefined) };
  const apps = {
    getClient: jest.fn(async () => (opts.client === undefined ? CLIENT : opts.client)),
    redirectUri: () => 'https://ws.example.test/api/v1/admin/integrations/oauth/callback',
  };
  const env = {
    values: {
      APP_URL: 'https://ws.example.test/',
      INTEGRATION_HTTP_TIMEOUT_MS: 5_000,
      INTEGRATION_HTTP_MAX_RETRIES: 1,
      INTEGRATION_HTTP_BACKOFF_MS: 1,
    },
  };
  const service = new IntegrationOAuthService(
    prisma as never,
    { client: redis.client } as never,
    env as never,
    audit as never,
    crypto as never,
    drivers as never,
    apps as never,
  );
  return { service, redis, prisma, audit, apps, connections, listSourceOrgs };
}

function scriptFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; body?: string }> = [];
  let i = 0;
  setDefaultFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: typeof init?.body === 'string' ? init.body : undefined });
    const next = responses[i++];
    if (!next) throw new Error('unscripted fetch');
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch);
  setDefaultResolveForTests(async () => ['1.2.3.4']);
  return calls;
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  setDefaultFetchForTests(null);
  setDefaultResolveForTests(null);
});

async function startFlow(ctx: ReturnType<typeof setup>, connectionId?: string) {
  const { authorizeUrl } = await ctx.service.start(USER, INTEGRATION_ID, connectionId ? { connectionId } : {});
  return new URL(authorizeUrl);
}

const TOKENS = { body: { access_token: 'a', expires_in: 3600, refresh_token: 'test-refresh-1', scope: 'openid email scope.read' } };

function idToken(claims: object): string {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
}

describe('IntegrationOAuthService.start', () => {
  it('builds a PKCE authorize URL and stores single-use state bound to user, integration and intent', async () => {
    const ctx = setup();
    const url = await startFlow(ctx);
    expect(url.origin + url.pathname).toBe('https://auth.example.test/authorize');
    expect(url.searchParams.get('existing')).toBe('1');
    expect(url.searchParams.get('access_type')).toBe('offline');
    // Reserved params beat descriptor extras.
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('state')).not.toBe('attacker');
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid email scope.read');
    const state = url.searchParams.get('state')!;
    expect(ctx.redis.client.set).toHaveBeenCalledWith(oauthStateKey(state), expect.any(String), 'EX', OAUTH_STATE_TTL_SEC);
    const stored = JSON.parse(ctx.redis.store.get(oauthStateKey(state))!);
    expect(stored).toMatchObject({ integrationId: INTEGRATION_ID, userId: 'user-1', connectionId: null });
    // The raw state is never the Redis key.
    expect([...ctx.redis.store.keys()].some((k) => k.includes(state))).toBe(false);
  });

  it('binds a reconnect to the connection id', async () => {
    const ctx = setup({ connections: [connRow({})] });
    const url = await startFlow(ctx, CONN_A);
    const stored = JSON.parse(ctx.redis.store.get(oauthStateKey(url.searchParams.get('state')!))!);
    expect(stored.connectionId).toBe(CONN_A);
  });

  it('refuses a reconnect of a connection of another integration', async () => {
    const ctx = setup({ connections: [connRow({ integrationId: '00000000-0000-4000-8000-000000000002' })] });
    await expect(startFlow(ctx, CONN_A)).rejects.toBeInstanceOf(NotFoundException);
    expect(ctx.redis.client.set).not.toHaveBeenCalled();
  });

  it('refuses when the integration app is not configured', async () => {
    await expect(setup({ client: null }).service.start(USER, INTEGRATION_ID)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses drivers without oauth and unknown integrations', async () => {
    await expect(setup({ driver: PLAIN_DRIVER }).service.start(USER, INTEGRATION_ID)).rejects.toBeInstanceOf(BadRequestException);
    await expect(setup().service.start(USER, '00000000-0000-4000-8000-000000000009')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('IntegrationOAuthService.callback', () => {
  const connected = `https://ws.example.test/admin/integrations/${INTEGRATION_ID}?tab=connections&oauth=connected`;
  const failed = `https://ws.example.test/admin/integrations/${INTEGRATION_ID}?tab=connections&oauth=failed`;

  it('exchanges the code, identifies the tenant, stores a new connection encrypted and audits', async () => {
    const ctx = setup();
    const url = await startFlow(ctx);
    const calls = scriptFetch([
      {
        body: {
          access_token: 'access-1',
          expires_in: 3600,
          refresh_token: 'test-refresh-1',
          scope: 'openid email scope.read',
          id_token: idToken({ email: 'admin@example.test' }),
        },
      },
    ]);
    const landing = await ctx.service.callback(USER, { code: 'code-1', state: url.searchParams.get('state') }, META);
    expect(landing).toBe(connected);
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get('code')).toBe('code-1');
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect(ctx.connections).toHaveLength(1);
    const row = ctx.connections[0]!;
    expect(row).toMatchObject({ externalOrgId: 'C-tenant-a', displayName: 'tenant-a.example', connectedBy: 'user-1' });
    // Encrypted under the connection's own AAD.
    const plaintext = JSON.parse(crypto.decrypt(row.secretCiphertext, integrationConnectionSecretAad(INTEGRATION_ID, row.id)));
    expect(plaintext).toMatchObject({
      refreshToken: 'test-refresh-1',
      grantedScopes: ['openid', 'email', 'scope.read'],
      connectedAs: 'admin@example.test',
    });
    // The tenant was read with the fresh grant, never cached.
    expect(ctx.listSourceOrgs).toHaveBeenCalledWith(expect.objectContaining({ integrationId: INTEGRATION_ID, oauthClient: CLIENT }));
    expect(ctx.listSourceOrgs.mock.calls[0]).not.toHaveProperty('0.credentialVersion');
    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'integration.oauth.connect',
        entityId: INTEGRATION_ID,
        after: expect.objectContaining({ connectionId: row.id, tenantId: 'C-tenant-a', reconnect: false }),
      }),
    );
    // Audit rows never carry the token.
    expect(JSON.stringify(ctx.audit.log.mock.calls)).not.toContain('test-refresh-1');
  });

  it('refuses a new connection for a tenant that is already connected', async () => {
    const ctx = setup({ connections: [connRow({ secret: { refreshToken: 'old', grantedScopes: [], connectedAt: 'x' } })] });
    const url = await startFlow(ctx);
    scriptFetch([TOKENS]);
    await expect(ctx.service.callback(USER, { code: 'c', state: url.searchParams.get('state') }, META)).resolves.toBe(
      `${failed}&reason=already_connected`,
    );
    expect(ctx.connections).toHaveLength(1);
    expect(crypto.decrypt(ctx.connections[0]!.secretCiphertext, integrationConnectionSecretAad(INTEGRATION_ID, CONN_A))).toContain('old');
  });

  it('reconnect updates exactly the intended connection', async () => {
    const other = connRow({ id: '00000000-0000-4000-8000-0000000000b2', externalOrgId: 'C-tenant-b' });
    const ctx = setup({ connections: [connRow({ status: 'needs_reconnect' }), other] });
    const url = await startFlow(ctx, CONN_A);
    scriptFetch([TOKENS]);
    await expect(ctx.service.callback(USER, { code: 'c', state: url.searchParams.get('state') }, META)).resolves.toBe(connected);
    expect(ctx.connections).toHaveLength(2);
    const a = ctx.connections.find((r) => r.id === CONN_A)!;
    expect(a.status).toBe('ok');
    expect(crypto.decrypt(a.secretCiphertext, integrationConnectionSecretAad(INTEGRATION_ID, CONN_A))).toContain('test-refresh-1');
    expect(other.secretCiphertext).not.toContain('test-refresh-1');
  });

  it('refuses a reconnect that comes back from a different tenant', async () => {
    const ctx = setup({
      connections: [connRow({ secret: { refreshToken: 'old', grantedScopes: [], connectedAt: 'x' } })],
      tenant: { externalId: 'C-tenant-b', name: 'tenant-b.example' },
    });
    const url = await startFlow(ctx, CONN_A);
    scriptFetch([TOKENS]);
    await expect(ctx.service.callback(USER, { code: 'c', state: url.searchParams.get('state') }, META)).resolves.toBe(
      `${failed}&reason=wrong_tenant`,
    );
    expect(ctx.prisma.integrationConnection.update).not.toHaveBeenCalled();
    expect(ctx.prisma.integrationConnection.create).not.toHaveBeenCalled();
    expect(ctx.audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'integration.oauth.connect.failed',
      after: expect.objectContaining({ reason: 'reconnect_wrong_tenant', tenantId: 'C-tenant-b', expectedTenantId: 'C-tenant-a' }),
    }));
  });

  it('fails when the reconnected connection was removed mid-flow', async () => {
    const ctx = setup({ connections: [connRow({})] });
    const url = await startFlow(ctx, CONN_A);
    ctx.connections.length = 0;
    scriptFetch([TOKENS]);
    await expect(ctx.service.callback(USER, { code: 'c', state: url.searchParams.get('state') }, META)).resolves.toBe(
      `${failed}&reason=connection_missing`,
    );
    expect(ctx.prisma.integrationConnection.create).not.toHaveBeenCalled();
  });

  it('fails when the tenant cannot be identified', async () => {
    const ctx = setup({ tenant: null });
    const url = await startFlow(ctx);
    scriptFetch([TOKENS]);
    await expect(ctx.service.callback(USER, { code: 'c', state: url.searchParams.get('state') }, META)).resolves.toBe(
      `${failed}&reason=tenant_unverified`,
    );
    expect(ctx.connections).toHaveLength(0);
  });

  it('rejects a reused state', async () => {
    const ctx = setup();
    const url = await startFlow(ctx);
    scriptFetch([TOKENS]);
    const query = { code: 'code-1', state: url.searchParams.get('state') };
    await expect(ctx.service.callback(USER, query, META)).resolves.toBe(connected);
    await expect(ctx.service.callback(USER, query, META)).resolves.toBe('https://ws.example.test/admin/integrations?oauth=failed');
    expect(ctx.prisma.integrationConnection.create).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown or expired state without touching the integration', async () => {
    const ctx = setup();
    await expect(ctx.service.callback(USER, { code: 'c', state: 'expired-or-forged' }, META)).resolves.toBe(
      'https://ws.example.test/admin/integrations?oauth=failed',
    );
    await expect(ctx.service.callback(USER, {}, META)).resolves.toBe('https://ws.example.test/admin/integrations?oauth=failed');
    expect(ctx.prisma.integrationConnection.create).not.toHaveBeenCalled();
  });

  it('rejects a state started by another user and burns it', async () => {
    const ctx = setup();
    const url = await startFlow(ctx);
    const state = url.searchParams.get('state');
    await expect(ctx.service.callback(OTHER_USER, { code: 'c', state }, META)).resolves.toBe(failed);
    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'integration.oauth.connect.failed',
        after: { provider: null, reason: 'user_mismatch', connectionId: null },
      }),
    );
    // The legitimate user cannot complete it afterwards either.
    await expect(ctx.service.callback(USER, { code: 'c', state }, META)).resolves.toBe(
      'https://ws.example.test/admin/integrations?oauth=failed',
    );
    expect(ctx.prisma.integrationConnection.create).not.toHaveBeenCalled();
  });

  it('never echoes the provider error', async () => {
    const ctx = setup();
    const url = await startFlow(ctx);
    const landing = await ctx.service.callback(USER, { error: 'access_denied<script>', state: url.searchParams.get('state') }, META);
    expect(landing).toBe(failed);
    expect(landing).not.toContain('access_denied');
  });

  it('fails cleanly when the token exchange fails', async () => {
    const ctx = setup();
    const url = await startFlow(ctx);
    scriptFetch([{ status: 400, body: { error: 'invalid_grant', error_description: 'Bad code' } }]);
    await expect(ctx.service.callback(USER, { code: 'c', state: url.searchParams.get('state') }, META)).resolves.toBe(failed);
    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ after: { provider: 'google', reason: 'token_exchange', connectionId: null } }),
    );
    expect(ctx.prisma.integrationConnection.create).not.toHaveBeenCalled();
  });

  it('fails when the provider returns no refresh token', async () => {
    const ctx = setup();
    const url = await startFlow(ctx);
    scriptFetch([{ body: { access_token: 'a' } }]);
    await expect(ctx.service.callback(USER, { code: 'c', state: url.searchParams.get('state') }, META)).resolves.toBe(failed);
    expect(ctx.prisma.integrationConnection.create).not.toHaveBeenCalled();
  });

  it('fails and audits when the grant carries scopes that were not requested', async () => {
    const ctx = setup();
    const url = await startFlow(ctx);
    scriptFetch([{ body: { access_token: 'a', refresh_token: 'test-refresh-1', scope: 'openid scope.read scope.write' } }]);
    await expect(ctx.service.callback(USER, { code: 'c', state: url.searchParams.get('state') }, META)).resolves.toBe(failed);
    expect(ctx.prisma.integrationConnection.create).not.toHaveBeenCalled();
    expect(ctx.audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'integration.oauth.connect.failed',
      after: { provider: 'google', reason: 'excess_scopes', connectionId: null, excessScopes: ['scope.write'] },
    }));
  });

  it('connects with a subset of the requested scopes and Google identity scope names', async () => {
    const ctx = setup();
    const url = await startFlow(ctx);
    scriptFetch([{ body: { access_token: 'a', refresh_token: 'test-refresh-1', scope: 'openid https://www.googleapis.com/auth/userinfo.email' } }]);
    await expect(ctx.service.callback(USER, { code: 'c', state: url.searchParams.get('state') }, META)).resolves.toBe(connected);
    expect(ctx.prisma.integrationConnection.create).toHaveBeenCalled();
  });
});

describe('excessScopes', () => {
  it('ignores identity scopes and requested ones', () => {
    expect(excessScopes(['openid', 'profile', 'https://www.googleapis.com/auth/userinfo.profile', 'a', 'b'], ['a'])).toEqual(['b']);
  });
});

describe('IntegrationOAuthService.disconnect and listConnections', () => {
  const stored = {
    refreshToken: 'test-refresh-1',
    grantedScopes: ['scope.read'],
    connectedAs: 'admin@example.test',
    connectedAt: '2026-01-01T00:00:00.000Z',
  };

  it('lists connections without tokens', async () => {
    const list = await setup({ connections: [connRow({ secret: stored })] }).service.listConnections(INTEGRATION_ID);
    expect(list).toEqual({
      provider: 'google',
      appConfigured: true,
      redirectUri: 'https://ws.example.test/api/v1/admin/integrations/oauth/callback',
      appSecretExpiryWarning: null,
      appSecretExpired: false,
      connections: [
        {
          id: CONN_A,
          externalOrgId: 'C-tenant-a',
          displayName: 'tenant-a.example',
          connectedAs: 'admin@example.test',
          connectedAt: '2026-01-01T00:00:00.000Z',
          grantedScopes: ['scope.read'],
          status: 'ok',
          lastErrorAt: null,
          lastSyncAt: null,
          reportNames: null,
        },
      ],
    });
    expect(JSON.stringify(list)).not.toContain('test-refresh-1');
  });

  it('reports the last finished sync of the tenant mapping', async () => {
    const ctx = setup({ connections: [connRow({ secret: stored })] });
    ctx.prisma.integrationCompanyMapping.findMany.mockResolvedValue([{ id: 'm-1', externalOrgId: 'C-tenant-a' }] as never);
    ctx.prisma.integrationSyncRunCompanyResult.groupBy.mockResolvedValue([
      { integrationCompanyMappingId: 'm-1', _max: { finishedAt: new Date('2026-02-01T00:00:00.000Z') } },
    ] as never);
    const list = await ctx.service.listConnections(INTEGRATION_ID);
    expect(list.connections[0]!.lastSyncAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('revokes at the provider, deletes only that connection and audits', async () => {
    const other = connRow({ id: '00000000-0000-4000-8000-0000000000b2', externalOrgId: 'C-tenant-b', secret: stored });
    const ctx = setup({ connections: [connRow({ secret: stored }), other] });
    const calls = scriptFetch([{ body: {} }]);
    await ctx.service.disconnect(USER, INTEGRATION_ID, CONN_A, META);
    expect(calls[0]!.url).toBe('https://auth.example.test/revoke');
    expect(ctx.connections.map((r) => r.id)).toEqual([other.id]);
    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'integration.oauth.disconnect',
        before: { connectionId: CONN_A, tenantId: 'C-tenant-a' },
        after: { provider: 'google', revoked: true },
      }),
    );
  });

  it('refuses to disconnect a connection of another integration', async () => {
    const ctx = setup({ connections: [connRow({ integrationId: '00000000-0000-4000-8000-000000000002', secret: stored })] });
    await expect(ctx.service.disconnect(USER, INTEGRATION_ID, CONN_A, META)).rejects.toBeInstanceOf(NotFoundException);
    expect(ctx.connections).toHaveLength(1);
  });

  it('still deletes the connection when revocation fails', async () => {
    const ctx = setup({ connections: [connRow({ secret: stored })] });
    setDefaultResolveForTests(async () => ['1.2.3.4']);
    setDefaultFetchForTests((async () => {
      throw new Error('network down');
    }) as typeof fetch);
    await ctx.service.disconnect(USER, INTEGRATION_ID, CONN_A, META);
    expect(ctx.connections).toHaveLength(0);
    expect(ctx.audit.log).toHaveBeenCalledWith(expect.objectContaining({ after: { provider: 'google', revoked: false } }));
  });

  // Encrypted under another connection's AAD: decrypt fails, as after a key rotation.
  const undecryptable = crypto.encrypt(JSON.stringify(stored), integrationConnectionSecretAad(INTEGRATION_ID, '00000000-0000-4000-8000-000000000099'));
  const wrongShape = crypto.encrypt(JSON.stringify({ unexpected: true }), integrationConnectionSecretAad(INTEGRATION_ID, CONN_A));

  it.each([
    ['cannot be decrypted', undecryptable],
    ['does not parse', wrongShape],
  ])('reports needs_reconnect instead of throwing when the stored grant %s', async (_label, secretCiphertext) => {
    const list = await setup({ connections: [connRow({ secretCiphertext })] }).service.listConnections(INTEGRATION_ID);
    expect(list.connections[0]).toMatchObject({ status: 'needs_reconnect', grantedScopes: [] });
  });

  it.each([
    ['cannot be decrypted', undecryptable],
    ['does not parse', wrongShape],
  ])('deletes a stored grant that %s without calling the provider, and audits why', async (_label, secretCiphertext) => {
    const ctx = setup({ connections: [connRow({ secretCiphertext })] });
    const calls = scriptFetch([]);
    await ctx.service.disconnect(USER, INTEGRATION_ID, CONN_A, META);
    expect(calls).toHaveLength(0);
    expect(ctx.connections).toHaveLength(0);
    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'integration.oauth.disconnect',
        after: { provider: 'google', revoked: false, reason: 'secret_unreadable' },
      }),
    );
  });
});
