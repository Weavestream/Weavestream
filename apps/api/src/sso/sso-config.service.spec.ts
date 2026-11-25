import { Logger } from '@nestjs/common';
import type { EnvService } from '../config/env.service.js';
import type { IntegrationSecretEncryptionService } from '../crypto/integration-secret-encryption.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { SsoConfigService, SSO_ENV_KEYS, SSO_SETTINGS_SINGLETON_ID } from './sso-config.service.js';

const ENV_ISSUER = 'https://login.example.test/env-tenant/v2.0';
const DB_ISSUER = 'https://login.example.test/db-tenant/v2.0';

const ROW = {
  enabled: true,
  providerName: 'Database IdP',
  issuer: DB_ISSUER,
  clientId: 'db-client',
  clientSecretCiphertext: 'cipher-1',
  scopes: 'openid profile',
  allowedTenantId: '11111111-2222-3333-4444-555555555555',
  linkByEmail: true,
  autoProvision: true,
  trustIdpMfa: true,
  assumeIdpMfa: true,
  localLoginEnabled: false,
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  updatedBy: null,
};

function make(opts: { env?: Record<string, unknown>; row?: Record<string, unknown> | null; decryptFails?: boolean } = {}) {
  const env = {
    values: {
      API_URL: 'https://wiki.example.test/api/',
      SSO_PROVIDER_NAME: 'Env IdP',
      SSO_OIDC_SCOPES: 'openid',
      SSO_LINK_BY_EMAIL: false,
      SSO_AUTO_PROVISION: false,
      SSO_TRUST_IDP_MFA: false,
      SSO_ASSUME_IDP_MFA: false,
      SSO_LOCAL_LOGIN: true,
      ...opts.env,
    },
  } as unknown as EnvService;
  const prisma = {
    ssoSetting: {
      findUnique: jest.fn(async () => (opts.row === undefined ? ROW : opts.row)),
    },
  };
  const crypto = {
    decrypt: jest.fn((blob: string, aad: string) => {
      if (opts.decryptFails) throw new Error('bad tag');
      expect(aad).toBe('sso-settings:singleton:client-secret');
      return `plain-of-${blob}`;
    }),
  };
  const svc = new SsoConfigService(
    env,
    prisma as unknown as PrismaService,
    crypto as unknown as IntegrationSecretEncryptionService,
  );
  return { svc, prisma, crypto };
}

describe('SsoConfigService: environment precedence', () => {
  const ENV_SET = {
    SSO_OIDC_ISSUER: ENV_ISSUER,
    SSO_OIDC_CLIENT_ID: 'env-client',
    SSO_OIDC_CLIENT_SECRET: 'env-secret-placeholder',
    SSO_ALLOWED_TENANT_ID: '99999999-2222-3333-4444-555555555555',
    SSO_LINK_BY_EMAIL: true,
    SSO_LOCAL_LOGIN: false,
  };

  it('uses the environment ENTIRELY when SSO_OIDC_ISSUER is set, ignoring a database row', async () => {
    const { svc, prisma } = make({ env: ENV_SET });
    const c = await svc.get();
    expect(c).toMatchObject({
      source: 'env',
      enabled: true,
      issuer: ENV_ISSUER,
      clientId: 'env-client',
      clientSecret: 'env-secret-placeholder',
      providerName: 'Env IdP',
      scopes: 'openid',
      allowedTenantId: '99999999-2222-3333-4444-555555555555',
      linkByEmail: true,
      autoProvision: false,
      trustIdpMfa: false,
      localLoginEnabled: false,
    });
    // Not a field-by-field merge: not one database value leaks in.
    expect(JSON.stringify(c)).not.toContain('db-client');
    expect(JSON.stringify(c)).not.toContain('Database IdP');
    expect(prisma.ssoSetting.findUnique).not.toHaveBeenCalled();
    expect(svc.envManaged).toBe(true);
  });

  it('keeps env behaviour identical to the old direct reads (SSO_LOCAL_LOGIN=false stays false)', async () => {
    const { svc } = make({ env: ENV_SET });
    expect((await svc.get()).localLoginEnabled).toBe(false);
  });

  it('is env-managed even when the database row says SSO is off', async () => {
    const { svc } = make({ env: ENV_SET, row: { ...ROW, enabled: false } });
    expect((await svc.get()).enabled).toBe(true);
  });

  it('uses the database when SSO_OIDC_ISSUER is unset', async () => {
    const { svc, prisma, crypto } = make();
    const c = await svc.get();
    expect(c).toMatchObject({
      source: 'database',
      enabled: true,
      issuer: DB_ISSUER,
      clientId: 'db-client',
      clientSecret: 'plain-of-cipher-1',
      providerName: 'Database IdP',
      linkByEmail: true,
      autoProvision: true,
      trustIdpMfa: true,
      assumeIdpMfa: true,
      localLoginEnabled: false,
    });
    expect(prisma.ssoSetting.findUnique).toHaveBeenCalledWith({ where: { id: SSO_SETTINGS_SINGLETON_ID } });
    expect(crypto.decrypt).toHaveBeenCalledTimes(1);
    expect(svc.envManaged).toBe(false);
  });

  it('assumeIdpMfa is only ever true together with trustIdpMfa (database)', async () => {
    const off = await make({ row: { ...ROW, trustIdpMfa: false, assumeIdpMfa: true } }).svc.get();
    expect(off).toMatchObject({ trustIdpMfa: false, assumeIdpMfa: false });
    const on = await make({ row: { ...ROW, trustIdpMfa: true, assumeIdpMfa: true } }).svc.get();
    expect(on).toMatchObject({ trustIdpMfa: true, assumeIdpMfa: true });
  });

  it('assumeIdpMfa is only ever true together with trustIdpMfa (environment)', async () => {
    const inert = await make({ env: { ...ENV_SET, SSO_TRUST_IDP_MFA: false, SSO_ASSUME_IDP_MFA: true } }).svc.get();
    expect(inert).toMatchObject({ trustIdpMfa: false, assumeIdpMfa: false });
    const live = await make({ env: { ...ENV_SET, SSO_TRUST_IDP_MFA: true, SSO_ASSUME_IDP_MFA: true } }).svc.get();
    expect(live).toMatchObject({ trustIdpMfa: true, assumeIdpMfa: true });
  });

  it('is off with the shipped defaults when there is no row', async () => {
    const { svc } = make({ row: null });
    expect(await svc.get()).toMatchObject({
      source: 'database',
      enabled: false,
      issuer: null,
      linkByEmail: false,
      autoProvision: false,
      trustIdpMfa: false,
      assumeIdpMfa: false,
      localLoginEnabled: true,
      scopes: 'openid profile email',
    });
  });

  it.each([
    ['switched off', { enabled: false }],
    ['no issuer', { issuer: null }],
    ['no client id', { clientId: null }],
    ['no secret', { clientSecretCiphertext: null }],
  ])('is not usable when %s, and then never refuses local login', async (_n, patch) => {
    const { svc } = make({ row: { ...ROW, ...patch } });
    const c = await svc.get();
    expect(c.enabled).toBe(false);
    expect(c.localLoginEnabled).toBe(true); // row says false; lock-out safety wins
  });

  it('treats an undecryptable secret as not configured, without throwing', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc } = make({ decryptFails: true });
    const c = await svc.get();
    expect(c.enabled).toBe(false);
    expect(c.clientSecret).toBeNull();
    expect(c.localLoginEnabled).toBe(true);
    warn.mockRestore();
  });
});

describe('SsoConfigService: caching', () => {
  afterEach(() => jest.useRealTimers());

  it('reads the database once within the TTL', async () => {
    const { svc, prisma } = make();
    await svc.get();
    await svc.get();
    expect(prisma.ssoSetting.findUnique).toHaveBeenCalledTimes(1);
  });

  it('re-reads after the TTL expires', async () => {
    jest.useFakeTimers();
    const { svc, prisma } = make();
    await svc.get();
    jest.advanceTimersByTime(SsoConfigService.CACHE_TTL_MS + 1);
    await svc.get();
    expect(prisma.ssoSetting.findUnique).toHaveBeenCalledTimes(2);
  });

  it('re-reads at once after invalidate()', async () => {
    const { svc, prisma } = make();
    await svc.get();
    svc.invalidate();
    await svc.get();
    expect(prisma.ssoSetting.findUnique).toHaveBeenCalledTimes(2);
  });
});

describe('SsoConfigService: helpers', () => {
  it('builds the callback URL from API_URL', () => {
    expect(make().svc.callbackUrl()).toBe('https://wiki.example.test/api/v1/auth/sso/callback');
  });

  it('lists the NAMES of SSO variables set in the environment, never values', () => {
    const saved: Record<string, string | undefined> = {};
    for (const k of SSO_ENV_KEYS) saved[k] = process.env[k];
    try {
      for (const k of SSO_ENV_KEYS) delete process.env[k];
      process.env.SSO_OIDC_ISSUER = ENV_ISSUER;
      process.env.SSO_OIDC_CLIENT_SECRET = 'not-a-real-secret';
      process.env.SSO_PROVIDER_NAME = '   ';
      const keys = make().svc.envKeysSet();
      expect(keys).toEqual(['SSO_OIDC_ISSUER', 'SSO_OIDC_CLIENT_SECRET']);
      expect(JSON.stringify(keys)).not.toContain('not-a-real-secret');
    } finally {
      for (const k of SSO_ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
