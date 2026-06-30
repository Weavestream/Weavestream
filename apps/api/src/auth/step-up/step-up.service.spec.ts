import {
  ForbiddenException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { StepUpService } from './step-up.service.js';
import type { AuthedUser } from '../../common/current-user.decorator.js';

const USER: AuthedUser = {
  id: 'u-1',
  email: 'u@example.com',
  role: 'OPERATOR',
  globalAccess: 'FULL',
  platformCapabilities: [],
  sessionId: 's-1',
  mfaEnforcementCompletedAt: new Date(),
  mfaPending: false,
};

const META = { ip: '127.0.0.1', userAgent: 'jest' };

type UserRow = {
  passwordHash: string | null;
  mfaEnabled: boolean;
  mfaSecretEncrypted: string | null;
};

function makeService(opts: {
  userRow?: UserRow | null;
  failHits?: string | null;
  verifiedValue?: string | null;
  ttl?: number;
  mfaVerify?: boolean;
  backupConsume?: boolean;
  passwordVerify?: boolean;
}) {
  const multi = {
    incr: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
  };
  const redis = {
    client: {
      get: jest.fn(async (key: string) =>
        key.startsWith('stepup:fail:')
          ? (opts.failHits ?? null)
          : (opts.verifiedValue ?? null),
      ),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      ttl: jest.fn().mockResolvedValue(opts.ttl ?? -2),
      multi: jest.fn(() => multi),
    },
  };
  const env = {
    values: {
      STEP_UP_TTL_SEC: 900,
      LOCKOUT_MAX_FAILURES: 5,
      LOCKOUT_WINDOW_MIN: 15,
    },
  };
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(
        opts.userRow === undefined
          ? { passwordHash: 'hash', mfaEnabled: true, mfaSecretEncrypted: 'enc' }
          : opts.userRow,
      ),
    },
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const passwords = {
    verify: jest.fn().mockResolvedValue(opts.passwordVerify ?? false),
  };
  const mfa = {
    verify: jest.fn().mockReturnValue(opts.mfaVerify ?? false),
    decryptSecret: jest.fn().mockReturnValue('secret'),
  };
  const backupCodes = {
    consume: jest.fn().mockResolvedValue(opts.backupConsume ?? false),
  };

  const svc = new StepUpService(
    redis as never,
    env as never,
    prisma as never,
    audit as never,
    passwords as never,
    mfa as never,
    backupCodes as never,
  );
  return { svc, redis, prisma, audit, passwords, mfa, backupCodes, multi };
}

function actions(audit: { log: jest.Mock }): string[] {
  return audit.log.mock.calls.map((c) => c[0].action);
}

describe('StepUpService.requiredFactor', () => {
  it('is mfa when MFA is enabled with a stored secret', async () => {
    const { svc } = makeService({
      userRow: { passwordHash: 'h', mfaEnabled: true, mfaSecretEncrypted: 'enc' },
    });
    await expect(svc.requiredFactor('u-1')).resolves.toBe('mfa');
  });

  it('is password when MFA is disabled', async () => {
    const { svc } = makeService({
      userRow: { passwordHash: 'h', mfaEnabled: false, mfaSecretEncrypted: null },
    });
    await expect(svc.requiredFactor('u-1')).resolves.toBe('password');
  });

  it('falls back to password when MFA is enabled but the secret is missing', async () => {
    const { svc } = makeService({
      userRow: { passwordHash: 'h', mfaEnabled: true, mfaSecretEncrypted: null },
    });
    await expect(svc.requiredFactor('u-1')).resolves.toBe('password');
  });
});

describe('StepUpService.verify', () => {
  it('rejects an MFA-pending session before touching credentials', async () => {
    const { svc, prisma } = makeService({});
    await expect(
      svc.verify({ ...USER, mfaPending: true }, '123456', META),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('returns 429 when the step-up failure counter is exhausted', async () => {
    const { svc } = makeService({ failHits: '5' });
    await expect(svc.verify(USER, '123456', META)).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('accepts a valid TOTP, opens the window, and audits method=totp', async () => {
    const { svc, redis, audit } = makeService({
      userRow: { passwordHash: 'h', mfaEnabled: true, mfaSecretEncrypted: 'enc' },
      mfaVerify: true,
    });
    await expect(svc.verify(USER, '123456', META)).resolves.toEqual({ ok: true });
    expect(redis.client.set).toHaveBeenCalledWith('stepup:s-1', 'mfa', 'EX', 900);
    expect(redis.client.del).toHaveBeenCalledWith('stepup:fail:u-1');
    const verified = audit.log.mock.calls.find(
      (c) => c[0].action === 'security.stepup.verified',
    )?.[0];
    expect(verified.after).toMatchObject({ factor: 'mfa', method: 'totp' });
  });

  it('accepts a backup code when TOTP fails and audits method=backup_code', async () => {
    const { svc, audit } = makeService({
      userRow: { passwordHash: 'h', mfaEnabled: true, mfaSecretEncrypted: 'enc' },
      mfaVerify: false,
      backupConsume: true,
    });
    await expect(svc.verify(USER, 'ABCDE-FGHJ2', META)).resolves.toEqual({
      ok: true,
    });
    const verified = audit.log.mock.calls.find(
      (c) => c[0].action === 'security.stepup.verified',
    )?.[0];
    expect(verified.after).toMatchObject({ factor: 'mfa', method: 'backup_code' });
  });

  it('rejects a bad MFA code, records a failure, and audits the failure', async () => {
    const { svc, redis, audit, multi } = makeService({
      userRow: { passwordHash: 'h', mfaEnabled: true, mfaSecretEncrypted: 'enc' },
      mfaVerify: false,
      backupConsume: false,
    });
    await expect(svc.verify(USER, '000000', META)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(multi.incr).toHaveBeenCalledWith('stepup:fail:u-1');
    expect(redis.client.set).not.toHaveBeenCalled();
    expect(actions(audit)).toContain('security.stepup.failed');
  });

  it('accepts a valid password when MFA is disabled', async () => {
    const { svc, audit } = makeService({
      userRow: { passwordHash: 'h', mfaEnabled: false, mfaSecretEncrypted: null },
      passwordVerify: true,
    });
    await expect(svc.verify(USER, 'hunter2hunter2', META)).resolves.toEqual({
      ok: true,
    });
    const verified = audit.log.mock.calls.find(
      (c) => c[0].action === 'security.stepup.verified',
    )?.[0];
    expect(verified.after).toMatchObject({ factor: 'password', method: 'password' });
  });

  it('flags the anomaly and uses password when MFA is enabled with no secret', async () => {
    const { svc, audit } = makeService({
      userRow: { passwordHash: 'h', mfaEnabled: true, mfaSecretEncrypted: null },
      passwordVerify: true,
    });
    await expect(svc.verify(USER, 'hunter2hunter2', META)).resolves.toEqual({
      ok: true,
    });
    expect(actions(audit)).toContain('security.stepup.anomaly');
    expect(actions(audit)).toContain('security.stepup.verified');
  });

  it('never echoes the submitted code in any audit payload', async () => {
    const { svc, audit } = makeService({
      userRow: { passwordHash: 'h', mfaEnabled: true, mfaSecretEncrypted: 'enc' },
      mfaVerify: false,
      backupConsume: false,
    });
    await expect(svc.verify(USER, 'super-secret-code', META)).rejects.toThrow();
    for (const call of audit.log.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain('super-secret-code');
    }
  });
});

describe('StepUpService window helpers', () => {
  it('isVerified reflects key presence', async () => {
    const present = makeService({ verifiedValue: 'mfa' });
    await expect(present.svc.isVerified('s-1')).resolves.toBe(true);
    const absent = makeService({ verifiedValue: null });
    await expect(absent.svc.isVerified('s-1')).resolves.toBe(false);
  });

  it('status reports verified, factor, and a non-negative expiry', async () => {
    const { svc } = makeService({
      userRow: { passwordHash: 'h', mfaEnabled: true, mfaSecretEncrypted: 'enc' },
      verifiedValue: 'mfa',
      ttl: 842,
    });
    await expect(svc.status(USER)).resolves.toEqual({
      verified: true,
      factor: 'mfa',
      expiresInSec: 842,
    });
  });

  it('status clamps a missing TTL to 0', async () => {
    const { svc } = makeService({
      userRow: { passwordHash: 'h', mfaEnabled: false, mfaSecretEncrypted: null },
      verifiedValue: null,
      ttl: -2,
    });
    await expect(svc.status(USER)).resolves.toEqual({
      verified: false,
      factor: 'password',
      expiresInSec: 0,
    });
  });
});
