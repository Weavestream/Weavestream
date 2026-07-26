import { StarsService } from './stars.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * Access-scoping coverage for `GET /me/stars`.
 *
 * The starred feed is metadata-bearing — password names, asset names,
 * article titles, company names — so which companies it is allowed to
 * draw from is a security property, not a display detail. These tests
 * pin the membership predicate to the one the authoritative resolver
 * uses (`resolveEffectiveAccess` in rbac/permission.service.ts):
 * unrevoked **and** unexpired. Filtering on `revokedAt` alone kept
 * serving starred items to members whose access had lapsed.
 */

const SUPER_ADMIN: AuthedUser = {
  id: 'actor-1',
  role: 'SUPER_ADMIN',
  globalAccess: null,
  platformCapabilities: [],
  email: 'a@x',
  sessionId: 's-1',
  mfaEnforcementCompletedAt: new Date(),
  mfaPending: false,
};

const MEMBER: AuthedUser = {
  ...SUPER_ADMIN,
  role: 'CLIENT_USER',
  globalAccess: null,
};

function makePrisma() {
  const empty = () => jest.fn().mockResolvedValue([]);
  return {
    membership: { findMany: jest.fn().mockResolvedValue([]) },
    starredCompany: { findMany: empty() },
    starredPassword: { findMany: empty() },
    starredAsset: { findMany: empty() },
    starredArticle: { findMany: empty() },
    company: { findMany: empty() },
  };
}

function makeAudit() {
  return {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };
}

function svcWith(prisma: ReturnType<typeof makePrisma>) {
  return new StarsService(prisma as never, makeAudit() as never);
}

describe('StarsService company scoping', () => {
  it('requires an unrevoked AND unexpired membership', async () => {
    const prisma = makePrisma();
    // One live membership so the service proceeds past the
    // zero-membership short-circuit.
    prisma.membership.findMany.mockResolvedValue([{ companyId: 'c-live' }]);

    await svcWith(prisma).list(MEMBER);

    const where = prisma.membership.findMany.mock.calls[0]![0]!.where as {
      userId: string;
      revokedAt: null;
      OR?: unknown[];
    };
    expect(where.userId).toBe(MEMBER.id);
    expect(where.revokedAt).toBeNull();
    expect(where.OR).toEqual([
      { expiresAt: null },
      { expiresAt: { gt: expect.any(Date) } },
    ]);
  });

  it('returns an empty feed when every membership has lapsed', async () => {
    const prisma = makePrisma();
    // Prisma applies the predicate; a lapsed row is simply not returned.
    prisma.membership.findMany.mockResolvedValue([]);

    await expect(svcWith(prisma).list(MEMBER)).resolves.toEqual({ items: [] });
    // The short-circuit must fire before any starred query runs —
    // otherwise the lapsed member's own starred rows still leak.
    expect(prisma.starredCompany.findMany).not.toHaveBeenCalled();
    expect(prisma.starredPassword.findMany).not.toHaveBeenCalled();
    expect(prisma.starredAsset.findMany).not.toHaveBeenCalled();
    expect(prisma.starredArticle.findMany).not.toHaveBeenCalled();
  });

  it('scopes starred companies to the surviving memberships', async () => {
    const prisma = makePrisma();
    prisma.membership.findMany.mockResolvedValue([{ companyId: 'c-live' }]);

    await svcWith(prisma).list(MEMBER);

    const where = prisma.starredCompany.findMany.mock.calls[0]![0]!.where as {
      companyId?: { in?: string[] };
    };
    expect(where.companyId?.in).toEqual(['c-live']);
  });

  it('never consults memberships for an operator with global access', async () => {
    // WS-016: expiry reverts to `globalAccess`, so this branch must not
    // narrow an operator who already sees every company.
    const prisma = makePrisma();

    await svcWith(prisma).list({
      ...MEMBER,
      role: 'OPERATOR',
      globalAccess: 'READONLY',
    });

    expect(prisma.membership.findMany).not.toHaveBeenCalled();
  });

  it('never consults memberships for a super admin', async () => {
    const prisma = makePrisma();

    await svcWith(prisma).list(SUPER_ADMIN);

    expect(prisma.membership.findMany).not.toHaveBeenCalled();
    // No filter clause at all for a super admin.
    const where = prisma.starredCompany.findMany.mock.calls[0]![0]!.where as {
      companyId?: unknown;
    };
    expect(where.companyId).toBeUndefined();
  });
});
