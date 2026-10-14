import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UsersService, hasAuthorityChanged } from './users.service.js';
import { UsersController } from './users.controller.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

const ACTOR: AuthedUser = {
  id: 'actor-1',
  role: 'SUPER_ADMIN',
  globalAccess: null,
  platformCapabilities: [],
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
    userMfaBackupCode: { deleteMany: jest.Mock };
    apiKey: { updateMany: jest.Mock };
    mcpConnection: { findMany: jest.Mock; updateMany: jest.Mock };
    oAuthArtifact: { deleteMany: jest.Mock };
    $queryRaw: jest.Mock;
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
    userMfaBackupCode: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    apiKey: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    mcpConnection: {
      // One live remote AI connection, so revocation has something to revoke.
      findMany: jest.fn().mockResolvedValue([{ grantId: 'grant-1' }]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    oAuthArtifact: { deleteMany: jest.fn().mockResolvedValue({ count: 3 }) },
    // The user-row lock in update(): one row means the user exists.
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'locked' }]),
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  return prisma;
}

/** The user's live AI connections were revoked and their OAuth artifacts deleted. */
function expectConnectionsRevoked(prisma: ReturnType<typeof makePrisma>, userId: string) {
  expect(prisma.mcpConnection.findMany).toHaveBeenCalledWith({
    where: { userId, revokedAt: null },
    select: { grantId: true },
  });
  expect(prisma.mcpConnection.updateMany).toHaveBeenCalledWith({
    where: { userId, revokedAt: null },
    data: { revokedAt: expect.any(Date) },
  });
  expect(prisma.oAuthArtifact.deleteMany).toHaveBeenCalledWith({
    where: { grantId: { in: ['grant-1'] } },
  });
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
      role: 'READONLY',
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
          role: 'READONLY',
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
          role: 'READONLY',
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
            role: 'READONLY',
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
            role: 'READONLY',
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
    await svc.update(
      ACTOR,
      'u-1',
      { role: 'OPERATOR', globalAccess: 'FULL' },
      META,
    );

    const actions = audit.log.mock.calls.map((c) => c[0].action);
    expect(actions).toEqual(expect.arrayContaining(['user.role.change', 'user.update']));
    expect(cache.invalidate).toHaveBeenCalledWith('u-1');
  });
});

describe('UsersService.update authority change revokes delegated access', () => {
  const BEFORE = {
    id: 'u-1',
    role: 'OPERATOR',
    globalAccess: 'READONLY',
    platformCapabilities: ['AUDIT_READ', 'TAG_MANAGE'],
    isActive: true,
    name: 'X',
    timezone: null,
  };

  async function runUpdate(
    input: Record<string, unknown>,
    after: Record<string, unknown>,
  ) {
    const prisma = makePrisma();
    const audit = makeAudit();
    const cache = makeCache();
    prisma.user.findUnique.mockResolvedValue(BEFORE);
    prisma.user.update.mockResolvedValue({ ...BEFORE, deactivatedAt: null, ...after });
    prisma.apiKey.updateMany.mockResolvedValue({ count: 2 });
    const svc = new UsersService(
      prisma as never,
      audit as never,
      cache as never,
      makeSetupTokens() as never,
    );
    await svc.update(ACTOR, 'u-1', input as never, META);
    const updateAudit = audit.log.mock.calls
      .map((c) => c[0])
      .find((e) => e.action === 'user.update');
    return { prisma, cache, updateAudit };
  }

  it('revokes keys and AI connections on a role change, inside the transaction', async () => {
    const { prisma, cache, updateAudit } = await runUpdate(
      { role: 'CONTRACTOR' },
      { role: 'CONTRACTOR', globalAccess: null, platformCapabilities: [] },
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.apiKey.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expectConnectionsRevoked(prisma, 'u-1');
    expect(cache.invalidate).toHaveBeenCalledWith('u-1');
    // Counts, never values.
    expect(updateAudit.after).toEqual(
      expect.objectContaining({ apiKeysRevoked: 2, mcpConnectionsRevoked: 1 }),
    );
    // A role change is not a sign-out: browser sessions re-read authority per request.
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
  });

  it('locks the user row, then reads it, inside the transaction', async () => {
    const { prisma } = await runUpdate({ globalAccess: 'FULL' }, { globalAccess: 'FULL' });
    const sql = prisma.$queryRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] };
    expect(sql.strings.join('?')).toMatch(/FROM users WHERE id = \?::uuid FOR UPDATE/);
    expect(sql.values).toEqual(['u-1']);
    // Lock, then read, then write — all after the transaction opened.
    const order = [
      prisma.$transaction.mock.invocationCallOrder[0],
      prisma.$queryRaw.mock.invocationCallOrder[0],
      prisma.user.findUnique.mock.invocationCallOrder[0],
      prisma.user.update.mock.invocationCallOrder[0],
    ];
    expect([...order].sort((a, b) => Number(a) - Number(b))).toEqual(order);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it('404s without writing when the locked row is gone', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw.mockResolvedValue([]);
    const svc = new UsersService(
      prisma as never,
      makeAudit() as never,
      makeCache() as never,
      makeSetupTokens() as never,
    );
    await expect(svc.update(ACTOR, 'u-1', { role: 'CONTRACTOR' }, META)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.apiKey.updateMany).not.toHaveBeenCalled();
  });

  it('revokes on a promotion, not only a demotion', async () => {
    const { prisma } = await runUpdate(
      { globalAccess: 'FULL' },
      { globalAccess: 'FULL' },
    );
    expect(prisma.apiKey.updateMany).toHaveBeenCalled();
    expectConnectionsRevoked(prisma, 'u-1');
  });

  it('revokes when the platform-capability set changes', async () => {
    const { prisma, cache } = await runUpdate(
      { platformCapabilities: ['AUDIT_READ'] },
      { platformCapabilities: ['AUDIT_READ'] },
    );
    expect(prisma.apiKey.updateMany).toHaveBeenCalled();
    expectConnectionsRevoked(prisma, 'u-1');
    expect(cache.invalidate).toHaveBeenCalledWith('u-1');
  });

  it('keeps keys when the capability set is only reordered', async () => {
    const { prisma, cache, updateAudit } = await runUpdate(
      { platformCapabilities: ['TAG_MANAGE', 'AUDIT_READ'] },
      { platformCapabilities: ['TAG_MANAGE', 'AUDIT_READ'] },
    );
    expect(prisma.apiKey.updateMany).not.toHaveBeenCalled();
    expect(prisma.mcpConnection.updateMany).not.toHaveBeenCalled();
    expect(cache.invalidate).not.toHaveBeenCalled();
    expect(updateAudit.after).not.toHaveProperty('apiKeysRevoked');
  });

  it('keeps keys on a profile-only edit', async () => {
    const { prisma, cache } = await runUpdate({ name: 'Y' }, { name: 'Y' });
    expect(prisma.apiKey.updateMany).not.toHaveBeenCalled();
    expect(prisma.mcpConnection.updateMany).not.toHaveBeenCalled();
    expect(cache.invalidate).not.toHaveBeenCalled();
  });

  it('keeps keys when the role is resubmitted unchanged', async () => {
    const { prisma } = await runUpdate(
      { role: 'OPERATOR', globalAccess: 'READONLY' },
      {},
    );
    expect(prisma.apiKey.updateMany).not.toHaveBeenCalled();
  });

  it('revokes once when deactivation and a role change land together', async () => {
    const { prisma } = await runUpdate(
      { isActive: false, role: 'CONTRACTOR' },
      {
        isActive: false,
        role: 'CONTRACTOR',
        globalAccess: null,
        platformCapabilities: [],
        deactivatedAt: new Date(),
      },
    );
    expect(prisma.apiKey.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.mcpConnection.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('hasAuthorityChanged', () => {
  const base = {
    role: 'OPERATOR' as const,
    globalAccess: 'READONLY' as const,
    platformCapabilities: ['AUDIT_READ' as const, 'TAG_MANAGE' as const],
  };

  it('is false for identical authority, in any capability order', () => {
    expect(hasAuthorityChanged(base, { ...base })).toBe(false);
    expect(
      hasAuthorityChanged(base, {
        ...base,
        platformCapabilities: ['TAG_MANAGE', 'AUDIT_READ'],
      }),
    ).toBe(false);
  });

  it('is true for a change on any axis', () => {
    expect(hasAuthorityChanged(base, { ...base, role: 'SUPER_ADMIN' })).toBe(true);
    expect(hasAuthorityChanged(base, { ...base, globalAccess: 'FULL' })).toBe(true);
    expect(hasAuthorityChanged(base, { ...base, platformCapabilities: [] })).toBe(true);
    expect(
      hasAuthorityChanged(base, {
        ...base,
        platformCapabilities: ['AUDIT_READ', 'USER_MANAGE'],
      }),
    ).toBe(true);
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
    // A deactivated user's AI connections must not come back on reactivation.
    expectConnectionsRevoked(prisma, 'u-1');
  });
});

describe('UsersService.resetMfa', () => {
  it('revokes the user\u2019s API keys and AI connections too', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-1',
      mfaEnabled: true,
      mfaEnforcementCompletedAt: new Date(),
    });
    prisma.user.update.mockResolvedValue({ id: 'u-1' });
    const svc = new UsersService(
      prisma as never,
      makeAudit() as never,
      makeCache() as never,
      makeSetupTokens() as never,
    );
    await svc.resetMfa(
      { id: 'admin', role: 'SUPER_ADMIN' } as never,
      'u-1',
      { ip: '203.0.113.9', userAgent: 'jest' },
    );
    // Resetting MFA is a compromise response; a surviving key would keep full
    // access precisely when the admin believes they just cut it off.
    expect(prisma.apiKey.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expectConnectionsRevoked(prisma, 'u-1');
  });

  it('clears MFA, revokes sessions, audits', async () => {
    const prisma = makePrisma();
    const audit = makeAudit();
    const cache = makeCache();
    prisma.user.findUnique.mockResolvedValueOnce({
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
    expect(prisma.userMfaBackupCode.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u-1' },
    });
    const actions = audit.log.mock.calls.map((c) => c[0].action);
    expect(actions).toContain('user.mfa.reset');
  });

  // The actor's recent-sign-in gate that used to live in `resetMfa` was
  // replaced by the unified step-up mechanism (the route now carries
  // `@RequireStepUp()`), so that enforcement is covered by the
  // StepUpGuard tests rather than here.
});

describe('PATCH/DELETE /users/:id response projection', () => {
  // Every column, secrets included. The mock honours `select` like Prisma
  // does, so the response is exactly what the query asks for.
  const FULL_ROW = {
    id: 'u-1',
    email: 'u@x',
    name: 'X',
    role: 'OPERATOR',
    globalAccess: 'READONLY',
    platformCapabilities: ['AUDIT_READ'],
    isActive: true,
    mfaEnabled: true,
    mfaEnforcementCompletedAt: new Date(),
    deactivatedAt: null,
    timezone: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLoginAt: null,
    passwordHash: '$argon2id$not-a-real-hash',
    mfaSecretEncrypted: 'not-a-real-ciphertext',
  };

  function makeController() {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue(FULL_ROW);
    prisma.user.update.mockImplementation(
      async (args: { data: Record<string, unknown>; select?: Record<string, boolean> }) => {
        const row: Record<string, unknown> = { ...FULL_ROW, ...args.data };
        if (!args.select) return row;
        return Object.fromEntries(
          Object.keys(args.select)
            .filter((k) => args.select![k])
            .map((k) => [k, row[k]]),
        );
      },
    );
    prisma.apiKey.updateMany.mockResolvedValue({ count: 2 });
    const svc = new UsersService(
      prisma as never,
      makeAudit() as never,
      makeCache() as never,
      makeSetupTokens() as never,
    );
    return { prisma, controller: new UsersController(svc) };
  }

  const req = { headers: {}, ip: '127.0.0.1', socket: {} } as never;

  it('PATCH never returns secret columns', async () => {
    const { prisma, controller } = makeController();
    const res = await controller.update(ACTOR, 'u-1', { name: 'Y' }, req);

    expect(res).not.toHaveProperty('passwordHash');
    expect(res).not.toHaveProperty('mfaSecretEncrypted');
    const select = prisma.user.update.mock.calls[0][0].select;
    expect(select).not.toHaveProperty('passwordHash');
    expect(select).not.toHaveProperty('mfaSecretEncrypted');
    expect(res).toMatchObject({ id: 'u-1', name: 'Y', role: 'OPERATOR' });
    // No authority change, nothing revoked, no counts.
    expect(res).not.toHaveProperty('apiKeysRevoked');
    expect(res).not.toHaveProperty('mcpConnectionsRevoked');
  });

  it('PATCH reports revoked counts on an authority change', async () => {
    const { controller } = makeController();
    const res = await controller.update(ACTOR, 'u-1', { globalAccess: 'FULL' }, req);

    expect(res).not.toHaveProperty('passwordHash');
    expect(res).not.toHaveProperty('mfaSecretEncrypted');
    expect(res).toMatchObject({ apiKeysRevoked: 2, mcpConnectionsRevoked: 1 });
  });

  it('DELETE never returns secret columns and reports revoked counts', async () => {
    const { controller } = makeController();
    const res = await controller.deactivate(ACTOR, 'u-1', req);

    expect(res).not.toHaveProperty('passwordHash');
    expect(res).not.toHaveProperty('mfaSecretEncrypted');
    expect(res).toMatchObject({
      isActive: false,
      apiKeysRevoked: 2,
      mcpConnectionsRevoked: 1,
    });
  });
});
