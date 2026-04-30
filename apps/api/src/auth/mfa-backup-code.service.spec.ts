import {
  MfaBackupCodeService,
  normalizeBackupCode,
} from './mfa-backup-code.service.js';

function makePrisma(rows: Array<{ id: string; codeHash: string }> = []) {
  const prisma: {
    userMfaBackupCode: {
      deleteMany: jest.Mock;
      createMany: jest.Mock;
      findMany: jest.Mock;
      updateMany: jest.Mock;
    };
    $transaction: jest.Mock;
  } = {
    userMfaBackupCode: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 10 }),
      findMany: jest.fn().mockResolvedValue(rows),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  return prisma;
}

const passwords = {
  hash: jest.fn(async (value: string) => `hash:${value}`),
  verify: jest.fn(async (hash: string, value: string) => hash === `hash:${value}`),
};

describe('MfaBackupCodeService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('normalizes user-entered backup code formatting', () => {
    expect(normalizeBackupCode('abcde-fghj2')).toBe('ABCDEFGHJ2');
    expect(normalizeBackupCode('abcde fghj2')).toBe('ABCDEFGHJ2');
  });

  it('replaces all codes with Argon2id hashes and returns plaintext once', async () => {
    const prisma = makePrisma();
    const svc = new MfaBackupCodeService(prisma as never, passwords as never);

    const codes = await svc.replaceForUser('u-1');

    expect(codes).toHaveLength(10);
    expect(codes[0]).toMatch(/^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
    expect(prisma.userMfaBackupCode.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u-1' },
    });
    expect(prisma.userMfaBackupCode.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ userId: 'u-1', codeHash: expect.stringMatching(/^hash:/) }),
      ]),
    });
  });

  it('consumes a matching unconsumed code once', async () => {
    const prisma = makePrisma([{ id: 'c-1', codeHash: 'hash:ABCDEFGHJ2' }]);
    const svc = new MfaBackupCodeService(prisma as never, passwords as never);

    await expect(svc.consume('u-1', 'abcde-fghj2')).resolves.toBe(true);

    expect(prisma.userMfaBackupCode.updateMany).toHaveBeenCalledWith({
      where: { id: 'c-1', consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it('rejects a replay when the consume update loses the race', async () => {
    const prisma = makePrisma([{ id: 'c-1', codeHash: 'hash:ABCDEFGHJ2' }]);
    prisma.userMfaBackupCode.updateMany.mockResolvedValue({ count: 0 });
    const svc = new MfaBackupCodeService(prisma as never, passwords as never);

    await expect(svc.consume('u-1', 'abcde-fghj2')).resolves.toBe(false);
  });
});
