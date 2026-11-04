import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MembershipsService } from './memberships.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { FULL_PASSWORD_ACCESS } from '../passwords/password-access-policy.js';

/**
 * Focused service-layer tests that exercise the three invariants the
 * memberships flow relies on:
 *   1. every mutation calls `cache.invalidate(userId)` so stale tenant
 *      contexts don't leak access post-revocation,
 *   2. every mutation emits a matching audit entry,
 *   3. re-adding a previously revoked (user, company) pair reactivates
 *      the existing row rather than creating a duplicate (the partial
 *      unique index mechanic).
 */

function makePrismaMock() {
  const models = {
    membership: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    user: { findUnique: jest.fn() },
    company: { findUnique: jest.fn() },
  };
  return Object.assign(models, {
    // Interactive transaction: the callback gets the same mock as `tx`.
    $transaction: jest.fn(async (fn: (tx: typeof models) => unknown) => fn(models)),
    $queryRaw: jest.fn().mockResolvedValue([]),
  });
}

/** A gate that never asks for step-up. */
const OPEN_GATE = jest.fn(async () => undefined);

function makeAudit() {
  return { log: jest.fn().mockResolvedValue(undefined) };
}

function makeCache() {
  return { invalidate: jest.fn().mockResolvedValue(undefined) };
}

const SUPER: AuthedUser = {
  id: 'super-1',
  role: 'SUPER_ADMIN',
  globalAccess: null,
  platformCapabilities: [],
  email: 's@x',
  sessionId: 'sess-1',
  mfaEnforcementCompletedAt: new Date(),
  mfaPending: false,
  passwordAccess: FULL_PASSWORD_ACCESS,
};

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '11111111-1111-1111-1111-111111111111';
const META = { ip: '127.0.0.1', userAgent: 'jest' };

describe('MembershipsService.create', () => {
  it('creates a fresh membership, invalidates cache, and audits', async () => {
    const prisma = makePrismaMock();
    const audit = makeAudit();
    const cache = makeCache();
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, isActive: true });
    prisma.company.findUnique.mockResolvedValue({ id: COMPANY_ID });
    prisma.membership.findFirst
      .mockResolvedValueOnce(null) // active lookup
      .mockResolvedValueOnce(null); // revoked lookup
    prisma.membership.create.mockResolvedValue({
      id: 'm-1',
      role: 'READONLY',
      expiresAt: null,
    });

    const svc = new MembershipsService(prisma as never, audit as never, cache as never);
    const result = await svc.create(
      SUPER,
      COMPANY_ID,
      { userId: USER_ID, role: 'READONLY', expiresAt: null },
      META,
    );

    expect(result.id).toBe('m-1');
    expect(prisma.membership.create).toHaveBeenCalled();
    expect(cache.invalidate).toHaveBeenCalledWith(USER_ID);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'membership.create',
        entityId: 'm-1',
        companyId: COMPANY_ID,
      }),
    );
  });

  it('rejects duplicate active memberships', async () => {
    const prisma = makePrismaMock();
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, isActive: true });
    prisma.company.findUnique.mockResolvedValue({ id: COMPANY_ID });
    prisma.membership.findFirst.mockResolvedValueOnce({ id: 'm-existing' });

    const svc = new MembershipsService(prisma as never, makeAudit() as never, makeCache() as never);
    await expect(
      svc.create(SUPER, COMPANY_ID, { userId: USER_ID, role: 'READONLY' }, META),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('reactivates a previously revoked (user, company) row instead of creating a duplicate', async () => {
    const prisma = makePrismaMock();
    const audit = makeAudit();
    const cache = makeCache();
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, isActive: true });
    prisma.company.findUnique.mockResolvedValue({ id: COMPANY_ID });
    prisma.membership.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'm-revoked',
        revokedAt: new Date('2020-01-01'),
        role: 'READONLY',
        expiresAt: null,
      });
    prisma.membership.updateMany.mockResolvedValue({ count: 1 });
    prisma.membership.findUniqueOrThrow.mockResolvedValue({
      id: 'm-revoked',
      role: 'FULL',
      expiresAt: null,
    });

    const svc = new MembershipsService(prisma as never, audit as never, cache as never);
    const result = await svc.create(
      SUPER,
      COMPANY_ID,
      { userId: USER_ID, role: 'FULL' },
      META,
    );

    expect(prisma.membership.create).not.toHaveBeenCalled();
    // Conditional: only a row that is still revoked is reactivated.
    expect(prisma.membership.updateMany).toHaveBeenCalledWith({
      where: { id: 'm-revoked', revokedAt: { not: null } },
      data: expect.objectContaining({ revokedAt: null, role: 'FULL' }),
    });
    expect(result.id).toBe('m-revoked');
    expect(cache.invalidate).toHaveBeenCalledWith(USER_ID);
    expect(audit.log).toHaveBeenCalled();
  });

  it('refuses to add a deactivated user', async () => {
    const prisma = makePrismaMock();
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, isActive: false });
    prisma.company.findUnique.mockResolvedValue({ id: COMPANY_ID });

    const svc = new MembershipsService(prisma as never, makeAudit() as never, makeCache() as never);
    await expect(
      svc.create(SUPER, COMPANY_ID, { userId: USER_ID, role: 'READONLY' }, META),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('MembershipsService.revoke', () => {
  it('marks revoked, invalidates cache, and emits audit', async () => {
    const prisma = makePrismaMock();
    const audit = makeAudit();
    const cache = makeCache();
    prisma.membership.findUnique.mockResolvedValue({
      id: 'm-1',
      userId: USER_ID,
      companyId: COMPANY_ID,
      revokedAt: null,
    });
    prisma.membership.update.mockResolvedValue({
      id: 'm-1',
      revokedAt: new Date(),
    });

    const svc = new MembershipsService(prisma as never, audit as never, cache as never);
    await svc.revoke(SUPER, 'm-1', META, OPEN_GATE);

    expect(prisma.membership.update).toHaveBeenCalledWith({
      where: { id: 'm-1' },
      data: expect.objectContaining({ revokedAt: expect.any(Date) }),
    });
    expect(cache.invalidate).toHaveBeenCalledWith(USER_ID);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'membership.revoke', entityId: 'm-1' }),
    );
  });

  it('refuses to revoke twice', async () => {
    const prisma = makePrismaMock();
    prisma.membership.findUnique.mockResolvedValue({
      id: 'm-1',
      userId: USER_ID,
      companyId: COMPANY_ID,
      revokedAt: new Date('2020-01-01'),
    });

    const svc = new MembershipsService(prisma as never, makeAudit() as never, makeCache() as never);
    await expect(svc.revoke(SUPER, 'm-1', META, OPEN_GATE)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s on unknown membership id (IDOR probe)', async () => {
    const prisma = makePrismaMock();
    prisma.membership.findUnique.mockResolvedValue(null);

    const svc = new MembershipsService(prisma as never, makeAudit() as never, makeCache() as never);
    await expect(svc.revoke(SUPER, 'does-not-exist', META, OPEN_GATE)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('MembershipsService.update', () => {
  it('invalidates the affected user cache and logs before/after', async () => {
    const prisma = makePrismaMock();
    const audit = makeAudit();
    const cache = makeCache();
    prisma.membership.findUnique.mockResolvedValue({
      id: 'm-1',
      userId: USER_ID,
      companyId: COMPANY_ID,
      revokedAt: null,
      role: 'READONLY',
      expiresAt: null,
      user: { role: 'OPERATOR' },
    });
    prisma.membership.update.mockResolvedValue({
      id: 'm-1',
      role: 'FULL',
      expiresAt: null,
    });

    const svc = new MembershipsService(prisma as never, audit as never, cache as never);
    await svc.update(SUPER, 'm-1', { role: 'FULL' }, META, OPEN_GATE);

    expect(cache.invalidate).toHaveBeenCalledWith(USER_ID);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'membership.update',
        before: expect.objectContaining({ role: 'READONLY' }),
        after: expect.objectContaining({ role: 'FULL' }),
      }),
    );
  });

  it('rejects FULL membership for CLIENT_USER', async () => {
    const prisma = makePrismaMock();
    prisma.membership.findUnique.mockResolvedValue({
      id: 'm-1',
      userId: USER_ID,
      companyId: COMPANY_ID,
      revokedAt: null,
      role: 'READONLY',
      expiresAt: null,
      user: { role: 'CLIENT_USER' },
    });

    const svc = new MembershipsService(prisma as never, makeAudit() as never, makeCache() as never);
    await expect(
      svc.update(SUPER, 'm-1', { role: 'FULL' }, META, OPEN_GATE),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('MembershipsService.create — CLIENT_USER guard', () => {
  it('rejects FULL membership for CLIENT_USER', async () => {
    const prisma = makePrismaMock();
    prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      isActive: true,
      role: 'CLIENT_USER',
    });
    prisma.company.findUnique.mockResolvedValue({ id: COMPANY_ID });

    const svc = new MembershipsService(prisma as never, makeAudit() as never, makeCache() as never);
    await expect(
      svc.create(SUPER, COMPANY_ID, { userId: USER_ID, role: 'FULL' }, META),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('MembershipsService — password access override', () => {
  function freshCreate(userRole = 'OPERATOR') {
    const prisma = makePrismaMock();
    const audit = makeAudit();
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, isActive: true, role: userRole });
    prisma.company.findUnique.mockResolvedValue({ id: COMPANY_ID });
    prisma.membership.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    prisma.membership.create.mockImplementation(async ({ data }) => ({ id: 'm-1', ...data }));
    const svc = new MembershipsService(prisma as never, audit as never, makeCache() as never);
    return { prisma, audit, svc };
  }

  it('creates with the requested override and audits it', async () => {
    const { prisma, audit, svc } = freshCreate();
    await svc.create(
      SUPER,
      COMPANY_ID,
      { userId: USER_ID, role: 'READONLY', passwordAccess: 'deny' },
      META,
    );
    expect(prisma.membership.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ passwordAccess: 'deny' }),
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'membership.create',
        after: expect.objectContaining({ passwordAccess: 'deny' }),
      }),
    );
  });

  it('defaults a new membership to inherit', async () => {
    const { prisma, svc } = freshCreate();
    await svc.create(SUPER, COMPANY_ID, { userId: USER_ID, role: 'READONLY' }, META);
    expect(prisma.membership.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ passwordAccess: 'inherit' }),
    });
  });

  it('resets a reactivated row to inherit, so an old override never comes back', async () => {
    const prisma = makePrismaMock();
    const audit = makeAudit();
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, isActive: true, role: 'OPERATOR' });
    prisma.company.findUnique.mockResolvedValue({ id: COMPANY_ID });
    prisma.membership.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'm-revoked',
      revokedAt: new Date('2020-01-01'),
      role: 'READONLY',
      expiresAt: null,
      passwordAccess: 'allow',
    });
    let written: Record<string, unknown> = {};
    prisma.membership.updateMany.mockImplementation(async ({ data }) => {
      written = data;
      return { count: 1 };
    });
    prisma.membership.findUniqueOrThrow.mockImplementation(async () => ({ id: 'm-revoked', ...written }));
    const svc = new MembershipsService(prisma as never, audit as never, makeCache() as never);

    await svc.create(SUPER, COMPANY_ID, { userId: USER_ID, role: 'FULL' }, META);

    expect(prisma.membership.updateMany).toHaveBeenCalledWith({
      where: { id: 'm-revoked', revokedAt: { not: null } },
      data: expect.objectContaining({ passwordAccess: 'inherit', revokedAt: null }),
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        before: expect.objectContaining({ passwordAccess: 'allow' }),
        after: expect.objectContaining({ passwordAccess: 'inherit' }),
      }),
    );
  });

  it('rejects an override for a CLIENT_USER on create', async () => {
    const { prisma, svc } = freshCreate('CLIENT_USER');
    await expect(
      svc.create(
        SUPER,
        COMPANY_ID,
        { userId: USER_ID, role: 'READONLY', passwordAccess: 'allow' },
        META,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.membership.create).not.toHaveBeenCalled();
  });

  function existing(userRole: string) {
    const prisma = makePrismaMock();
    const audit = makeAudit();
    prisma.membership.findUnique.mockResolvedValue({
      id: 'm-1',
      userId: USER_ID,
      companyId: COMPANY_ID,
      revokedAt: null,
      role: 'READONLY',
      expiresAt: null,
      passwordAccess: 'inherit',
      user: { role: userRole },
    });
    prisma.membership.update.mockImplementation(async ({ data }) => ({
      id: 'm-1',
      role: 'READONLY',
      expiresAt: null,
      passwordAccess: 'inherit',
      ...data,
    }));
    const cache = makeCache();
    const svc = new MembershipsService(prisma as never, audit as never, cache as never);
    return { prisma, audit, cache, svc };
  }

  it('updates only the override, invalidates the cache, and audits before/after', async () => {
    const { prisma, audit, cache, svc } = existing('OPERATOR');
    await svc.update(SUPER, 'm-1', { passwordAccess: 'allow' }, META, OPEN_GATE);
    expect(prisma.membership.update).toHaveBeenCalledWith({
      where: { id: 'm-1' },
      data: { passwordAccess: 'allow' },
    });
    expect(cache.invalidate).toHaveBeenCalledWith(USER_ID);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'membership.update',
        before: expect.objectContaining({ passwordAccess: 'inherit' }),
        after: expect.objectContaining({ passwordAccess: 'allow' }),
      }),
    );
  });

  it('leaves the override alone on a role-only update', async () => {
    const { prisma, svc } = existing('OPERATOR');
    await svc.update(SUPER, 'm-1', { role: 'FULL' }, META, OPEN_GATE);
    expect(prisma.membership.update).toHaveBeenCalledWith({
      where: { id: 'm-1' },
      data: { role: 'FULL' },
    });
  });

  it('rejects an override for a CLIENT_USER on update', async () => {
    const { prisma, svc } = existing('CLIENT_USER');
    await expect(
      svc.update(SUPER, 'm-1', { passwordAccess: 'deny' }, META, OPEN_GATE),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.membership.update).not.toHaveBeenCalled();
  });

  it('audits the override that a revoke ends', async () => {
    const prisma = makePrismaMock();
    const audit = makeAudit();
    prisma.membership.findUnique.mockResolvedValue({
      id: 'm-1',
      userId: USER_ID,
      companyId: COMPANY_ID,
      revokedAt: null,
      passwordAccess: 'deny',
    });
    prisma.membership.update.mockResolvedValue({ id: 'm-1', revokedAt: new Date() });
    const svc = new MembershipsService(prisma as never, audit as never, makeCache() as never);
    await svc.revoke(SUPER, 'm-1', META, OPEN_GATE);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'membership.revoke',
        before: expect.objectContaining({ passwordAccess: 'deny' }),
      }),
    );
  });
});

/**
 * Review finding: the step-up decision must run on the same row the write
 * changes. The service locks the row, reads it, runs the gate, and only
 * then writes, all in 1 transaction.
 */
describe('MembershipsService — step-up gate runs on the locked row', () => {
  function locked(passwordAccess: string, expiresAt: Date | null = null) {
    const prisma = makePrismaMock();
    const order: string[] = [];
    prisma.$queryRaw.mockImplementation(async () => {
      order.push('lock');
      return [];
    });
    prisma.membership.findUnique.mockImplementation(async () => {
      order.push('read');
      return {
        id: 'm-1',
        userId: USER_ID,
        companyId: COMPANY_ID,
        revokedAt: null,
        role: 'READONLY',
        expiresAt,
        passwordAccess,
        user: { role: 'OPERATOR' },
      };
    });
    prisma.membership.update.mockImplementation(async ({ data }) => {
      order.push('write');
      return { id: 'm-1', role: 'READONLY', expiresAt, passwordAccess, ...data };
    });
    const audit = makeAudit();
    const cache = makeCache();
    const svc = new MembershipsService(prisma as never, audit as never, cache as never);
    return { prisma, audit, cache, svc, order };
  }

  it('locks, reads, gates, then writes for an update', async () => {
    const { svc, order } = locked('deny');
    const gate = jest.fn(async () => {
      order.push('gate');
    });
    await svc.update(SUPER, 'm-1', { passwordAccess: 'allow' }, META, gate);
    expect(order).toEqual(['lock', 'read', 'gate', 'write']);
    // The gate sees the row read under the lock, not a value from the caller.
    expect(gate).toHaveBeenCalledWith({ passwordAccess: 'deny', expiresAt: null });
  });

  it('locks, reads, gates, then writes for a revoke', async () => {
    const { svc, order } = locked('deny');
    const gate = jest.fn(async () => {
      order.push('gate');
    });
    await svc.revoke(SUPER, 'm-1', META, gate);
    expect(order).toEqual(['lock', 'read', 'gate', 'write']);
    expect(gate).toHaveBeenCalledWith({ passwordAccess: 'deny', expiresAt: null });
  });

  it('writes, invalidates and audits nothing when the gate refuses an update', async () => {
    const { prisma, audit, cache, svc } = locked('deny');
    const refuse = jest.fn(async () => {
      throw new ForbiddenException('step-up');
    });
    await expect(
      svc.update(SUPER, 'm-1', { passwordAccess: 'allow' }, META, refuse),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.membership.update).not.toHaveBeenCalled();
    expect(cache.invalidate).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('writes, invalidates and audits nothing when the gate refuses a revoke', async () => {
    const { prisma, audit, cache, svc } = locked('deny');
    const refuse = jest.fn(async () => {
      throw new ForbiddenException('step-up');
    });
    await expect(svc.revoke(SUPER, 'm-1', META, refuse)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.membership.update).not.toHaveBeenCalled();
    expect(cache.invalidate).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
});

describe('MembershipsService.create — concurrent reactivation and create', () => {
  function revokedRowSetup() {
    const prisma = makePrismaMock();
    const audit = makeAudit();
    const cache = makeCache();
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, isActive: true, role: 'OPERATOR' });
    prisma.company.findUnique.mockResolvedValue({ id: COMPANY_ID });
    prisma.membership.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'm-revoked',
      revokedAt: new Date('2020-01-01'),
      role: 'READONLY',
      expiresAt: null,
      passwordAccess: 'inherit',
    });
    const svc = new MembershipsService(prisma as never, audit as never, cache as never);
    return { prisma, audit, cache, svc };
  }

  it('returns 409 and writes nothing more when another request reactivated the row first', async () => {
    const { prisma, audit, cache, svc } = revokedRowSetup();
    // The row is no longer revoked when this request writes.
    prisma.membership.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      svc.create(SUPER, COMPANY_ID, { userId: USER_ID, role: 'FULL' }, META),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.membership.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(prisma.membership.update).not.toHaveBeenCalled();
    expect(cache.invalidate).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('returns 409 when a concurrent fresh create wins the unique index', async () => {
    const prisma = makePrismaMock();
    const audit = makeAudit();
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, isActive: true, role: 'OPERATOR' });
    prisma.company.findUnique.mockResolvedValue({ id: COMPANY_ID });
    prisma.membership.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    prisma.membership.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    const svc = new MembershipsService(prisma as never, audit as never, makeCache() as never);

    await expect(
      svc.create(SUPER, COMPANY_ID, { userId: USER_ID, role: 'FULL' }, META),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(audit.log).not.toHaveBeenCalled();
  });
});
