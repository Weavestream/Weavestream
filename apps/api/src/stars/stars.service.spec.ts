import { StarsService } from './stars.service.js';
import { NotFoundException } from '@nestjs/common';
import { runWithTenantContext, type TenantContext } from '@weavestream/shared/server';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { assertTenantScope } from '../prisma/tenant-scoped-models.js';
import { FULL_PASSWORD_ACCESS, NO_PASSWORD_ACCESS } from '../passwords/password-access-policy.js';

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
  passwordAccess: FULL_PASSWORD_ACCESS,
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

/**
 * Issue #110: a starred password entry the actor can no longer open
 * (own allow-list or the global password access policy) must not keep
 * showing its name, and a hidden entry cannot be starred.
 */
describe('StarsService password access', () => {
  const COMPANY = '2ba00000-0000-4000-8000-00000000c110';
  const PASSWORD = '2ba00000-0000-4000-8000-00000000d110';
  const OUTSIDER: AuthedUser = {
    ...SUPER_ADMIN,
    role: 'OPERATOR',
    globalAccess: 'FULL',
    passwordAccess: NO_PASSWORD_ACCESS,
  };
  const meta = { ip: '127.0.0.1', userAgent: 'jest' };

  it('filters starred passwords in the query, not after the load', async () => {
    const prisma = makePrisma();
    await svcWith(prisma).list(OUTSIDER);
    expect(prisma.starredPassword.findMany.mock.calls[0]![0]!.where).toEqual({
      userId: OUTSIDER.id,
      password: { restrictedToUserIds: { has: OUTSIDER.id } },
    });
  });

  it('hides starred passwords in a denied company and keeps the others', async () => {
    const prisma = makePrisma();
    const denied: AuthedUser = {
      ...OUTSIDER,
      passwordAccess: { byDefault: true, allowCompanyIds: [], denyCompanyIds: [COMPANY] },
    };
    await svcWith(prisma).list(denied);
    expect(prisma.starredPassword.findMany.mock.calls[0]![0]!.where).toEqual({
      userId: denied.id,
      password: {
        OR: [
          { restrictedToUserIds: { isEmpty: true }, companyId: { notIn: [COMPANY] } },
          { restrictedToUserIds: { has: denied.id } },
        ],
      },
    });
  });

  it('keeps every starred password in scope for a super admin', async () => {
    const prisma = makePrisma();
    await svcWith(prisma).list(SUPER_ADMIN);
    expect(prisma.starredPassword.findMany.mock.calls[0]![0]!.where).toEqual({
      userId: SUPER_ADMIN.id,
      password: {},
    });
  });

  /**
   * A company-only (membership-scoped) actor, with the real tenant
   * middleware check on every password read. The row is visible only when
   * the actor passes the policy filter in the query.
   */
  function setupMember(actor: AuthedUser, existingStar = false) {
    const ctx: TenantContext = {
      userId: actor.id,
      role: 'OPERATOR',
      email: actor.email,
      allowedCompanyIds: [COMPANY],
      isSuperAdmin: false,
      globalAccess: 'NONE',
      requestId: 'req-110',
      ip: meta.ip,
      userAgent: meta.userAgent,
    };
    const createdAt = new Date('2026-11-04T08:00:00.000Z');
    const prisma = {
      password: {
        findFirst: jest.fn(
          async (args: {
            where: { companyId?: { in?: string[] }; OR?: unknown; restrictedToUserIds?: unknown };
          }) => {
            assertTenantScope({ model: 'Password', action: 'findFirst', args }, ctx);
            const inScope = args.where.companyId?.in?.includes(COMPANY) ?? false;
            // The stored entry has no own list, so only the "global
            // access" branch (`OR [isEmpty, has]`) can match it.
            return inScope && args.where.OR ? { companyId: COMPANY } : null;
          },
        ),
      },
      membership: { findFirst: jest.fn().mockResolvedValue({ id: 'm-1' }) },
      starredPassword: {
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

  const MEMBER: AuthedUser = { ...OUTSIDER, globalAccess: 'NONE', passwordAccess: FULL_PASSWORD_ACCESS };
  const MEMBER_OUTSIDER: AuthedUser = { ...MEMBER, passwordAccess: NO_PASSWORD_ACCESS };

  it('lets a company-only operator star and unstar a password entry they can open', async () => {
    const { svc, prisma, audit, run } = setupMember(MEMBER);
    await expect(run(() => svc.star(MEMBER, 'password', PASSWORD, meta))).resolves.toMatchObject({
      starred: true,
    });
    expect(prisma.starredPassword.create).toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY }));

    const unstarring = setupMember(MEMBER, true);
    await expect(
      unstarring.run(() => unstarring.svc.unstar(MEMBER, 'password', PASSWORD, meta)),
    ).resolves.toEqual({ starred: false });
    expect(unstarring.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY }),
    );
  });

  it('keeps the company scope at the top level of the password lookup', async () => {
    const { svc, prisma, run } = setupMember(MEMBER_OUTSIDER);
    await expect(
      run(() => svc.star(MEMBER_OUTSIDER, 'password', PASSWORD, meta)),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.password.findFirst.mock.calls[0]![0]!.where).toEqual({
      id: PASSWORD,
      companyId: { in: [COMPANY] },
      restrictedToUserIds: { has: MEMBER_OUTSIDER.id },
    });
    expect(prisma.starredPassword.create).not.toHaveBeenCalled();
  });
});
