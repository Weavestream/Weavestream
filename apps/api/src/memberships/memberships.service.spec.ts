import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { MembershipsService } from './memberships.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

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
  return {
    membership: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    user: { findUnique: jest.fn() },
    company: { findUnique: jest.fn() },
  };
}

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
    prisma.membership.update.mockResolvedValue({
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
    expect(prisma.membership.update).toHaveBeenCalledWith({
      where: { id: 'm-revoked' },
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
    await svc.revoke(SUPER, 'm-1', META);

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
    await expect(svc.revoke(SUPER, 'm-1', META)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s on unknown membership id (IDOR probe)', async () => {
    const prisma = makePrismaMock();
    prisma.membership.findUnique.mockResolvedValue(null);

    const svc = new MembershipsService(prisma as never, makeAudit() as never, makeCache() as never);
    await expect(svc.revoke(SUPER, 'does-not-exist', META)).rejects.toBeInstanceOf(NotFoundException);
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
    await svc.update(SUPER, 'm-1', { role: 'FULL' }, META);

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
      svc.update(SUPER, 'm-1', { role: 'FULL' }, META),
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
