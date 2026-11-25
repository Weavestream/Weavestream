import { createHash } from 'node:crypto';
import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import type { EnvService } from '../config/env.service.js';
import { IdTokenError, type VerifiedIdToken } from './id-token.js';
import { fakeSsoConfig } from './sso-config.fake.js';
import { SsoProviderError } from './sso-oidc.service.js';
import { SsoService, STEP_UP_MAX_AUTH_AGE_SEC, type SsoCallbackOutcome } from './sso.service.js';

const ISSUER = 'https://login.microsoftonline.com/tenant-1/v2.0';
const OTHER_ISSUER = 'https://idp.example.test/realms/main';
const META = { ip: '203.0.113.7', userAgent: 'jest' };
const CODE = 'authorization-code-should-not-be-audited';
const ID_TOKEN = 'header.payload.signature-should-not-be-audited';

type Row = Record<string, unknown>;

const USER: Row = {
  id: 'u-1',
  email: 'alice@example.test',
  name: 'Alice',
  role: 'OPERATOR',
  isActive: true,
  platformCapabilities: [],
  passwordHash: 'argon2-hash',
  mfaEnabled: false,
  mfaEnforcementCompletedAt: null,
  uiTheme: 'SYSTEM',
  uiAccent: 'LIME',
  showItemCounts: true,
};

const CLAIMS: VerifiedIdToken = {
  issuer: ISSUER,
  sub: 'sub-pairwise',
  oid: 'oid-1',
  tid: 'tenant-1',
  email: 'Alice@Example.test',
  emailVerified: true,
  emailDomainOwnerVerified: false,
  name: 'Alice A',
  amr: ['pwd'],
};

interface Opts {
  env?: Record<string, unknown>;
  issuer?: string;
  failSuccessAudit?: boolean;
  taken?: { id: string; userId: string } | null;
  userRow?: Row | null;
  stepUpVerified?: boolean;
  mine?: Row | null;
  claims?: Partial<VerifiedIdToken>;
  linked?: Row | null;
  byEmail?: Row | null;
  otherIdentity?: Row | null;
  session?: Row | null;
  stepUpIdentity?: { userId: string } | null;
}

function make(opts: Opts = {}) {
  const env = {
    values: {
      APP_URL: 'https://wiki.example.test',
      SSO_PROVIDER_NAME: 'Contoso',
      SSO_LOCAL_LOGIN: true,
      SSO_LINK_BY_EMAIL: true, // the shipped default is false; linking tests opt in
      SSO_AUTO_PROVISION: false,
      SSO_TRUST_IDP_MFA: false,
      ...opts.env,
    },
  } as unknown as EnvService;

  const tx = {
    user: { create: jest.fn(async ({ data }: { data: Row }) => ({ ...USER, ...data, id: 'u-new', passwordHash: null })) },
    userIdentity: { create: jest.fn(async () => ({ id: 'i-new' })) },
  };
  const prisma = {
    userIdentity: {
      findUnique: jest.fn(async (args: { select?: Row }) => {
        if (args.select && 'id' in args.select) return opts.taken ?? null; // link flow
        return args.select ? (opts.stepUpIdentity ?? null) : (opts.linked ?? null);
      }),
      findFirst: jest.fn(async () => opts.otherIdentity ?? opts.mine ?? null),
      delete: jest.fn(async () => ({})),
      create: jest.fn(async () => ({ id: 'i-linked' })),
      update: jest.fn(async () => ({})),
    },
    user: {
      findUnique: jest.fn(async (args: { where: { email?: string; id?: string }; select?: Row }) => {
        if (args.where.email) return opts.byEmail ?? null;
        if (args.select && 'passwordHash' in args.select) {
          return opts.userRow === undefined ? { passwordHash: 'h', role: 'OPERATOR' } : opts.userRow;
        }
        return { isActive: true };
      }),
    },
    session: {
      updateMany: jest.fn(async () => ({ count: 1 })),
      findUnique: jest.fn(async () =>
        opts.session === undefined
          ? {
              id: 's-1',
              userId: 'u-1',
              revokedAt: null,
              expiresAt: new Date(Date.now() + 3_600_000),
              authMethod: 'sso',
              mfaPending: false,
            }
          : opts.session,
      ),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };

  const claims: VerifiedIdToken = { ...CLAIMS, ...opts.claims };
  const oidc = {
    enabled: jest.fn(async () => true),
    issuer: jest.fn(async () => opts.issuer ?? ISSUER),
    issuerHost: jest.fn(async () => new URL(opts.issuer ?? ISSUER).host),
    authorizationUrl: jest.fn(async (_params: Row) => 'https://login.example.test/authorize?x=1'),
    exchangeCode: jest.fn(async () => ID_TOKEN),
    verifyIdToken: jest.fn(async () => claims),
  };
  const login = { accessToken: 'a', refreshToken: 'r', user: { id: 'u-1' } };
  const auth = {
    issueSession: jest.fn(async (_u: Row, o: { idpMfa: boolean }) => ({
      result: login,
      sessionId: 's-new',
      mfaChallengeRequired: false,
      mfaSetupRequired: !o.idpMfa,
    })),
  };
  const stepUp = {
    markVerified: jest.fn(async () => undefined),
    isVerified: jest.fn(async () => opts.stepUpVerified ?? true),
  };
  const audit = {
    log: jest.fn(async (entry: Row) => {
      if (opts.failSuccessAudit && entry['action'] === 'auth.sso.login.success') {
        throw new Error('audit down');
      }
    }),
  };

  const svc = new SsoService(
    prisma as never,
    env,
    oidc as never,
    fakeSsoConfig(env.values as Record<string, unknown>),
    auth as never,
    stepUp as never,
    audit as never,
  );
  return { svc, prisma, tx, oidc, auth, stepUp, audit, login };
}

type Made = ReturnType<typeof make>;

/** Start a flow and return the cookie plus the state it carries. */
async function start(m: Made, stepUp?: { userId: string; sessionId: string }) {
  const { flowCookie } = await m.svc.begin(stepUp);
  return { flowCookie, flow: JSON.parse(flowCookie) as { s: string; n: string; v: string; t: number } };
}

async function callback(
  m: Made,
  over: Partial<Parameters<SsoService['complete']>[0]> = {},
  stepUp?: { userId: string; sessionId: string },
): Promise<SsoCallbackOutcome> {
  const { flowCookie, flow } = await start(m, stepUp);
  return m.svc.complete({
    flowCookie,
    code: CODE,
    state: flow.s,
    idpError: undefined,
    meta: META,
    ...over,
  });
}

const failureAudit = (m: Made) =>
  m.audit.log.mock.calls.map((c) => c[0] as Row).find((r) => r['action'] === 'auth.sso.login.failure');

describe('SsoService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('config', () => {
    it('exposes only enabled, providerName and localLoginEnabled', async () => {
      const m = make({ env: { SSO_LOCAL_LOGIN: false } });
      expect(await m.svc.config()).toEqual({
        enabled: true,
        providerName: 'Contoso',
        localLoginEnabled: false,
      });
    });
  });

  describe('begin', () => {
    it('puts state, nonce and the PKCE verifier in the flow cookie, and only the challenge in the URL request', async () => {
      const m = make();
      const { flow } = await start(m);
      expect(flow.s).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(flow.n).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(flow.v).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const arg = m.oidc.authorizationUrl.mock.calls[0]![0] as Row;
      expect(arg).toMatchObject({ state: flow.s, nonce: flow.n, reauthenticate: false });
      expect(JSON.stringify(arg)).not.toContain(flow.v);
    });

    it('binds a step-up flow to the user and session and forces re-authentication', async () => {
      const m = make();
      const { flowCookie } = await start(m, { userId: 'u-1', sessionId: 's-1' });
      expect(JSON.parse(flowCookie)).toMatchObject({ p: 'stepup', u: 'u-1', sid: 's-1' });
      expect(m.oidc.authorizationUrl.mock.calls[0]![0]).toMatchObject({ reauthenticate: true });
    });
  });

  describe('login: existing link', () => {
    it('signs in the linked user through AuthService.issueSession as an sso session', async () => {
      const m = make({ linked: { id: 'i-1', user: USER } });
      const out = await callback(m);
      expect(out).toEqual({
        ok: true,
        kind: 'login',
        login: m.login,
        mfaSetupRequired: true,
        mfaChallengeRequired: false,
      });

      expect(m.prisma.userIdentity.findUnique).toHaveBeenCalledWith({
        where: { issuer_subject: { issuer: ISSUER, subject: 'oid-1' } },
        include: { user: true },
      });
      expect(m.auth.issueSession).toHaveBeenCalledWith(USER, {
        ip: META.ip,
        userAgent: META.userAgent,
        authMethod: 'sso',
        idpMfa: false,
      });
      expect(m.prisma.userIdentity.update).toHaveBeenCalled();
      expect(m.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.sso.login.success',
          actorId: 'u-1',
          entityType: 'Session',
          entityId: 's-new',
        }),
      );
      // The user was found by the link, so email was never consulted.
      expect(m.prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('uses sub as the subject for a non-Entra issuer, ignoring any oid', async () => {
      const m = make({ issuer: OTHER_ISSUER, linked: { id: 'i-1', user: USER } });
      await callback(m);
      expect(m.prisma.userIdentity.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { issuer_subject: { issuer: OTHER_ISSUER, subject: 'sub-pairwise' } },
        }),
      );
    });

    it('refuses an Entra token without oid, so the subject cannot flip to sub', async () => {
      const m = make({ claims: { oid: undefined }, linked: { id: 'i-1', user: USER } });
      expect(await callback(m)).toEqual({ ok: false, code: 'failed' });
      expect(m.prisma.userIdentity.findUnique).not.toHaveBeenCalled();
      expect(m.auth.issueSession).not.toHaveBeenCalled();
      expect(failureAudit(m)).toMatchObject({ after: { reason: 'missing_oid' } });
    });

    it('refuses an inactive linked user with not_allowed and issues no session', async () => {
      const m = make({ linked: { id: 'i-1', user: { ...USER, isActive: false } } });
      expect(await callback(m)).toEqual({ ok: false, code: 'not_allowed' });
      expect(m.auth.issueSession).not.toHaveBeenCalled();
      expect(failureAudit(m)).toMatchObject({
        actorId: 'u-1',
        after: { reason: 'inactive_user', purpose: 'login' },
      });
    });
  });

  describe('login: first sign-in by email', () => {
    it('links an existing active user whose email matches (case-insensitively) and audits the link', async () => {
      const m = make({ byEmail: USER });
      const out = await callback(m);
      expect(out.ok).toBe(true);

      expect(m.prisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'alice@example.test' },
      });
      expect(m.prisma.userIdentity.create).toHaveBeenCalledWith({
        data: { userId: 'u-1', issuer: ISSUER, subject: 'oid-1', email: 'alice@example.test' },
      });
      expect(m.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.sso.link',
          actorId: 'u-1',
          after: expect.objectContaining({ via: 'email', identityId: 'i-linked' }),
        }),
      );
    });

    it('never matches on preferred_username: no email claim means nothing to match', async () => {
      const m = make({
        claims: { email: undefined, ...({ preferredUsername: 'alice@example.test' } as object) },
        byEmail: USER,
      });
      expect(await callback(m)).toEqual({ ok: false, code: 'no_account' });
      expect(m.prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it.each([
      ['email_verified true', { emailVerified: true, emailDomainOwnerVerified: false }],
      ['Entra xms_edov true', { emailVerified: false, emailDomainOwnerVerified: true }],
    ])('links when the email is verified by %s', async (_n, claims) => {
      const m = make({ claims, byEmail: USER });
      expect((await callback(m)).ok).toBe(true);
      expect(m.prisma.userIdentity.create).toHaveBeenCalled();
    });

    it('does not link when neither verification claim is present (absent is not verified)', async () => {
      const m = make({
        claims: { emailVerified: false, emailDomainOwnerVerified: false },
        byEmail: USER,
      });
      expect(await callback(m)).toEqual({ ok: false, code: 'no_account' });
      expect(failureAudit(m)).toMatchObject({ after: { reason: 'email_unverified' } });
      expect(m.prisma.userIdentity.create).not.toHaveBeenCalled();
      expect(m.auth.issueSession).not.toHaveBeenCalled();
    });

    it.each([
      ['a SUPER_ADMIN', { role: 'SUPER_ADMIN' }],
      ['an account with platform capabilities', { platformCapabilities: ['USER_MANAGE'] }],
    ])('never auto-links %s, and audits the refusal', async (_n, patch) => {
      const m = make({ byEmail: { ...USER, ...patch } });
      expect(await callback(m)).toEqual({ ok: false, code: 'not_allowed' });
      expect(failureAudit(m)).toMatchObject({
        actorId: 'u-1',
        after: { reason: 'privileged_account' },
      });
      expect(m.prisma.userIdentity.create).not.toHaveBeenCalled();
      expect(m.auth.issueSession).not.toHaveBeenCalled();
    });

    it('still signs in an already-linked SUPER_ADMIN (the rule is about auto-linking only)', async () => {
      const m = make({ linked: { id: 'i-1', user: { ...USER, role: 'SUPER_ADMIN' } } });
      expect((await callback(m)).ok).toBe(true);
    });

    it('refuses an inactive user', async () => {
      const m = make({ byEmail: { ...USER, isActive: false } });
      expect(await callback(m)).toEqual({ ok: false, code: 'not_allowed' });
      expect(m.prisma.userIdentity.create).not.toHaveBeenCalled();
    });

    it('refuses an invite-pending user (no password set yet)', async () => {
      const m = make({ byEmail: { ...USER, passwordHash: null } });
      expect(await callback(m)).toEqual({ ok: false, code: 'not_allowed' });
      expect(failureAudit(m)).toMatchObject({ after: { reason: 'pending_invite' } });
      expect(m.prisma.userIdentity.create).not.toHaveBeenCalled();
    });

    it('refuses when SSO_LINK_BY_EMAIL=false, even with a matching active user', async () => {
      const m = make({ env: { SSO_LINK_BY_EMAIL: false }, byEmail: USER });
      expect(await callback(m)).toEqual({ ok: false, code: 'no_account' });
      expect(m.prisma.userIdentity.create).not.toHaveBeenCalled();
      expect(m.auth.issueSession).not.toHaveBeenCalled();
    });

    it('does not provision over an existing user when linking is off', async () => {
      const m = make({
        env: { SSO_LINK_BY_EMAIL: false, SSO_AUTO_PROVISION: true },
        byEmail: USER,
      });
      expect(await callback(m)).toEqual({ ok: false, code: 'no_account' });
      expect(m.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses to add a second identity at the same issuer to an already-linked user', async () => {
      const m = make({ byEmail: USER, otherIdentity: { id: 'i-other' } });
      expect(await callback(m)).toEqual({ ok: false, code: 'not_allowed' });
      expect(failureAudit(m)).toMatchObject({ after: { reason: 'already_linked' } });
      expect(m.prisma.userIdentity.create).not.toHaveBeenCalled();
    });

    it('has nothing to match on without an email-shaped claim', async () => {
      const m = make({ claims: { email: 'not-an-address' }, byEmail: USER });
      expect(await callback(m)).toEqual({ ok: false, code: 'no_account' });
      expect(m.prisma.user.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('login: auto-provision', () => {
    it('is off by default: no matching user gives no_account', async () => {
      const m = make();
      expect(await callback(m)).toEqual({ ok: false, code: 'no_account' });
      expect(m.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('creates an OPERATOR with globalAccess NONE, no password, no memberships', async () => {
      const m = make({ env: { SSO_AUTO_PROVISION: true } });
      const out = await callback(m);
      expect(out.ok).toBe(true);

      expect(m.tx.user.create).toHaveBeenCalledWith({
        data: {
          email: 'alice@example.test',
          name: 'Alice A',
          role: 'OPERATOR',
          globalAccess: 'NONE',
          platformCapabilities: [],
          passwordHash: null,
          mfaEnabled: false,
          mfaEnforcementCompletedAt: null,
        },
      });
      expect(m.tx.userIdentity.create).toHaveBeenCalledWith({
        data: { userId: 'u-new', issuer: ISSUER, subject: 'oid-1', email: 'alice@example.test' },
      });
      expect(m.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.sso.provision',
          actorId: 'u-new',
          after: expect.objectContaining({ role: 'OPERATOR', globalAccess: 'NONE' }),
        }),
      );
      expect(m.auth.issueSession).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'u-new' }),
        expect.objectContaining({ authMethod: 'sso' }),
      );
    });

    it('names a user from the address when the token has no name', async () => {
      const m = make({ env: { SSO_AUTO_PROVISION: true }, claims: { name: undefined } });
      await callback(m);
      expect(m.tx.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ name: 'alice' }),
      });
    });

    it('cannot provision without an email', async () => {
      const m = make({
        env: { SSO_AUTO_PROVISION: true },
        claims: { email: undefined },
      });
      expect(await callback(m)).toEqual({ ok: false, code: 'no_account' });
      expect(m.prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('MFA from the identity provider (amr)', () => {
    const linked = { id: 'i-1', user: USER };

    it('with SSO_TRUST_IDP_MFA on and amr containing mfa, the session is idpMfa', async () => {
      const m = make({ env: { SSO_TRUST_IDP_MFA: true }, claims: { amr: ['pwd', 'mfa'] }, linked });
      await callback(m);
      expect(m.auth.issueSession).toHaveBeenCalledWith(
        USER,
        expect.objectContaining({ idpMfa: true }),
      );
      expect(m.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.sso.login.success',
          after: expect.objectContaining({ idpMfa: true }),
        }),
      );
    });

    it.each([
      ['trusted mfa amr', { SSO_TRUST_IDP_MFA: true }, ['pwd', 'mfa'], true, true],
      ['mfa amr, trust off', { SSO_TRUST_IDP_MFA: false }, ['mfa'], true, false],
      ['amr without mfa', { SSO_TRUST_IDP_MFA: true }, ['pwd'], true, false],
      ['no amr at all', { SSO_TRUST_IDP_MFA: true }, [], false, false],
    ])('audits amrPresent / idpMfaAsserted diagnostics: %s', async (_n, env, amr, amrPresent, asserted) => {
      const m = make({ env, claims: { amr }, linked });
      await callback(m);
      const row = m.audit.log.mock.calls
        .map((c: unknown[]) => c[0] as { action: string; after: Record<string, unknown> })
        .find((r) => r.action === 'auth.sso.login.success')!;
      expect(row.after).toMatchObject({ amrPresent, idpMfaAsserted: asserted });
      // Booleans only: the claim values themselves are not recorded.
      expect(JSON.stringify(row.after)).not.toContain('pwd');
    });

    it('with SSO_TRUST_IDP_MFA off, an mfa amr is ignored', async () => {
      const m = make({ env: { SSO_TRUST_IDP_MFA: false }, claims: { amr: ['mfa'] }, linked });
      await callback(m);
      expect(m.auth.issueSession).toHaveBeenCalledWith(
        USER,
        expect.objectContaining({ idpMfa: false }),
      );
    });

    it('with SSO_TRUST_IDP_MFA on but no mfa in amr, normal TOTP rules apply', async () => {
      const m = make({ env: { SSO_TRUST_IDP_MFA: true }, claims: { amr: ['pwd'] }, linked });
      await callback(m);
      expect(m.auth.issueSession).toHaveBeenCalledWith(
        USER,
        expect.objectContaining({ idpMfa: false }),
      );
    });

    describe('SSO_ASSUME_IDP_MFA', () => {
      it.each([
        ['assume + trust, no amr at all', { SSO_TRUST_IDP_MFA: true, SSO_ASSUME_IDP_MFA: true }, [], true],
        ['assume + trust, amr without mfa', { SSO_TRUST_IDP_MFA: true, SSO_ASSUME_IDP_MFA: true }, ['pwd'], true],
        ['assume + trust, amr with mfa', { SSO_TRUST_IDP_MFA: true, SSO_ASSUME_IDP_MFA: true }, ['mfa'], true],
        ['assume but trust off, no amr', { SSO_TRUST_IDP_MFA: false, SSO_ASSUME_IDP_MFA: true }, [], false],
        ['assume but trust off, mfa amr', { SSO_TRUST_IDP_MFA: false, SSO_ASSUME_IDP_MFA: true }, ['mfa'], false],
        ['assume off, trust on, no amr', { SSO_TRUST_IDP_MFA: true, SSO_ASSUME_IDP_MFA: false }, [], false],
        ['assume off, trust on, mfa amr', { SSO_TRUST_IDP_MFA: true, SSO_ASSUME_IDP_MFA: false }, ['mfa'], true],
      ])('%s', async (_n, env, amr, expected) => {
        const m = make({ env, claims: { amr }, linked });
        await callback(m);
        expect(m.auth.issueSession).toHaveBeenCalledWith(
          USER,
          expect.objectContaining({ idpMfa: expected }),
        );
      });

      it('audits assumeIdpMfa (the resolved config value) next to the amr diagnostics', async () => {
        const m = make({ env: { SSO_TRUST_IDP_MFA: true, SSO_ASSUME_IDP_MFA: true }, claims: { amr: [] }, linked });
        await callback(m);
        const row = m.audit.log.mock.calls
          .map((c: unknown[]) => c[0] as { action: string; after: Record<string, unknown> })
          .find((r) => r.action === 'auth.sso.login.success')!;
        expect(row.after).toMatchObject({ amrPresent: false, idpMfaAsserted: true, assumeIdpMfa: true });
      });

      it('audits assumeIdpMfa=false when assume is set without trust (inert)', async () => {
        const m = make({ env: { SSO_TRUST_IDP_MFA: false, SSO_ASSUME_IDP_MFA: true }, claims: { amr: [] }, linked });
        await callback(m);
        const row = m.audit.log.mock.calls
          .map((c: unknown[]) => c[0] as { action: string; after: Record<string, unknown> })
          .find((r) => r.action === 'auth.sso.login.success')!;
        expect(row.after).toMatchObject({ idpMfaAsserted: false, assumeIdpMfa: false });
      });
    });

    it('with SSO_TRUST_IDP_MFA on and no amr claim at all, normal TOTP rules apply', async () => {
      const m = make({ env: { SSO_TRUST_IDP_MFA: true }, claims: { amr: [] }, linked });
      await callback(m);
      expect(m.auth.issueSession).toHaveBeenCalledWith(
        USER,
        expect.objectContaining({ idpMfa: false }),
      );
    });
  });

  describe('callback errors', () => {
    it('no flow cookie gives expired', async () => {
      const m = make();
      const out = await m.svc.complete({
        flowCookie: undefined,
        code: CODE,
        state: 'x',
        idpError: undefined,
        meta: META,
      });
      expect(out).toEqual({ ok: false, code: 'expired' });
      expect(failureAudit(m)).toMatchObject({ after: { reason: 'flow_cookie_missing' } });
    });

    it('an unparseable flow cookie gives expired', async () => {
      const m = make();
      const out = await m.svc.complete({
        flowCookie: '{"nope":true}',
        code: CODE,
        state: 'x',
        idpError: undefined,
        meta: META,
      });
      expect(out).toEqual({ ok: false, code: 'expired' });
    });

    it('a flow older than ten minutes gives expired', async () => {
      const m = make();
      const { flow } = await start(m);
      const stale = JSON.stringify({ ...flow, p: 'login', t: Date.now() - 11 * 60 * 1000 });
      const out = await m.svc.complete({
        flowCookie: stale,
        code: CODE,
        state: flow.s,
        idpError: undefined,
        meta: META,
      });
      expect(out).toEqual({ ok: false, code: 'expired' });
      expect(m.oidc.exchangeCode).not.toHaveBeenCalled();
    });

    it.each([
      ['a wrong state', { state: 'wrong-state' }],
      ['a missing state', { state: undefined }],
      ['an array state', { state: ['a', 'b'] }],
    ])('%s gives failed before any token exchange', async (_name, over) => {
      const m = make({ linked: { id: 'i-1', user: USER } });
      expect(await callback(m, over)).toEqual({ ok: false, code: 'failed' });
      expect(m.oidc.exchangeCode).not.toHaveBeenCalled();
      expect(failureAudit(m)).toMatchObject({ after: { reason: 'state_mismatch' } });
    });

    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['an array', ['a', 'b']],
      ['oversized', 'x'.repeat(5000)],
    ])('a %s code gives failed', async (_name, code) => {
      const m = make();
      expect(await callback(m, { code })).toEqual({ ok: false, code: 'failed' });
      expect(m.oidc.exchangeCode).not.toHaveBeenCalled();
    });

    it('an error from the provider gives failed, and access_denied gives not_allowed', async () => {
      const m = make();
      expect(await callback(m, { idpError: 'server_error' })).toEqual({ ok: false, code: 'failed' });
      expect(await callback(m, { idpError: 'access_denied' })).toEqual({
        ok: false,
        code: 'not_allowed',
      });
    });

    it('a failed code exchange gives failed', async () => {
      const m = make();
      m.oidc.exchangeCode.mockRejectedValue(new SsoProviderError('token_exchange_failed'));
      expect(await callback(m)).toEqual({ ok: false, code: 'failed' });
      expect(failureAudit(m)).toMatchObject({ after: { reason: 'token_exchange_failed' } });
    });

    it.each([
      ['invalid_token', 'failed'],
      ['expired', 'failed'],
      ['nonce_mismatch', 'failed'],
      ['tenant_mismatch', 'not_allowed'],
    ] as const)('an ID token refused as %s gives %s', async (failure, code) => {
      const m = make();
      m.oidc.verifyIdToken.mockRejectedValue(new IdTokenError(failure));
      expect(await callback(m)).toEqual({ ok: false, code });
      expect(m.auth.issueSession).not.toHaveBeenCalled();
    });

    it('an unexpected error gives failed, is audited, and never escapes', async () => {
      const m = make({ linked: { id: 'i-1', user: USER } });
      m.auth.issueSession.mockRejectedValue(new Error('db down'));
      expect(await callback(m)).toEqual({ ok: false, code: 'failed' });
      expect(failureAudit(m)).toMatchObject({ after: { reason: 'internal_error' } });
    });

    it('still returns the code if the failure audit itself fails', async () => {
      const m = make();
      m.audit.log.mockRejectedValue(new Error('audit down'));
      expect(await callback(m, { state: 'wrong' })).toEqual({ ok: false, code: 'failed' });
    });

    it('never writes the code, the ID token or the client secret to the audit trail', async () => {
      const ok = make({ byEmail: USER });
      await callback(ok);
      const bad = make();
      bad.oidc.verifyIdToken.mockRejectedValue(new IdTokenError('invalid_token'));
      await callback(bad);
      for (const m of [ok, bad]) {
        const logged = JSON.stringify(m.audit.log.mock.calls);
        expect(logged).not.toContain(CODE);
        expect(logged).not.toContain(ID_TOKEN);
        expect(logged).not.toContain('sub-pairwise');
      }
    });

    it('only ever returns a code from the fixed set', async () => {
      const m = make();
      const codes = new Set<string>();
      for (const over of [
        { state: 'x' },
        { code: undefined },
        { idpError: 'access_denied' },
        { idpError: 'boom' },
        {},
      ]) {
        const out = await callback(m, over);
        if (!out.ok) codes.add(out.code);
      }
      for (const c of codes) expect(['no_account', 'not_allowed', 'failed', 'expired']).toContain(c);
    });
  });

  describe('step-up', () => {
    const who = { userId: 'u-1', sessionId: 's-1' };
    const nowSec = () => Math.floor(Date.now() / 1000);

    it('marks the session verified with factor sso and audits it when auth_time is fresh', async () => {
      const m = make({ claims: { authTime: nowSec() - 5 }, stepUpIdentity: { userId: 'u-1' } });
      const out = await callback(m, {}, who);
      expect(out).toEqual({ ok: true, kind: 'stepup' });
      expect(m.stepUp.markVerified).toHaveBeenCalledWith('s-1', 'sso');
      expect(m.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.sso.stepup',
          actorId: 'u-1',
          entityId: 's-1',
          after: expect.objectContaining({ factor: 'sso' }),
        }),
      );
      // A step-up never creates a session.
      expect(m.auth.issueSession).not.toHaveBeenCalled();
    });

    it('accepts auth_time right at the limit and refuses just past it', async () => {
      const edge = make({
        claims: { authTime: nowSec() - STEP_UP_MAX_AUTH_AGE_SEC + 2 },
        stepUpIdentity: { userId: 'u-1' },
      });
      expect((await callback(edge, {}, who)).ok).toBe(true);

      const stale = make({
        claims: { authTime: nowSec() - STEP_UP_MAX_AUTH_AGE_SEC - 5 },
        stepUpIdentity: { userId: 'u-1' },
      });
      expect(await callback(stale, {}, who)).toEqual({ ok: false, code: 'failed' });
      expect(stale.stepUp.markVerified).not.toHaveBeenCalled();
      expect(failureAudit(stale)).toMatchObject({
        after: { reason: 'stepup_stale_auth', purpose: 'stepup' },
      });
    });

    it('refuses a token with no auth_time (the user may not have re-entered credentials)', async () => {
      const m = make({ claims: { authTime: undefined }, stepUpIdentity: { userId: 'u-1' } });
      expect(await callback(m, {}, who)).toEqual({ ok: false, code: 'failed' });
      expect(m.stepUp.markVerified).not.toHaveBeenCalled();
    });

    it('refuses an auth_time in the future beyond the skew allowance', async () => {
      const m = make({ claims: { authTime: nowSec() + 3600 }, stepUpIdentity: { userId: 'u-1' } });
      expect(await callback(m, {}, who)).toEqual({ ok: false, code: 'failed' });
    });

    it('refuses when a different account re-authenticated at the provider', async () => {
      const m = make({ claims: { authTime: nowSec() }, stepUpIdentity: { userId: 'u-other' } });
      expect(await callback(m, {}, who)).toEqual({ ok: false, code: 'not_allowed' });
      expect(m.stepUp.markVerified).not.toHaveBeenCalled();
    });

    it('refuses when the identity is not linked to anyone', async () => {
      const m = make({ claims: { authTime: nowSec() }, stepUpIdentity: null });
      expect(await callback(m, {}, who)).toEqual({ ok: false, code: 'not_allowed' });
    });

    it.each([
      ['revoked', { revokedAt: new Date() }],
      ['expired', { expiresAt: new Date(Date.now() - 1000) }],
      ['not an sso session', { authMethod: 'password' }],
      ['mfa pending', { mfaPending: true }],
      ['another user\'s', { userId: 'u-other' }],
    ])('refuses when the session is %s', async (_name, patch) => {
      const m = make({
        claims: { authTime: nowSec() },
        stepUpIdentity: { userId: 'u-1' },
        session: {
          id: 's-1',
          userId: 'u-1',
          revokedAt: null,
          expiresAt: new Date(Date.now() + 3_600_000),
          authMethod: 'sso',
          mfaPending: false,
          ...patch,
        },
      });
      expect(await callback(m, {}, who)).toEqual({ ok: false, code: 'failed' });
      expect(m.stepUp.markVerified).not.toHaveBeenCalled();
    });

    it('refuses when the session is gone', async () => {
      const m = make({
        claims: { authTime: nowSec() },
        stepUpIdentity: { userId: 'u-1' },
        session: null,
      });
      expect(await callback(m, {}, who)).toEqual({ ok: false, code: 'failed' });
    });
  });

  describe('client-visible codes do not reveal why an account was refused', () => {
    it.each([
      ['inactive user', { linked: { id: 'i-1', user: { ...USER, isActive: false } } }],
      ['pending invite', { byEmail: { ...USER, passwordHash: null } }],
      ['already linked', { byEmail: USER, otherIdentity: { id: 'i-x' } }],
      ['privileged account', { byEmail: { ...USER, role: 'SUPER_ADMIN' } }],
    ] as const)('%s gives exactly not_allowed, with the detail only in the audit row', async (_n, o) => {
      const m = make(o as Opts);
      const out = await callback(m);
      expect(out).toEqual({ ok: false, code: 'not_allowed' });
      expect(JSON.stringify(out)).not.toMatch(/inactive|pending|linked|privileged/);
      expect(failureAudit(m)?.['after']).toHaveProperty('reason');
    });
  });

  describe('failure audit identity hashes', () => {
    const prefix = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 12);

    it('records SHA-256 prefixes of the subject and email, never the values', async () => {
      const m = make({ byEmail: { ...USER, isActive: false } });
      await callback(m);
      const after = failureAudit(m)!['after'] as Row;
      expect(after['subjectHash']).toBe(prefix('oid-1'));
      expect(after['emailHash']).toBe(prefix('alice@example.test'));
      expect(String(after['subjectHash'])).toMatch(/^[0-9a-f]{12}$/);
      const logged = JSON.stringify(m.audit.log.mock.calls);
      expect(logged).not.toContain('oid-1');
      expect(logged).not.toContain('alice@example.test');
    });

    it('omits them when the failure happened before a token was verified', async () => {
      const m = make();
      await callback(m, { state: 'wrong' });
      const after = failureAudit(m)!['after'] as Row;
      expect(after).not.toHaveProperty('subjectHash');
      expect(after).not.toHaveProperty('emailHash');
    });
  });

  describe('a session is not stranded when recording the login fails', () => {
    it('revokes the just-created session and fails cleanly', async () => {
      const m = make({ linked: { id: 'i-1', user: USER }, failSuccessAudit: true });
      expect(await callback(m)).toEqual({ ok: false, code: 'failed' });
      expect(m.prisma.session.updateMany).toHaveBeenCalledWith({
        where: { id: 's-new', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('revokes it when the identity update fails too', async () => {
      const m = make({ linked: { id: 'i-1', user: USER } });
      m.prisma.userIdentity.update.mockRejectedValue(new Error('db down'));
      expect(await callback(m)).toEqual({ ok: false, code: 'failed' });
      expect(m.prisma.session.updateMany).toHaveBeenCalled();
    });

    it('still fails cleanly if the revoke itself fails', async () => {
      const m = make({ linked: { id: 'i-1', user: USER }, failSuccessAudit: true });
      m.prisma.session.updateMany.mockRejectedValue(new Error('db down'));
      expect(await callback(m)).toEqual({ ok: false, code: 'failed' });
    });
  });

  describe('flow cookie purpose string', () => {
    it('rejects a login flow whose purpose string was swapped for the step-up one', async () => {
      const m = make({ linked: { id: 'i-1', user: USER } });
      const { flow } = await start(m);
      const forged = JSON.stringify({ ...flow, p: 'login', k: 'weavestream.sso.stepup.v1' });
      const out = await m.svc.complete({
        flowCookie: forged,
        code: CODE,
        state: flow.s,
        idpError: undefined,
        meta: META,
      });
      expect(out).toEqual({ ok: false, code: 'expired' });
      expect(m.oidc.exchangeCode).not.toHaveBeenCalled();
    });

    it('rejects a payload with no purpose string, or an unknown one', async () => {
      const m = make();
      const { flow } = await start(m);
      for (const k of [undefined, 'something-else']) {
        const body = { ...flow, p: 'login', ...(k ? { k } : {}) } as Record<string, unknown>;
        if (!k) delete body['k'];
        const out = await m.svc.complete({
          flowCookie: JSON.stringify(body),
          code: CODE,
          state: flow.s,
          idpError: undefined,
          meta: META,
        });
        expect(out).toEqual({ ok: false, code: 'expired' });
      }
    });

    it('uses separate purpose strings for login and step-up flows', async () => {
      const m = make();
      const login = (await start(m)).flow as unknown as { k: string };
      const stepUp = (await start(m, { userId: 'u-1', sessionId: 's-1' })).flow as unknown as {
        k: string;
      };
      expect(login.k).not.toBe(stepUp.k);
      expect(login.k).toBe('weavestream.sso.login.v1');
      expect(stepUp.k).toBe('weavestream.sso.stepup.v1');
    });
  });

  describe('self-service link', () => {
    const who = { userId: 'u-1', sessionId: 's-1' };
    const SUPER = { ...USER, role: 'SUPER_ADMIN' };

    const linkCb = (m: Made, over: Partial<Parameters<SsoService['complete']>[0]> = {}) =>
      callbackWith(m, 'link', who, over);

    async function callbackWith(
      m: Made,
      kind: 'link',
      bind: { userId: string; sessionId: string },
      over: Partial<Parameters<SsoService['complete']>[0]>,
    ): Promise<SsoCallbackOutcome> {
      const { flowCookie, flow } = kind === 'link' ? await startLink(m, bind) : await start(m);
      return m.svc.complete({
        flowCookie,
        code: CODE,
        state: flow.s,
        idpError: undefined,
        meta: META,
        ...over,
      });
    }

    async function startLink(m: Made, bind: { userId: string; sessionId: string }) {
      const { flowCookie } = await m.svc.beginLink(bind);
      return { flowCookie, flow: JSON.parse(flowCookie) as { s: string; k: string; p: string } };
    }

    it('starts a link flow with its own purpose string, the user and session, and select_account', async () => {
      const m = make();
      const { flow, flowCookie } = await startLink(m, who);
      expect(flow).toMatchObject({ p: 'link', k: 'weavestream.sso.link.v1' });
      expect(JSON.parse(flowCookie)).toMatchObject({ u: 'u-1', sid: 's-1' });
      expect(m.oidc.authorizationUrl.mock.calls[0]![0]).toMatchObject({
        selectAccount: true,
        reauthenticate: false,
      });
    });

    it('links a SUPER_ADMIN (the case auto-link refuses), with an audited self_service reason and hashes', async () => {
      const m = make({ linked: null, byEmail: SUPER });
      const out = await linkCb(m);
      expect(out).toEqual({ ok: true, kind: 'link' });
      expect(m.prisma.userIdentity.create).toHaveBeenCalledWith({
        data: { userId: 'u-1', issuer: ISSUER, subject: 'oid-1', email: 'alice@example.test' },
      });
      const row = m.audit.log.mock.calls.map((c) => c[0] as Row).find((r) => r['action'] === 'auth.sso.link')!;
      expect(row).toMatchObject({
        actorId: 'u-1',
        after: { reason: 'self_service', sessionId: 's-1' },
      });
      const after = row['after'] as Row;
      expect(after['subjectHash']).toMatch(/^[0-9a-f]{12}$/);
      expect(after['emailHash']).toMatch(/^[0-9a-f]{12}$/);
      expect(JSON.stringify(row)).not.toContain('oid-1');
      expect(JSON.stringify(row)).not.toContain(CODE);
    });

    it('does not use the email claim to decide anything: no email, unverified, or a different one still links', async () => {
      for (const claims of [
        { email: undefined },
        { emailVerified: false, emailDomainOwnerVerified: false },
        { email: 'someone-else@example.test' },
      ]) {
        const m = make({ claims });
        expect(await linkCb(m)).toEqual({ ok: true, kind: 'link' });
        expect(m.prisma.user.findUnique).not.toHaveBeenCalledWith(
          expect.objectContaining({ where: { email: expect.anything() } }),
        );
      }
    });

    it('creates no session, issues no tokens and does not touch the current session', async () => {
      const m = make();
      await linkCb(m);
      expect(m.auth.issueSession).not.toHaveBeenCalled();
      expect(m.prisma.session.updateMany).not.toHaveBeenCalled();
      expect(m.stepUp.markVerified).not.toHaveBeenCalled();
    });

    it('refuses when the identity is already linked to another user (not_allowed), and links nothing', async () => {
      const m = make({ taken: { id: 'i-9', userId: 'u-other' } });
      expect(await linkCb(m)).toEqual({ ok: false, code: 'not_allowed', purpose: 'link' });
      expect(m.prisma.userIdentity.create).not.toHaveBeenCalled();
      expect(failureAudit(m)).toMatchObject({ after: { reason: 'identity_taken', purpose: 'link' } });
    });

    it('refuses when this very identity is already linked to this user', async () => {
      const m = make({ taken: { id: 'i-9', userId: 'u-1' } });
      expect(await linkCb(m)).toEqual({ ok: false, code: 'not_allowed', purpose: 'link' });
      expect(failureAudit(m)).toMatchObject({ after: { reason: 'already_linked_user' } });
    });

    it('refuses a second identity for the same user at the same issuer (unlink first)', async () => {
      const m = make({ mine: { id: 'i-mine' } });
      expect(await linkCb(m)).toEqual({ ok: false, code: 'not_allowed', purpose: 'link' });
      expect(m.prisma.userIdentity.create).not.toHaveBeenCalled();
      expect(failureAudit(m)).toMatchObject({ after: { reason: 'already_linked_user' } });
    });

    it.each([
      ['revoked', { revokedAt: new Date() }],
      ['expired', { expiresAt: new Date(Date.now() - 1000) }],
      ['MFA pending', { mfaPending: true }],
      ['another user\'s (session mismatch)', { userId: 'u-other' }],
    ])('refuses when the session is %s', async (_n, patch) => {
      const m = make({
        session: {
          id: 's-1',
          userId: 'u-1',
          revokedAt: null,
          expiresAt: new Date(Date.now() + 3_600_000),
          mfaPending: false,
          ...patch,
        },
      });
      expect(await linkCb(m)).toEqual({ ok: false, code: 'failed', purpose: 'link' });
      expect(m.prisma.userIdentity.create).not.toHaveBeenCalled();
      expect(failureAudit(m)).toMatchObject({ after: { reason: 'link_session_invalid' } });
    });

    it('refuses when the session is gone', async () => {
      const m = make({ session: null });
      expect(await linkCb(m)).toEqual({ ok: false, code: 'failed', purpose: 'link' });
    });

    it('refuses when the user was deactivated meanwhile', async () => {
      const m = make();
      m.prisma.user.findUnique.mockResolvedValue({ isActive: false } as never);
      expect(await linkCb(m)).toEqual({ ok: false, code: 'failed', purpose: 'link' });
      expect(m.prisma.userIdentity.create).not.toHaveBeenCalled();
    });

    it('refuses when the step-up window lapsed during the round trip', async () => {
      const m = make({ stepUpVerified: false });
      expect(await linkCb(m)).toEqual({ ok: false, code: 'failed', purpose: 'link' });
      expect(failureAudit(m)).toMatchObject({ after: { reason: 'link_stepup_lapsed' } });
      expect(m.prisma.userIdentity.create).not.toHaveBeenCalled();
    });

    it('refuses an Entra token without oid (subject cannot flip)', async () => {
      const m = make({ claims: { oid: undefined } });
      expect(await linkCb(m)).toEqual({ ok: false, code: 'failed', purpose: 'link' });
    });

    it('a failed link carries purpose link; login and step-up failures do not', async () => {
      const m = make();
      expect(await callback(m, { state: 'wrong' })).toEqual({ ok: false, code: 'failed' });
      expect(await linkCb(m, { state: 'wrong' })).toEqual({ ok: false, code: 'failed', purpose: 'link' });
    });

    it('a login flow cookie cannot complete a link, nor a link cookie a login', async () => {
      const m = make();
      const { flow } = await startLink(m, who);
      const asLogin = JSON.stringify({ ...flow, p: 'login', n: 'n', v: 'v', t: Date.now() });
      const out = await m.svc.complete({
        flowCookie: asLogin,
        code: CODE,
        state: flow.s,
        idpError: undefined,
        meta: META,
      });
      expect(out).toEqual({ ok: false, code: 'expired' });
    });
  });

  describe('link status', () => {
    it('reports enabled, linked and the provider name', async () => {
      const linked = make({ mine: { id: 'i-1' } });
      expect(await linked.svc.linkStatus('u-1')).toEqual({
        enabled: true,
        linked: true,
        providerName: 'Contoso',
      });
      const unlinked = make();
      expect((await unlinked.svc.linkStatus('u-1')).linked).toBe(false);
    });

    it('is disabled and unlinked when SSO is off, without a lookup', async () => {
      // The fake config treats a present-but-empty issuer as "not configured".
      const m = make({ env: { SSO_OIDC_ISSUER: undefined } });
      expect(await m.svc.linkStatus('u-1')).toEqual({
        enabled: false,
        linked: false,
        providerName: 'Contoso',
      });
      expect(m.prisma.userIdentity.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('unlink', () => {
    it('removes the link and audits auth.sso.unlink', async () => {
      const m = make({ mine: { id: 'i-1' } });
      await expect(m.svc.unlink('u-1', META)).resolves.toEqual({ ok: true });
      expect(m.prisma.userIdentity.delete).toHaveBeenCalledWith({ where: { id: 'i-1' } });
      expect(m.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.sso.unlink',
          actorId: 'u-1',
          after: expect.objectContaining({ identityId: 'i-1' }),
        }),
      );
    });

    it('is a 404 when nothing is linked', async () => {
      const m = make();
      await expect(m.svc.unlink('u-1', META)).rejects.toBeInstanceOf(NotFoundException);
      expect(m.prisma.userIdentity.delete).not.toHaveBeenCalled();
    });

    it('refuses to leave an account with no password (SSO-only) with no way in', async () => {
      const m = make({ mine: { id: 'i-1' }, userRow: { passwordHash: null, role: 'OPERATOR' } });
      await expect(m.svc.unlink('u-1', META)).rejects.toBeInstanceOf(ConflictException);
      expect(m.prisma.userIdentity.delete).not.toHaveBeenCalled();
      expect(m.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.sso.unlink',
          after: expect.objectContaining({ refused: true, reason: 'no_password' }),
        }),
      );
    });

    it('refuses when password sign-in is off for the user (SSO_LOCAL_LOGIN=false, not SUPER_ADMIN)', async () => {
      const m = make({
        env: { SSO_LOCAL_LOGIN: false },
        mine: { id: 'i-1' },
        userRow: { passwordHash: 'h', role: 'OPERATOR' },
      });
      await expect(m.svc.unlink('u-1', META)).rejects.toBeInstanceOf(ConflictException);
      expect(m.prisma.userIdentity.delete).not.toHaveBeenCalled();
    });

    it('lets a SUPER_ADMIN with a password unlink even when SSO_LOCAL_LOGIN=false (break-glass remains)', async () => {
      const m = make({
        env: { SSO_LOCAL_LOGIN: false },
        mine: { id: 'i-1' },
        userRow: { passwordHash: 'h', role: 'SUPER_ADMIN' },
      });
      await expect(m.svc.unlink('u-1', META)).resolves.toEqual({ ok: true });
    });
  });
});
