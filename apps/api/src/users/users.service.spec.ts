import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

const ACTOR: AuthedUser = {
  id: 'actor-1',
  role: 'SUPER_ADMIN',
  email: 'a@x',
  sessionId: 's-1',
  mfaEnforcementCompletedAt: new Date(),
  mfaPending: false,
};

const META = { ip: '127.0.0.1', userAgent: 'jest' };

function makePrisma() {
  const prisma: {
    user: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    company: { findUnique: jest.Mock };
    membership: { create: jest.Mock };
    session: { updateMany: jest.Mock };
    $transaction: jest.Mock;
  } = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    company: { findUnique: jest.fn() },
    membership: { create: jest.fn() },
    session: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  return prisma;
}

function makeAudit() {
  return { log: jest.fn().mockResolvedValue(undefined) };
}

function makeCache() {
  return { invalidate: jest.fn().mockResolvedValue(undefined) };
}

function makeSetupTokens() {
  return {
    issue: jest.fn().mockResolvedValue({
      token: 'tok',
      expiresAt: new Date(Date.now() + 3600_000),
      url: 'https://weavestream/setup/tok',
    }),
  };
}

describe('UsersService.create', () => {
  it('creates with no password hash and issues a setup token', async () => {
    const prisma = makePrisma();
    const audit = makeAudit();
    const cache = makeCache();
    const tokens = makeSetupTokens();
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      id: 'u-1',
      email: 'x@y',
      name: 'X',
      role: 'CLIENT_USER',
    });

    const svc = new UsersService(
      prisma as never,
      audit as never,
      cache as never,
      tokens as never,
    );
    const result = await svc.create(
      ACTOR,
      { email: 'X@Y', name: 'X', role: 'CLIENT_USER' },
      META,
    );

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'x@y',
          passwordHash: null,
          mfaEnabled: false,
        }),
      }),
    );
    expect(tokens.issue).toHaveBeenCalledWith('u-1', ACTOR.id);
    expect(result.setupUrl).toBe('https://weavestream/setup/tok');
    expect(result.membership).toBeNull();
    const actions = audit.log.mock.calls.map((c) => c[0].action);
    expect(actions).toEqual(expect.arrayContaining(['user.create', 'user.invite.created']));
    expect(actions).not.toContain('membership.create');
    expect(cache.invalidate).not.toHaveBeenCalled();
  });

  it('creates user + membership in a single transaction when membership block is present', async () => {
    const prisma = makePrisma();
    const audit = makeAudit();
    const cache = makeCache();
    const tokens = makeSetupTokens();

    prisma.user.findUnique.mockResolvedValue(null);
    prisma.company.findUnique.mockResolvedValue({
      id: 'c-1',
      archivedAt: null,
    });
    prisma.user.create.mockResolvedValue({
      id: 'u-1',
      email: 'x@y',
      name: 'X',
      role: 'CLIENT_USER',
    });
    const expiresAt = new Date(Date.now() + 86_400_000);
    prisma.membership.create.mockResolvedValue({
      id: 'm-1',
      role: 'CLIENT_VIEWER',
      expiresAt,
    });

    const svc = new UsersService(
      prisma as never,
      audit as never,
      cache as never,
      tokens as never,
    );
    const result = await svc.create(
      ACTOR,
      {
        email: 'x@y',
        name: 'X',
        role: 'CLIENT_USER',
        membership: {
          companyId: 'c-1',
          role: 'CLIENT_VIEWER',
          expiresAt: expiresAt.toISOString(),
        },
      },
      META,
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.user.create).toHaveBeenCalled();
    expect(prisma.membership.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'u-1',
          companyId: 'c-1',
          role: 'CLIENT_VIEWER',
          createdBy: ACTOR.id,
          expiresAt: expect.any(Date),
        }),
      }),
    );
    expect(cache.invalidate).toHaveBeenCalledWith('u-1');
    const actions = audit.log.mock.calls.map((c) => c[0].action);
    expect(actions).toEqual(
      expect.arrayContaining(['user.create', 'user.invite.created', 'membership.create']),
    );
    const membershipEntry = audit.log.mock.calls.find(
      (c) => c[0].action === 'membership.create',
    );
    expect(membershipEntry?.[0]).toEqual(
      expect.objectContaining({
        entityId: 'm-1',
        companyId: 'c-1',
      }),
    );
    expect(result.membership).toEqual(
      expect.objectContaining({ id: 'm-1', companyId: 'c-1' }),
    );
  });

  it('rejects membership on missing company before touching user', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.company.findUnique.mockResolvedValue(null);

    const svc = new UsersService(
      prisma as never,
      makeAudit() as never,
      makeCache() as never,
      makeSetupTokens() as never,
    );

    await expect(
      svc.create(
        ACTOR,
        {
          email: 'x@y',
          name: 'X',
          role: 'CLIENT_USER',
          membership: {
            companyId: 'missing',
            role: 'CLIENT_VIEWER',
          },
        },
        META,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.membership.create).not.toHaveBeenCalled();
  });

  it('rolls back the user when membership.create throws inside the transaction', async () => {
    const prisma = makePrisma();
    const tokens = makeSetupTokens();
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.company.findUnique.mockResolvedValue({
      id: 'c-1',
      archivedAt: null,
    });
    prisma.user.create.mockResolvedValue({
      id: 'u-1',
      email: 'x@y',
      name: 'X',
      role: 'CLIENT_USER',
    });
    prisma.membership.create.mockRejectedValue(new Error('db blew up'));

    const svc = new UsersService(
      prisma as never,
      makeAudit() as never,
      makeCache() as never,
      tokens as never,
    );

    await expect(
      svc.create(
        ACTOR,
        {
          email: 'x@y',
          name: 'X',
          role: 'CLIENT_USER',
          membership: {
            companyId: 'c-1',
            role: 'CLIENT_VIEWER',
          },
        },
        META,
      ),
    ).rejects.toThrow('db blew up');

    // The invite token is issued only after the transaction resolves,
    // so when the membership step throws we should never reach the
    // setup-token issuance path.
    expect(tokens.issue).not.toHaveBeenCalled();
  });
});

describe('UsersService.update role-change auditing', () => {
  it('emits user.role.change on role updates and busts cache', async () => {
    const prisma = makePrisma();
    const audit = makeAudit();
    const cache = makeCache();
    prisma.user.findUnique.mockResolvedValue({
      id: 'u-1',
      role: 'CLIENT_USER',
      isActive: true,
      name: 'X',
      timezone: null,
    });
    prisma.user.update.mockResolvedValue({
      id: 'u-1',
      role: 'OPERATOR',
      isActive: true,
      name: 'X',
      timezone: null,
      deactivatedAt: null,
    });

    const svc = new UsersService(
      prisma as never,
      audit as never,
      cache as never,
      makeSetupTokens() as never,
    );
    await svc.update(ACTOR, 'u-1', { role: 'OPERATOR' }, META);

    const actions = audit.log.mock.calls.map((c) => c[0].action);
    expect(actions).toEqual(expect.arrayContaining(['user.role.change', 'user.update']));
    expect(cache.invalidate).toHaveBeenCalledWith('u-1');
  });
});

describe('UsersService.update self-deactivation guard', () => {
  it('refuses self-deactivation', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: ACTOR.id,
      role: 'SUPER_ADMIN',
      isActive: true,
      name: 'Me',
      timezone: null,
    });
    const svc = new UsersService(
      prisma as never,
      makeAudit() as never,
      makeCache() as never,
      makeSetupTokens() as never,
    );
    await expect(
      svc.update(ACTOR, ACTOR.id, { isActive: false }, META),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('UsersService deactivation consequences', () => {
  it('revokes all sessions and busts cache', async () => {
    const prisma = makePrisma();
    const audit = makeAudit();
    const cache = makeCache();
    prisma.user.findUnique.mockResolvedValue({
      id: 'u-1',
      role: 'CLIENT_USER',
      isActive: true,
      name: 'X',
      timezone: null,
    });
    prisma.user.update.mockResolvedValue({
      id: 'u-1',
      role: 'CLIENT_USER',
      isActive: false,
      name: 'X',
      timezone: null,
      deactivatedAt: new Date(),
    });

    const svc = new UsersService(
      prisma as never,
      audit as never,
      cache as never,
      makeSetupTokens() as never,
    );
    await svc.update(ACTOR, 'u-1', { isActive: false }, META);

    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u-1', revokedAt: null },
      data: expect.objectContaining({ revokedAt: expect.any(Date) }),
    });
    expect(cache.invalidate).toHaveBeenCalledWith('u-1');
    const actions = audit.log.mock.calls.map((c) => c[0].action);
    expect(actions).toEqual(expect.arrayContaining(['user.deactivate']));
  });
});

describe('UsersService.resetMfa', () => {
  it('clears MFA, revokes sessions, audits', async () => {
    const prisma = makePrisma();
    const audit = makeAudit();
    const cache = makeCache();
    prisma.user.findUnique.mockResolvedValue({
      id: 'u-1',
      mfaEnabled: true,
      mfaEnforcementCompletedAt: new Date(),
    });
    prisma.user.update.mockResolvedValue({ id: 'u-1' });

    const svc = new UsersService(
      prisma as never,
      audit as never,
      cache as never,
      makeSetupTokens() as never,
    );
    await svc.resetMfa(ACTOR, 'u-1', META);

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          mfaSecretEncrypted: null,
          mfaEnabled: false,
          mfaEnforcementCompletedAt: null,
        }),
      }),
    );
    expect(prisma.session.updateMany).toHaveBeenCalled();
    const actions = audit.log.mock.calls.map((c) => c[0].action);
    expect(actions).toContain('user.mfa.reset');
  });
});
