import { StarsService } from './stars.service.js';
import { NotFoundException } from '@nestjs/common';
import { runWithTenantContext, type TenantContext } from '@weavestream/shared/server';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { assertTenantScope } from '../prisma/tenant-scoped-models.js';

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

/**
 * Issue #109 follow-up: star/unstar resolve an entity's company before
 * the membership check. An unscoped read threw in the tenant middleware
 * for a membership-scoped operator (500 on every star). The fake runs
 * the real guard and only returns the row when the filter can see it.
 */
describe('StarsService entity lookup tenant scope', () => {
  const COMPANY = '2ba00000-0000-4000-8000-00000000c109';
  const ASSET = '2ba00000-0000-4000-8000-00000000a109';
  const OPERATOR: AuthedUser = { ...SUPER_ADMIN, role: 'OPERATOR', globalAccess: 'NONE' };
  const meta = { ip: '127.0.0.1', userAgent: 'jest' };

  function tenant(allowedCompanyIds: string[]): TenantContext {
    return {
      userId: OPERATOR.id,
      role: 'OPERATOR',
      email: OPERATOR.email,
      allowedCompanyIds,
      isSuperAdmin: false,
      globalAccess: 'NONE',
      requestId: 'req-109',
      ip: meta.ip,
      userAgent: meta.userAgent,
    };
  }

  function setup(ctx: TenantContext, existingStar: boolean) {
    const createdAt = new Date('2026-11-04T08:00:00.000Z');
    const prisma = {
      asset: {
        findFirst: jest.fn(async (args: { where: { companyId?: { in?: string[] } } }) => {
          assertTenantScope({ model: 'Asset', action: 'findFirst', args }, ctx);
          return args.where.companyId?.in?.includes(COMPANY) ? { companyId: COMPANY } : null;
        }),
      },
      membership: { findFirst: jest.fn().mockResolvedValue({ id: 'm-1' }) },
      starredAsset: {
        findUnique: jest.fn().mockResolvedValue(existingStar ? { createdAt } : null),
        create: jest.fn().mockResolvedValue({ createdAt }),
        delete: jest.fn().mockResolvedValue({}),
      },
    };
    const audit = makeAudit();
    const svc = new StarsService(prisma as never, audit as never);
    const run = <T>(fn: () => Promise<T>) => runWithTenantContext(ctx, fn);
    return { svc, prisma, audit, run };
  }

  it('lets a company-only operator star an asset in their company', async () => {
    const { svc, prisma, audit, run } = setup(tenant([COMPANY]), false);

    await expect(run(() => svc.star(OPERATOR, 'asset', ASSET, meta))).resolves.toMatchObject({
      starred: true,
    });
    expect(prisma.starredAsset.create).toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY }));
  });

  it('returns 404 for an asset outside the operator scope', async () => {
    const { svc, prisma, run } = setup(tenant(['2ba00000-0000-4000-8000-00000000c110']), false);

    await expect(run(() => svc.star(OPERATOR, 'asset', ASSET, meta))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.starredAsset.create).not.toHaveBeenCalled();
  });

  it('still removes a dangling star after the membership is gone', async () => {
    const { svc, prisma, audit, run } = setup(tenant([]), true);

    await expect(run(() => svc.unstar(OPERATOR, 'asset', ASSET, meta))).resolves.toEqual({
      starred: false,
    });
    expect(prisma.starredAsset.delete).toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ companyId: null }));
  });
});
