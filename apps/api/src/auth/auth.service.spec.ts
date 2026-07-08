import {
  HttpException,
  HttpStatus,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

const USER: AuthedUser = {
  id: 'u-1',
  email: 'u@example.com',
  role: 'OPERATOR',
  globalAccess: 'FULL',
  platformCapabilities: [],
  sessionId: 's-1',
  mfaEnforcementCompletedAt: new Date(),
  mfaPending: true,
};

function makeService(backupOk: boolean) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: USER.id,
        mfaSecretEncrypted: 'encrypted',
        mfaEnforcementCompletedAt: new Date(),
      }),
      update: jest.fn().mockResolvedValue({ id: USER.id }),
    },
    session: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const backupCodes = {
    consume: jest.fn().mockResolvedValue(backupOk),
    replaceForUser: jest.fn(),
  };
  const lockout = {
    isLocked: jest.fn().mockResolvedValue(false),
    recordFailure: jest.fn().mockResolvedValue(undefined),
    clear: jest.fn().mockResolvedValue(undefined),
    isMfaLocked: jest.fn().mockResolvedValue(false),
    recordMfaFailure: jest.fn().mockResolvedValue(undefined),
    clearMfaFailures: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new AuthService(
    prisma as never,
    { verify: jest.fn(), hash: jest.fn() } as never,
    { issueAccessToken: jest.fn(), mintRefreshToken: jest.fn() } as never,
    { decryptSecret: jest.fn().mockReturnValue('secret'), verify: jest.fn().mockReturnValue(false) } as never,
    backupCodes as never,
    lockout as never,
    { clear: jest.fn().mockResolvedValue(undefined) } as never,
    { values: { SESSION_MAX_AGE_DAYS: 30 } } as never,
    audit as never,
    {} as never,
  );
  return { svc, prisma, audit, backupCodes, lockout };
}

describe('AuthService.verifyMfa backup codes', () => {
  it('accepts a backup code, clears mfaPending, and audits backup usage', async () => {
    const { svc, prisma, audit, backupCodes } = makeService(true);

    await expect(svc.verifyMfa(USER, 'ABCDE-FGHJ2', '127.0.0.1', 'jest')).resolves.toEqual({});

    expect(backupCodes.consume).toHaveBeenCalledWith(USER.id, 'ABCDE-FGHJ2');
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { id: USER.sessionId, revokedAt: null },
      data: { mfaPending: false },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.mfa.backup.used',
        entityId: USER.id,
      }),
    );
  });

  it('rejects a reused or invalid backup code', async () => {
    const { svc } = makeService(false);

    await expect(
      svc.verifyMfa(USER, 'ABCDE-FGHJ2', '127.0.0.1', 'jest'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AuthService.verifyMfa lockout scoping', () => {
  it('records a failure against the user id, never the login ip/email buckets', async () => {
    const { svc, lockout } = makeService(false);

    await expect(
      svc.verifyMfa(USER, '000000', '127.0.0.1', 'jest'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // Per-user MFA counter, not the shared login buckets (the blank-email bug).
    expect(lockout.recordMfaFailure).toHaveBeenCalledWith(USER.id);
    expect(lockout.recordFailure).not.toHaveBeenCalled();
  });

  it('rejects with 429 when the user is MFA-locked, without loading the DB row', async () => {
    const { svc, prisma, lockout } = makeService(false);
    lockout.isMfaLocked.mockResolvedValueOnce(true);

    const err = await svc
      .verifyMfa(USER, '000000', '127.0.0.1', 'jest')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    // Fast-fail: the lockout check must stay ahead of the row fetch.
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(lockout.recordMfaFailure).not.toHaveBeenCalled();
  });
});

const PRESENTED_HASH = 'hashed-presented-token-abcdef';

function sessionRow(extra: Record<string, unknown> = {}) {
  return {
    id: 's-1',
    userId: 'u-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    rotatedAt: null,
    user: { role: 'OPERATOR', isActive: true },
    ...extra,
  };
}

function makeRotateService(
  opts: {
    active?: ReturnType<typeof sessionRow> | null;
    prior?: ReturnType<typeof sessionRow> | null;
    rotateCount?: number;
    revokeCount?: number;
  } = {},
) {
  const updateMany = jest.fn().mockImplementation(({ data }) => {
    // The rotate compare-and-swap sets refreshTokenHash; the reuse revoke
    // sets only revokedAt. Distinguish them so each test controls its count.
    if ('refreshTokenHash' in data) {
      return Promise.resolve({ count: opts.rotateCount ?? 1 });
    }
    return Promise.resolve({ count: opts.revokeCount ?? 1 });
  });
  const prisma = {
    session: {
      findUnique: jest.fn().mockImplementation(({ where }) => {
        if ('refreshTokenHash' in where) return Promise.resolve(opts.active ?? null);
        if ('previousRefreshTokenHash' in where) return Promise.resolve(opts.prior ?? null);
        return Promise.resolve(null);
      }),
      updateMany,
    },
  };
  const tokens = {
    hashRefreshToken: jest.fn().mockReturnValue(PRESENTED_HASH),
    mintRefreshToken: jest.fn().mockReturnValue({ token: 'new-refresh-token', hash: 'new-hash' }),
    issueAccessToken: jest.fn().mockResolvedValue('new-access-jwt'),
  };
  const stepUp = { clear: jest.fn().mockResolvedValue(undefined) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const svc = new AuthService(
    prisma as never,
    {} as never, // passwords
    tokens as never, // tokens
    {} as never, // mfa
    {} as never, // backupCodes
    {} as never, // lockout
    stepUp as never, // stepUp
    { values: { SESSION_MAX_AGE_DAYS: 30 } } as never, // env
    audit as never, // audit
    {} as never, // setupTokens
  );
  return { svc, prisma, tokens, stepUp, audit };
}

describe('AuthService.rotateRefresh', () => {
  it('rotates the active token: new refresh token, prior hash recorded, access issued, audited', async () => {
    const { svc, prisma, tokens, audit } = makeRotateService({ active: sessionRow() });

    const out = await svc.rotateRefresh('rt', '1.2.3.4', 'jest', { audit: true });

    expect(out).not.toBeNull();
    expect(out!.refreshToken).toBe('new-refresh-token');
    expect(out!.accessToken).toBe('new-access-jwt');
    expect(out!.payload).toEqual({ sub: 'u-1', sid: 's-1', role: 'OPERATOR' });
    expect(tokens.mintRefreshToken).toHaveBeenCalledTimes(1);
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { id: 's-1', refreshTokenHash: PRESENTED_HASH, revokedAt: null },
      data: {
        refreshTokenHash: 'new-hash',
        previousRefreshTokenHash: PRESENTED_HASH,
        rotatedAt: expect.any(Date),
      },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.refresh', entityId: 's-1' }),
    );
  });

  it('does not write the routine auth.refresh audit on the silent path', async () => {
    const { svc, audit } = makeRotateService({ active: sessionRow() });

    await svc.rotateRefresh('rt', '1.2.3.4', 'jest', { audit: false });

    expect(audit.log).not.toHaveBeenCalled();
  });

  it('treats reuse of a long-retired token as theft: revokes + audits + clears step-up', async () => {
    const { svc, prisma, stepUp, audit } = makeRotateService({
      active: null,
      prior: sessionRow({ rotatedAt: new Date(Date.now() - 60_000) }),
      revokeCount: 1,
    });

    const out = await svc.rotateRefresh('rt', '9.9.9.9', 'jest', { audit: false });

    expect(out).toBeNull();
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { id: 's-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(stepUp.clear).toHaveBeenCalledWith('s-1');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.refresh.reused',
        entityId: 's-1',
        after: expect.objectContaining({ reason: 'rotated_token_reused' }),
      }),
    );
    // The raw token must never reach the audit log — only a hash prefix.
    const after = (audit.log as jest.Mock).mock.calls[0][0].after as { tokenHashPrefix: string };
    expect(after.tokenHashPrefix).toBe(PRESENTED_HASH.slice(0, 12));
  });

  it('serves a benign concurrent refresh within the leeway window: access token only, no revoke', async () => {
    const { svc, tokens, stepUp, audit } = makeRotateService({
      active: null,
      prior: sessionRow({ rotatedAt: new Date(Date.now() - 2_000) }),
    });

    const out = await svc.rotateRefresh('rt', '1.2.3.4', 'jest', { audit: false });

    expect(out).not.toBeNull();
    expect(out!.refreshToken).toBeUndefined();
    expect(out!.accessToken).toBe('new-access-jwt');
    expect(tokens.mintRefreshToken).not.toHaveBeenCalled();
    expect(stepUp.clear).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('enforces the active-user gate on the leeway path (deactivated user gets nothing)', async () => {
    const { svc, tokens } = makeRotateService({
      active: null,
      prior: sessionRow({
        rotatedAt: new Date(Date.now() - 2_000),
        user: { role: 'OPERATOR', isActive: false },
      }),
    });

    const out = await svc.rotateRefresh('rt', '1.2.3.4', 'jest', { audit: false });

    expect(out).toBeNull();
    expect(tokens.issueAccessToken).not.toHaveBeenCalled();
  });

  it('returns null for an expired session', async () => {
    const { svc } = makeRotateService({
      active: sessionRow({ expiresAt: new Date(Date.now() - 1_000) }),
    });
    expect(await svc.rotateRefresh('rt', '1.2.3.4', 'jest', { audit: true })).toBeNull();
  });

  it('returns null for a revoked session', async () => {
    const { svc } = makeRotateService({ active: sessionRow({ revokedAt: new Date() }) });
    expect(await svc.rotateRefresh('rt', '1.2.3.4', 'jest', { audit: true })).toBeNull();
  });

  it('returns null for an unknown token without revoking or auditing', async () => {
    const { svc, prisma, audit } = makeRotateService({ active: null, prior: null });

    expect(await svc.rotateRefresh('rt', '1.2.3.4', 'jest', { audit: true })).toBeNull();
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('is idempotent on reuse: a losing revoke (count 0) does not re-audit', async () => {
    const { svc, stepUp, audit } = makeRotateService({
      active: null,
      prior: sessionRow({ rotatedAt: new Date(Date.now() - 60_000) }),
      revokeCount: 0,
    });

    expect(await svc.rotateRefresh('rt', '1.2.3.4', 'jest', { audit: false })).toBeNull();
    expect(stepUp.clear).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('falls through to the leeway path when it loses the rotation race (no duplicate auth.refresh)', async () => {
    const { svc, audit } = makeRotateService({
      active: sessionRow(),
      rotateCount: 0, // lost the compare-and-swap
      prior: sessionRow({ rotatedAt: new Date(Date.now() - 1_000) }),
    });

    const out = await svc.rotateRefresh('rt', '1.2.3.4', 'jest', { audit: true });

    expect(out).not.toBeNull();
    expect(out!.refreshToken).toBeUndefined(); // grace path: access only
    expect(audit.log).not.toHaveBeenCalled(); // the race winner already logged it
  });

  describe('failure ordering', () => {
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined as never);
    });
    afterEach(() => warn.mockRestore());

    it('issues the access token before the rotation compare-and-swap', async () => {
      // Retiring the old token before the only fallible step (JWT issuance)
      // could strand the browser on a cookie the DB no longer recognises.
      const { svc, tokens, prisma } = makeRotateService({ active: sessionRow() });

      await svc.rotateRefresh('rt', '1.2.3.4', 'jest', { audit: true });

      const issueOrder = (tokens.issueAccessToken as jest.Mock).mock.invocationCallOrder[0]!;
      const casOrder = (prisma.session.updateMany as jest.Mock).mock.invocationCallOrder[0]!;
      expect(issueOrder).toBeLessThan(casOrder);
    });

    it('returns the rotated token even when the routine refresh audit fails', async () => {
      const { svc, audit } = makeRotateService({ active: sessionRow() });
      audit.log.mockRejectedValue(new Error('audit db down'));

      const out = await svc.rotateRefresh('rt', '1.2.3.4', 'jest', { audit: true });

      expect(out).not.toBeNull();
      expect(out!.refreshToken).toBe('new-refresh-token');
      expect(out!.accessToken).toBe('new-access-jwt');
    });

    it('records the reuse audit before clearing step-up, and survives a step-up clear failure', async () => {
      const { svc, stepUp, audit } = makeRotateService({
        active: null,
        prior: sessionRow({ rotatedAt: new Date(Date.now() - 60_000) }),
        revokeCount: 1,
      });
      stepUp.clear.mockRejectedValue(new Error('redis down'));

      const out = await svc.rotateRefresh('rt', '9.9.9.9', 'jest', { audit: false });

      expect(out).toBeNull(); // step-up failure must not bubble up
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.refresh.reused' }),
      );
      const auditOrder = (audit.log as jest.Mock).mock.invocationCallOrder[0]!;
      const clearOrder = (stepUp.clear as jest.Mock).mock.invocationCallOrder[0]!;
      expect(auditOrder).toBeLessThan(clearOrder); // audit persisted first
    });
  });
});

const DUMMY_HASH = '$argon2id$dummy';

function makeLoginService(userRow: Record<string, unknown> | null) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(userRow),
      update: jest.fn().mockResolvedValue({}),
    },
    session: {
      create: jest.fn().mockResolvedValue({ id: 's-new' }),
    },
  };
  const passwords = {
    verify: jest.fn().mockResolvedValue(false),
    hash: jest.fn(),
    dummyHash: jest.fn().mockResolvedValue(DUMMY_HASH),
  };
  const tokens = {
    issueAccessToken: jest.fn().mockResolvedValue('access'),
    mintRefreshToken: jest.fn().mockReturnValue({ token: 'refresh', hash: 'refresh-hash' }),
  };
  const lockout = {
    isLocked: jest.fn().mockResolvedValue(false),
    recordFailure: jest.fn().mockResolvedValue(undefined),
    clear: jest.fn().mockResolvedValue(undefined),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const svc = new AuthService(
    prisma as never,
    passwords as never,
    tokens as never,
    {} as never,
    {} as never,
    lockout as never,
    {} as never,
    { values: { SESSION_MAX_AGE_DAYS: 30 } } as never,
    audit as never,
    {} as never,
  );
  return { svc, prisma, passwords, lockout, audit };
}

// WS-025: every login attempt must spend one Argon2 verification so latency
// cannot distinguish valid active accounts from anything else.
describe('AuthService.login timing equalization', () => {
  it('runs verify against the dummy hash when no user exists', async () => {
    const { svc, passwords } = makeLoginService(null);

    await expect(
      svc.login('nobody@example.com', 'guess', '127.0.0.1', 'jest'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(passwords.dummyHash).toHaveBeenCalledTimes(1);
    expect(passwords.verify).toHaveBeenCalledTimes(1);
    expect(passwords.verify).toHaveBeenCalledWith(DUMMY_HASH, 'guess');
  });

  it('runs verify against the real hash for an inactive user', async () => {
    const { svc, passwords } = makeLoginService({
      id: 'u-1',
      isActive: false,
      passwordHash: 'real-hash',
    });

    await expect(
      svc.login('u@example.com', 'guess', '127.0.0.1', 'jest'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(passwords.verify).toHaveBeenCalledWith('real-hash', 'guess');
  });

  it('runs verify against the dummy hash for a pending-invite user (null passwordHash)', async () => {
    const { svc, passwords } = makeLoginService({
      id: 'u-1',
      isActive: true,
      passwordHash: null,
    });

    await expect(
      svc.login('u@example.com', 'guess', '127.0.0.1', 'jest'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(passwords.verify).toHaveBeenCalledWith(DUMMY_HASH, 'guess');
  });

  it('rejects a pending-invite user even if verify returns true', async () => {
    const { svc, passwords } = makeLoginService({
      id: 'u-1',
      isActive: true,
      passwordHash: null,
    });
    passwords.verify.mockResolvedValue(true);

    await expect(
      svc.login('u@example.com', 'guess', '127.0.0.1', 'jest'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('still logs in a valid active user', async () => {
    const { svc, passwords, lockout } = makeLoginService({
      id: 'u-1',
      email: 'u@example.com',
      name: 'U',
      role: 'OPERATOR',
      isActive: true,
      passwordHash: 'real-hash',
      mfaEnforcementCompletedAt: new Date(),
      mfaEnabled: false,
      uiTheme: 'SYSTEM',
      uiAccent: 'BLUE',
    });
    passwords.verify.mockResolvedValue(true);

    const out = await svc.login('u@example.com', 'correct', '127.0.0.1', 'jest');

    expect(passwords.verify).toHaveBeenCalledWith('real-hash', 'correct');
    expect(passwords.dummyHash).not.toHaveBeenCalled();
    expect(out.user.id).toBe('u-1');
    expect(lockout.clear).toHaveBeenCalled();
  });
});
