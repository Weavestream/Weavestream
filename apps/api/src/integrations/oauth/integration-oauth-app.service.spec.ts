import { ConflictException, Logger } from '@nestjs/common';
import {
  integrationOAuthAppSecretAad,
} from '../../crypto/integration-secret-encryption.service.js';
import {
  IntegrationOAuthAppService,
  OAUTH_CALLBACK_HOST_WARNING,
  callbackHostWarning,
} from './integration-oauth-app.service.js';

const crypto = {
  encrypt: (plaintext: string, aad: string) => `enc[${aad}]${plaintext}`,
  decrypt: (blob: string, aad: string) => {
    const prefix = `enc[${aad}]`;
    if (!blob.startsWith(prefix)) throw new Error('aad mismatch');
    return blob.slice(prefix.length);
  },
};

const GW = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b1';

function setup(row: { id?: string; clientId: string; secretCiphertext: string; updatedAt: Date } | null = null) {
  let stored = row;
  const prisma = {
    integration: {
      // GW is a Google integration (driver 'a').
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id === GW ? { driver: 'a' } : null),
    },
    integrationOAuthApp: {
      findUnique: jest.fn(async () => stored),
      create: jest.fn(async ({ data }: { data: { clientId: string; secretCiphertext: string } }) => {
        stored = { id: 'app-1', ...data, updatedAt: new Date('2026-01-02T00:00:00Z') };
        return stored;
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        stored = { ...stored!, ...data };
        return stored;
      }),
    },
  };
  const audit = { log: jest.fn(async () => undefined) };
  const drivers: Record<string, unknown> & { list: () => Array<Record<string, unknown>> } = {
    list: () => [
      { key: 'a', label: 'Driver A', oauth: { provider: 'google', scopes: ['openid', 'scope.a'] } },
      { key: 'b', label: 'Driver B', oauth: { provider: 'google', scopes: ['openid', 'scope.b'] } },
      { key: 'd', label: 'Driver D', oauth: { provider: 'google', scopes: ['scope.a'] } },
      { key: 'c' },
    ],
  };
  drivers.has = (key: string) => drivers.list().some((d) => d.key === key);
  drivers.describe = (key: string) => drivers.list().find((d) => d.key === key);
  const env = { values: { API_URL: 'https://ws.example.test/api/', APP_URL: 'https://ws.example.test' } };
  const service = new IntegrationOAuthAppService(
    prisma as never,
    crypto as never,
    audit as never,
    env as never,
    drivers as never,
  );
  return { service, prisma, audit };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('IntegrationOAuthAppService', () => {
  it('reports an unconfigured app with the computed redirect URI and scope union', async () => {
    await expect(setup().service.get(GW)).resolves.toEqual({
      provider: 'google',
      configured: false,
      clientId: null,
      secretMask: null,
      redirectUri: 'https://ws.example.test/api/v1/admin/integrations/oauth/callback',
      callbackHostWarning: null,
      scopes: ['openid', 'scope.a', 'scope.b'],
      scopeGroups: [
        { label: 'Required', scopes: ['openid', 'scope.a'] },
        { label: 'Only if you use Driver B', scopes: ['scope.b'] },
      ],
      updatedAt: null,
    });
  });

  it('saves the secret encrypted with an integration-bound AAD and never returns it', async () => {
    const { service, prisma, audit } = setup();
    const dto = await service.update(
      { id: 'user-1' } as never,
      GW,
      { clientId: 'client-1', clientSecret: 'test-client-secret' },
      { ip: '127.0.0.1', userAgent: 'jest' },
    );
    const call = prisma.integrationOAuthApp.create.mock.calls[0] as unknown as [
      { data: { secretCiphertext: string; updatedBy: string; integrationId: string; provider: string } },
    ];
    expect(call[0].data.secretCiphertext).toBe(
      `enc[${integrationOAuthAppSecretAad(GW)}]test-client-secret`,
    );
    expect(call[0].data).toMatchObject({ updatedBy: 'user-1', integrationId: GW, provider: 'google' });
    expect(dto.configured).toBe(true);
    // The last-four mask of the existing secret helpers, never a hash of the secret.
    expect(dto.secretMask).toBe('••••cret');
    expect(JSON.stringify(dto)).not.toContain('test-client-secret');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'integration.oauth_app.update',
        entityType: 'Integration',
        entityId: GW,
      }),
    );
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('test-client-secret');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      after: { provider: 'google', clientId: 'client-1', secretMask: '••••cret' },
    }));
  });

  it('keeps the stored secret when only the client ID changes', async () => {
    const secretCiphertext = `enc[${integrationOAuthAppSecretAad(GW)}]kept-secret`;
    const { service, prisma, audit } = setup({ clientId: 'old-client', secretCiphertext, updatedAt: new Date() });
    const dto = await service.update(
      { id: 'user-1' } as never, GW, { clientId: 'new-client' }, { ip: '127.0.0.1', userAgent: 'jest' },
    );
    expect(prisma.integrationOAuthApp.create).not.toHaveBeenCalled();
    expect(prisma.integrationOAuthApp.update).toHaveBeenCalledWith({
      where: { integrationId: GW },
      data: { clientId: 'new-client', updatedBy: 'user-1' },
    });
    expect(dto.clientId).toBe('new-client');
    await expect(service.getClient(GW)).resolves.toMatchObject({ clientId: 'new-client', clientSecret: 'kept-secret' });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      after: { provider: 'google', clientId: 'new-client', secretKept: true },
    }));
  });

  it('requires a secret on the first save', async () => {
    const { service, prisma } = setup();
    await expect(service.update(
      { id: 'user-1' } as never, GW, { clientId: 'client-1' }, { ip: '127.0.0.1', userAgent: 'jest' },
    )).rejects.toThrow('Enter the client secret.');
    expect(prisma.integrationOAuthApp.create).not.toHaveBeenCalled();
  });

  it('decrypts client credentials for runtime use', async () => {
    const { service } = setup({
      id: 'app-1',
      clientId: 'client-1',
      secretCiphertext: crypto.encrypt('test-client-secret', integrationOAuthAppSecretAad(GW)),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    });
    await expect(service.getClient(GW)).resolves.toEqual({
      clientId: 'client-1',
      clientSecret: 'test-client-secret',
      // Non-secret cache marker: row id + updatedAt, never derived from the secret.
      version: 'app-1@2026-01-02T00:00:00.000Z',
    });
  });

  it('returns null when no app is configured', async () => {
    await expect(setup().service.getClient(GW)).resolves.toBeNull();
  });

  it('refuses a blob bound to another integration', async () => {
    for (const aad of [integrationOAuthAppSecretAad(OTHER)]) {
      const { service } = setup({ clientId: 'client-1', secretCiphertext: crypto.encrypt('test-client-secret', aad), updatedAt: new Date() });
      await expect(service.getClient(GW)).rejects.toBeInstanceOf(ConflictException);
    }
    const { service } = setup({
      clientId: 'client-1',
      secretCiphertext: crypto.encrypt('test-client-secret', integrationOAuthAppSecretAad(OTHER)),
      updatedAt: new Date(),
    });
    await expect(service.get(GW)).resolves.toMatchObject({
      configured: true,
      secretMask: null,
    });
  });

  describe('check (Check setup)', () => {
    const guide = [{ id: 'credentials', title: 'Paste', body: 'Paste it.' }];
    function checkSetup(row: Parameters<typeof setup>[0], diagnose = jest.fn(async () => ({ ok: true, passedStepIds: ['client'], failures: [] }))) {
      const ctx = setup(row);
      const drivers = (ctx.service as unknown as { drivers: Record<string, unknown> }).drivers;
      // A first Google driver without diagnose() must not hide the one that has it.
      drivers.list = () => [
        { key: 'a', oauth: { provider: 'google', scopes: ['openid'] } },
        { key: 'gw', oauth: { provider: 'google', scopes: ['openid'] }, setupGuide: guide },
      ];
      drivers.kindOf = () => 'pull';
      drivers.get = (key: string) => (key === 'gw' ? { diagnose } : {});
      (ctx.service as unknown as { env: { values: Record<string, unknown> } }).env.values = {
        API_URL: 'https://ws.example.test/api/', APP_URL: 'https://ws.example.test', INTEGRATION_HTTP_TIMEOUT_MS: 5_000, INTEGRATION_HTTP_MAX_RETRIES: 0, INTEGRATION_HTTP_BACKOFF_MS: 1,
      };
      return { ...ctx, diagnose };
    }
    const actor = { id: 'user-1' } as never;
    const meta = { ip: '127.0.0.1', userAgent: 'jest' };

    it('runs the driver client check with the decrypted client and redirect URI, and audits the outcome only', async () => {
      const { service, diagnose, audit } = checkSetup({
        clientId: 'client-1', secretCiphertext: `enc[${integrationOAuthAppSecretAad(GW)}]shh-secret`, updatedAt: new Date(),
      });
      await expect(service.check(actor, GW, meta)).resolves.toEqual({ ok: true, passedStepIds: ['client'], failures: [] });
      expect(diagnose).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'client',
        oauthClient: expect.objectContaining({ clientId: 'client-1', clientSecret: 'shh-secret' }),
        redirectUri: 'https://ws.example.test/api/v1/admin/integrations/oauth/callback',
      }));
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
        action: 'integration.oauth_app.check',
        entityId: GW,
        after: { provider: 'google', ok: true, failedStepIds: [] },
      }));
      expect(JSON.stringify(audit.log.mock.calls)).not.toContain('shh-secret');
    });

    it('fails the credentials step without calling Google when nothing is saved', async () => {
      const { service, diagnose } = checkSetup(null);
      await expect(service.check(actor, GW, meta)).resolves.toMatchObject({
        ok: false, failures: [{ stepId: 'credentials' }],
      });
      expect(diagnose).not.toHaveBeenCalled();
    });

    it('fails with the fixed host warning when API_URL and APP_URL differ in host', async () => {
      const { service, audit } = checkSetup({
        clientId: 'client-1', secretCiphertext: `enc[${integrationOAuthAppSecretAad(GW)}]shh-secret`, updatedAt: new Date(),
      });
      const env = (service as unknown as { env: { values: Record<string, unknown> } }).env.values;
      env.API_URL = 'https://api.example.test';
      await expect(service.check(actor, GW, meta)).resolves.toEqual({
        ok: false,
        passedStepIds: ['client'],
        failures: [{ stepId: null, message: OAUTH_CALLBACK_HOST_WARNING }],
      });
      await expect(service.get(GW)).resolves.toMatchObject({ callbackHostWarning: OAUTH_CALLBACK_HOST_WARNING });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ after: expect.objectContaining({ ok: false }) }));
    });

    it('returns the driver setup guide with the app view', async () => {
      const { service } = checkSetup(null);
      await expect(service.get(GW)).resolves.toMatchObject({ setupGuide: guide });
    });
  });
});

describe('callbackHostWarning', () => {
  it('is null for the normal same-host setup, ports ignored', () => {
    expect(callbackHostWarning('https://ws.example.test/api', 'https://ws.example.test')).toBeNull();
    expect(callbackHostWarning('http://localhost:4000', 'http://localhost:3000')).toBeNull();
  });

  it('warns when the hosts differ or a URL is unparseable', () => {
    expect(callbackHostWarning('https://api.example.test', 'https://ws.example.test')).toBe(OAUTH_CALLBACK_HOST_WARNING);
    expect(callbackHostWarning('not a url', 'https://ws.example.test')).toBe(OAUTH_CALLBACK_HOST_WARNING);
  });
});
