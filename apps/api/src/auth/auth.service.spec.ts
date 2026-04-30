import { UnauthorizedException } from '@nestjs/common';
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
  const svc = new AuthService(
    prisma as never,
    { verify: jest.fn(), hash: jest.fn() } as never,
    { issueAccessToken: jest.fn(), mintRefreshToken: jest.fn() } as never,
    { decryptSecret: jest.fn().mockReturnValue('secret'), verify: jest.fn().mockReturnValue(false) } as never,
    backupCodes as never,
    {
      isLocked: jest.fn().mockResolvedValue(false),
      recordFailure: jest.fn().mockResolvedValue(undefined),
      clear: jest.fn().mockResolvedValue(undefined),
    } as never,
    { values: { SESSION_MAX_AGE_DAYS: 30 } } as never,
    audit as never,
    {} as never,
  );
  return { svc, prisma, audit, backupCodes };
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
