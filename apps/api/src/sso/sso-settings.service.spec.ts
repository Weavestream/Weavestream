import { BadRequestException, ConflictException } from '@nestjs/common';
import type { AuthedUser } from '../common/current-user.decorator.js';
import {
  resetEgressGuardForTests,
  setDefaultFetchForTests,
  setDefaultResolveForTests,
} from '../common/egress/safe-fetch.js';
import { SsoSettingsService } from './sso-settings.service.js';

const TENANT = '11111111-2222-3333-4444-555555555555';
const ISSUER = `https://login.example.test/${TENANT}/v2.0`;
const ACTOR = { id: 'admin-1' } as AuthedUser;
const META = { ip: '203.0.113.7', userAgent: 'jest' };
// Fictional placeholders (do not "fix" into real-looking credentials).
const SECRET_A = 'placeholder-secret-A';
const SECRET_B = 'placeholder-secret-B';

type Row = Record<string, unknown>;

const EMPTY: Row = {
  enabled: false,
  providerName: 'Single sign-on',
  issuer: null,
  clientId: null,
  clientSecretCiphertext: null,
  scopes: 'openid profile email',
  allowedTenantId: null,
  linkByEmail: false,
  autoProvision: false,
  trustIdpMfa: false,
  localLoginEnabled: true,
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  updatedBy: null,
};

const COMPLETE: Row = {
  ...EMPTY,
  enabled: true,
  issuer: ISSUER,
  clientId: 'client-id',
  clientSecretCiphertext: `enc(${SECRET_A})`,
};

function make(opts: { row?: Row | null; envManaged?: boolean; superAdmins?: number; envValues?: Row } = {}) {
  let state: Row | null = opts.row === undefined ? null : opts.row;
  const prisma = {
    ssoSetting: {
      findUnique: jest.fn(async () => state),
      upsert: jest.fn(async ({ create, update }: { create: Row; update: Row }) => {
        state = state ? { ...state, ...update, updatedAt: new Date() } : { ...create, updatedAt: new Date() };
        return state;
      }),
    },
    userIdentity: { count: jest.fn(async () => opts.superAdmins ?? 0) },
  };
  const audit = { log: jest.fn(async () => undefined) };
  const crypto = { encrypt: jest.fn((v: string) => `enc(${v})`) };
  const config = {
    envManaged: opts.envManaged ?? false,
    envKeysSet: jest.fn(() => (opts.envManaged ? ['SSO_OIDC_ISSUER', 'SSO_OIDC_CLIENT_SECRET'] : [])),
    callbackUrl: jest.fn(() => 'https://wiki.example.test/api/v1/auth/sso/callback'),
    invalidate: jest.fn(),
    get: jest.fn(async () => ({
      source: opts.envManaged ? 'env' : 'database',
      enabled: true,
      providerName: 'Env IdP',
      issuer: ISSUER,
      clientId: 'env-client',
      clientSecret: 'env-secret-placeholder',
      scopes: 'openid',
      allowedTenantId: undefined,
      linkByEmail: false,
      autoProvision: false,
      trustIdpMfa: false,
      localLoginEnabled: true,
      ...opts.envValues,
    })),
  };
  const svc = new SsoSettingsService(prisma as never, audit as never, crypto as never, config as never);
  return { svc, prisma, audit, crypto, config, row: () => state };
}

const auditAfter = (m: ReturnType<typeof make>) =>
  (m.audit.log.mock.calls as unknown as Array<[{ action: string; after: Row }]>)[0]![0];

describe('SsoSettingsService.get', () => {
  it('returns defaults (SSO off) when nothing is saved, as the database source', async () => {
    const dto = await make().svc.get();
    expect(dto).toMatchObject({
      source: 'database',
      enabled: false,
      clientSecretSet: false,
      issuer: null,
      callbackUrl: 'https://wiki.example.test/api/v1/auth/sso/callback',
    });
  });

  it('reports clientSecretSet but never the secret or the ciphertext', async () => {
    const dto = await make({ row: COMPLETE }).svc.get();
    expect(dto.clientSecretSet).toBe(true);
    const json = JSON.stringify(dto);
    expect(json).not.toContain(SECRET_A);
    expect(json).not.toContain('enc(');
    expect(Object.keys(dto)).not.toContain('clientSecret');
  });

  it('in env mode reports source env, the env key NAMES, and no secret', async () => {
    const dto = await make({ envManaged: true, row: COMPLETE }).svc.get();
    expect(dto).toMatchObject({
      source: 'env',
      envKeysSet: ['SSO_OIDC_ISSUER', 'SSO_OIDC_CLIENT_SECRET'],
      clientSecretSet: true,
      clientId: 'env-client',
    });
    expect(JSON.stringify(dto)).not.toContain('env-secret-placeholder');
  });
});

describe('SsoSettingsService.update', () => {
  it('refuses to write while the environment manages SSO (409), touching nothing', async () => {
    const m = make({ envManaged: true });
    await expect(m.svc.update(ACTOR, { enabled: false }, META)).rejects.toBeInstanceOf(ConflictException);
    expect(m.prisma.ssoSetting.upsert).not.toHaveBeenCalled();
    expect(m.audit.log).not.toHaveBeenCalled();
  });

  it('saves a complete configuration, encrypting the secret, then invalidates the cache', async () => {
    const m = make();
    const dto = await m.svc.update(
      ACTOR,
      { enabled: true, issuer: ISSUER, clientId: 'client-id', clientSecret: SECRET_A, allowedTenantId: TENANT },
      META,
    );
    expect(m.crypto.encrypt).toHaveBeenCalledWith(SECRET_A, 'sso-settings:singleton:client-secret');
    expect(m.row()).toMatchObject({ clientSecretCiphertext: `enc(${SECRET_A})`, updatedBy: 'admin-1' });
    expect(m.config.invalidate).toHaveBeenCalled();
    expect(dto).toMatchObject({ enabled: true, clientSecretSet: true });
    expect(JSON.stringify(dto)).not.toContain(SECRET_A);
  });

  it('keeps the stored secret when clientSecret is omitted', async () => {
    const m = make({ row: COMPLETE });
    await m.svc.update(ACTOR, { providerName: 'Contoso' }, META);
    expect(m.crypto.encrypt).not.toHaveBeenCalled();
    expect(m.row()?.['clientSecretCiphertext']).toBe(`enc(${SECRET_A})`);
    expect(auditAfter(m).after).toEqual({ changedFields: ['providerName'], clientSecret: 'unchanged' });
  });

  it('replaces the secret when a new one is sent', async () => {
    const m = make({ row: COMPLETE });
    await m.svc.update(ACTOR, { clientSecret: SECRET_B }, META);
    expect(m.row()?.['clientSecretCiphertext']).toBe(`enc(${SECRET_B})`);
    expect(auditAfter(m).after).toEqual({ changedFields: ['clientSecret'], clientSecret: 'set' });
  });

  it('clears the secret on an explicit clear, and a draft (not enabled) may then be saved', async () => {
    const m = make({ row: COMPLETE });
    await m.svc.update(ACTOR, { enabled: false, clearClientSecret: true }, META);
    expect(m.row()?.['clientSecretCiphertext']).toBeNull();
    expect(auditAfter(m).after).toMatchObject({ clientSecret: 'cleared' });
  });

  it('refuses clearing the secret while SSO stays enabled', async () => {
    const m = make({ row: COMPLETE });
    await expect(m.svc.update(ACTOR, { clearClientSecret: true }, META)).rejects.toThrow(/Client secret is required/);
    expect(m.prisma.ssoSetting.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['missing issuer', { enabled: true, clientId: 'c', clientSecret: SECRET_A }, /Issuer URL must be an absolute URL/],
    ['missing client id', { enabled: true, issuer: ISSUER, clientSecret: SECRET_A }, /Client ID is required/],
    ['missing secret', { enabled: true, issuer: ISSUER, clientId: 'c' }, /Client secret is required/],
    ['http issuer', { enabled: true, issuer: 'http://idp.example.test', clientId: 'c', clientSecret: SECRET_A }, /must use https/],
    ['/common issuer', { enabled: true, issuer: 'https://login.microsoftonline.com/common/v2.0', clientId: 'c', clientSecret: SECRET_A }, /multi-tenant/],
    ['/organizations issuer', { enabled: true, issuer: 'https://login.microsoftonline.com/organizations/v2.0', clientId: 'c', clientSecret: SECRET_A }, /multi-tenant/],
    ['/consumers issuer', { enabled: true, issuer: 'https://login.microsoftonline.com/consumers/v2.0', clientId: 'c', clientSecret: SECRET_A }, /multi-tenant/],
    ['consumers tenant GUID', { enabled: true, issuer: 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0', clientId: 'c', clientSecret: SECRET_A }, /multi-tenant/],
    ['bad tenant id', { enabled: true, issuer: ISSUER, clientId: 'c', clientSecret: SECRET_A, allowedTenantId: 'contoso' }, /Allowed tenant ID must be a tenant id/],
  ])('refuses enabling with %s (400)', async (_n, input, message) => {
    const m = make();
    const err = await m.svc.update(ACTOR, input as never, META).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(message);
    expect(m.prisma.ssoSetting.upsert).not.toHaveBeenCalled();
    expect(m.audit.log).not.toHaveBeenCalled();
  });

  it('allows an incomplete draft while SSO is off, but still refuses a bad issuer in it', async () => {
    const ok = make();
    await expect(ok.svc.update(ACTOR, { providerName: 'Contoso' }, META)).resolves.toBeDefined();
    const bad = make();
    await expect(bad.svc.update(ACTOR, { issuer: 'http://idp.example.test' }, META)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  describe('lock-out guard', () => {
    it('refuses localLoginEnabled=false with no linked active SUPER_ADMIN at the issuer (409)', async () => {
      const m = make({ row: COMPLETE, superAdmins: 0 });
      const err = await m.svc.update(ACTOR, { localLoginEnabled: false }, META).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as Error).message).toMatch(/no active super admin has linked/);
      expect(m.prisma.userIdentity.count).toHaveBeenCalledWith({
        where: { issuer: ISSUER, user: { role: 'SUPER_ADMIN', isActive: true } },
      });
      expect(m.prisma.ssoSetting.upsert).not.toHaveBeenCalled();
    });

    it('allows it once an active SUPER_ADMIN is linked at that issuer', async () => {
      const m = make({ row: COMPLETE, superAdmins: 1 });
      await m.svc.update(ACTOR, { localLoginEnabled: false }, META);
      expect(m.row()?.['localLoginEnabled']).toBe(false);
    });

    it('also guards a change of issuer while local login is already off', async () => {
      const m = make({ row: { ...COMPLETE, localLoginEnabled: false }, superAdmins: 0 });
      await expect(
        m.svc.update(ACTOR, { issuer: `https://login.example.test/${TENANT.replace('1111', '2222')}/v2.0` }, META),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('does not apply while SSO is off (password login cannot be refused then)', async () => {
      const m = make({ row: EMPTY, superAdmins: 0 });
      await m.svc.update(ACTOR, { localLoginEnabled: false }, META);
      expect(m.prisma.userIdentity.count).not.toHaveBeenCalled();
    });

    it('is not consulted when local login stays on', async () => {
      const m = make({ row: COMPLETE, superAdmins: 0 });
      await m.svc.update(ACTOR, { providerName: 'Contoso' }, META);
      expect(m.prisma.userIdentity.count).not.toHaveBeenCalled();
    });
  });

  describe('audit', () => {
    it('records settings.sso.change with field NAMES only, never values or the secret', async () => {
      const m = make();
      await m.svc.update(
        ACTOR,
        { enabled: true, issuer: ISSUER, clientId: 'client-id-value', clientSecret: SECRET_A, scopes: 'openid email' },
        META,
      );
      const entry = auditAfter(m);
      expect(entry.action).toBe('settings.sso.change');
      expect(entry.after).toEqual({
        changedFields: ['enabled', 'issuer', 'clientId', 'scopes', 'clientSecret'],
        clientSecret: 'set',
      });
      const json = JSON.stringify(m.audit.log.mock.calls);
      for (const leaked of [SECRET_A, 'client-id-value', ISSUER, 'openid email', `enc(${SECRET_A})`]) {
        expect(json).not.toContain(leaked);
      }
      expect(m.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ actorId: 'admin-1', entityType: 'SsoSetting', ip: META.ip, userAgent: META.userAgent }),
      );
    });

    it('lists only fields that actually changed', async () => {
      const m = make({ row: COMPLETE });
      await m.svc.update(ACTOR, { enabled: true, providerName: 'Contoso' }, META);
      expect(auditAfter(m).after).toMatchObject({ changedFields: ['providerName'] });
    });
  });
});

describe('SsoSettingsService.test', () => {
  const DISCOVERY = {
    issuer: ISSUER,
    authorization_endpoint: 'https://login.example.test/authorize',
    token_endpoint: 'https://login.example.test/token',
    jwks_uri: 'https://login.example.test/keys',
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const calls: string[] = [];
  function scripted(routes: Record<string, () => Response>) {
    calls.length = 0;
    setDefaultResolveForTests(async () => ['93.184.216.34']);
    setDefaultFetchForTests((async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      const hit = Object.entries(routes).find(([suffix]) => url.endsWith(suffix));
      if (!hit) throw new Error(`unexpected fetch ${url}`);
      return hit[1]();
    }) as typeof fetch);
  }
  afterEach(() => resetEgressGuardForTests());

  it('reports the endpoints found, issuer match, jwks reachable, and shows (not checks) the callback URL', async () => {
    scripted({
      '/.well-known/openid-configuration': () => json(DISCOVERY),
      '/keys': () => json({ keys: [{ kid: 'k1' }] }),
    });
    const m = make();
    const r = await m.svc.test(ACTOR, META, { issuer: ISSUER });
    expect(r).toMatchObject({
      ok: true,
      issuer: ISSUER,
      discoveryReachable: true,
      issuerMatches: true,
      authorizationEndpoint: DISCOVERY.authorization_endpoint,
      tokenEndpoint: DISCOVERY.token_endpoint,
      jwksUri: DISCOVERY.jwks_uri,
      jwksReachable: true,
      callbackUrl: 'https://wiki.example.test/api/v1/auth/sso/callback',
    });
    expect(calls[0]).toBe(`${ISSUER}/.well-known/openid-configuration`);
  });

  it('tests the saved issuer when none is supplied', async () => {
    scripted({
      '/.well-known/openid-configuration': () => json(DISCOVERY),
      '/keys': () => json({ keys: [{}] }),
    });
    const r = await make({ row: COMPLETE }).svc.test(ACTOR, META, {});
    expect(r.ok).toBe(true);
  });

  it('fails when the discovery document names a different issuer', async () => {
    scripted({ '/.well-known/openid-configuration': () => json({ ...DISCOVERY, issuer: 'https://evil.example.test/' }) });
    const r = await make().svc.test(ACTOR, META, { issuer: ISSUER });
    expect(r).toMatchObject({ ok: false, issuerMatches: false, discoveryReachable: true });
    expect(r.message).toMatch(/different issuer/);
  });

  it('fails when the key set is unreachable', async () => {
    scripted({
      '/.well-known/openid-configuration': () => json(DISCOVERY),
      '/keys': () => json({}, 500),
    });
    const r = await make().svc.test(ACTOR, META, { issuer: ISSUER });
    expect(r).toMatchObject({ ok: false, issuerMatches: true, jwksReachable: false });
  });

  it('fails clearly on a non-OIDC answer and on an HTTP error', async () => {
    scripted({ '/.well-known/openid-configuration': () => json({ hello: 'world' }) });
    expect((await make().svc.test(ACTOR, META, { issuer: ISSUER })).message).toMatch(/did not return an OpenID/);
    scripted({ '/.well-known/openid-configuration': () => json({}, 404) });
    expect((await make().svc.test(ACTOR, META, { issuer: ISSUER })).message).toMatch(/HTTP 404/);
  });

  it.each([
    ['loopback', '127.0.0.1'],
    ['RFC1918', '10.0.0.5'],
    ['link-local / cloud metadata', '169.254.169.254'],
    ['IPv6 loopback', '::1'],
  ])('refuses an issuer that resolves to %s (SSRF) and never fetches', async (_n, ip) => {
    const fetchSpy = jest.fn();
    setDefaultResolveForTests(async () => [ip]);
    setDefaultFetchForTests(fetchSpy as never);
    const r = await make().svc.test(ACTOR, META, { issuer: ISSUER });
    expect(r.ok).toBe(false);
    expect(r.discoveryReachable).toBe(false);
    expect(r.message).toMatch(/not allowed/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses an issuer given as a private IP literal', async () => {
    const fetchSpy = jest.fn();
    setDefaultFetchForTests(fetchSpy as never);
    const r = await make().svc.test(ACTOR, META, { issuer: 'https://169.254.169.254/latest' });
    expect(r.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('applies the shared issuer rules before any request (400)', async () => {
    const fetchSpy = jest.fn();
    setDefaultFetchForTests(fetchSpy as never);
    const m = make();
    await expect(m.svc.test(ACTOR, META, { issuer: 'http://idp.example.test' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      m.svc.test(ACTOR, META, { issuer: 'https://login.microsoftonline.com/common/v2.0' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('asks for an issuer when none is saved or supplied', async () => {
    const m = make({ envValues: { issuer: null } });
    await expect(m.svc.test(ACTOR, META, {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('in env mode tests the env issuer and refuses a supplied one', async () => {
    const m = make({ envManaged: true });
    await expect(m.svc.test(ACTOR, META, { issuer: ISSUER })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('audits the outcome flags and the issuer HOST only', async () => {
    scripted({
      '/.well-known/openid-configuration': () => json(DISCOVERY),
      '/keys': () => json({ keys: [{}] }),
    });
    const m = make();
    await m.svc.test(ACTOR, META, { issuer: ISSUER });
    const entry = auditAfter(m);
    expect(entry.action).toBe('settings.sso.test');
    expect(entry.after).toEqual({
      issuerHost: 'login.example.test',
      ok: true,
      discoveryReachable: true,
      issuerMatches: true,
      jwksReachable: true,
      overrideUsed: true,
    });
    expect(JSON.stringify(m.audit.log.mock.calls)).not.toContain(TENANT);
  });
});
