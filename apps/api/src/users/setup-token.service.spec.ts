import { SetupTokenService } from './setup-token.service.js';

describe('SetupTokenService', () => {
  it('hashes tokens deterministically with sha256', () => {
    const h1 = SetupTokenService.hash('abc');
    const h2 = SetupTokenService.hash('abc');
    expect(h1).toBe(h2);
    expect(h1).not.toBe(SetupTokenService.hash('abd'));
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  describe('issue + lookup round-trip', () => {
    it('invalidates prior tokens, stores only the hash, and validates the new one', async () => {
      const transactions: Array<{
        updateMany: jest.Mock;
        create: jest.Mock;
      }> = [];
      const tx = {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({}),
      };
      transactions.push(tx);
      const prisma = {
        $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) =>
          fn({ userSetupToken: tx }),
        ),
        userSetupToken: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
      };
      const env = { values: { APP_URL: 'https://weavestream.example' } };
      const svc = new SetupTokenService(prisma as never, env as never);

      const { token, url, expiresAt } = await svc.issue('user-1', 'actor-1');

      expect(tx.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', consumedAt: null },
        data: expect.objectContaining({ consumedAt: expect.any(Date) }),
      });
      expect(tx.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-1',
            tokenHash: SetupTokenService.hash(token),
            createdBy: 'actor-1',
          }),
        }),
      );
      expect(url).toBe(`https://weavestream.example/setup/${token}`);
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 20 * 3600_000);

      // Simulate DB returning the stored row for a lookup.
      prisma.userSetupToken.findUnique.mockResolvedValue({
        tokenHash: SetupTokenService.hash(token),
        consumedAt: null,
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'user-1', email: 'a@b', name: 'A', isActive: true },
      });
      const result = await svc.lookup(token);
      expect(result?.valid).toBe(true);
    });

    it('marks expired tokens invalid', async () => {
      const prisma = {
        userSetupToken: {
          findUnique: jest.fn().mockResolvedValue({
            consumedAt: null,
            expiresAt: new Date('2000-01-01'),
            user: { isActive: true },
          }),
        },
      };
      const svc = new SetupTokenService(prisma as never, { values: { APP_URL: 'x' } } as never);
      const result = await svc.lookup('tk');
      expect(result?.valid).toBe(false);
    });

    it('marks already-consumed tokens invalid', async () => {
      const prisma = {
        userSetupToken: {
          findUnique: jest.fn().mockResolvedValue({
            consumedAt: new Date(),
            expiresAt: new Date(Date.now() + 1000),
            user: { isActive: true },
          }),
        },
      };
      const svc = new SetupTokenService(prisma as never, { values: { APP_URL: 'x' } } as never);
      const result = await svc.lookup('tk');
      expect(result?.valid).toBe(false);
    });

    it('invalidates tokens whose user is deactivated', async () => {
      const prisma = {
        userSetupToken: {
          findUnique: jest.fn().mockResolvedValue({
            consumedAt: null,
            expiresAt: new Date(Date.now() + 1000),
            user: { isActive: false },
          }),
        },
      };
      const svc = new SetupTokenService(prisma as never, { values: { APP_URL: 'x' } } as never);
      const result = await svc.lookup('tk');
      expect(result?.valid).toBe(false);
    });
  });
});
