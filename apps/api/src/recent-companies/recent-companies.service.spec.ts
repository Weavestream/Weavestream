import { NotFoundException } from '@nestjs/common';
import { RecentCompaniesService } from './recent-companies.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * Access-scoping coverage for `/me/recent-companies`.
 *
 * The recents list is metadata-bearing (company names), so which
 * companies it may draw from is a security property. These tests pin
 * three things: the write path 404s identically for "no access" and
 * "does not exist" (no id probing), the read path re-filters stored
 * ids through the membership predicate on every call (a revoked
 * membership drops the row even though the id stays in Redis), and
 * the predicate — the shared `allowedCompanyIds` helper in
 * `rbac/permission.service.ts`, same as `StarsService` and
 * `CompaniesService` — requires unrevoked AND unexpired.
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

const KEY = 'user:actor-1:recent-companies:v1';
const TTL = 90 * 24 * 60 * 60;

function makePrisma() {
  return {
    membership: { findMany: jest.fn().mockResolvedValue([]) },
    company: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
}

function makeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    client: {
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
    },
  };
}

function svcWith(
  prisma: ReturnType<typeof makePrisma>,
  redis: ReturnType<typeof makeRedis>,
) {
  return new RecentCompaniesService(prisma as never, redis as never);
}

describe('RecentCompaniesService.record', () => {
  it('stores the visit under the per-user key with a TTL', async () => {
    const prisma = makePrisma();
    const redis = makeRedis();
    prisma.company.findFirst.mockResolvedValue({ id: 'c-1' });

    await svcWith(prisma, redis).record(SUPER_ADMIN, 'c-1');

    expect(redis.client.set).toHaveBeenCalledWith(
      KEY,
      JSON.stringify(['c-1']),
      'EX',
      TTL,
    );
  });

  it('dedupes a revisit to the front and caps the list at 8', async () => {
    const prisma = makePrisma();
    const redis = makeRedis();
    prisma.company.findFirst.mockResolvedValue({ id: 'c-9' });
    redis.store.set(
      KEY,
      JSON.stringify(['c-8', 'c-7', 'c-6', 'c-5', 'c-4', 'c-3', 'c-2', 'c-1']),
    );

    const svc = svcWith(prisma, redis);
    await svc.record(SUPER_ADMIN, 'c-9');
    expect(JSON.parse(redis.store.get(KEY)!)).toEqual([
      'c-9',
      'c-8',
      'c-7',
      'c-6',
      'c-5',
      'c-4',
      'c-3',
      'c-2',
    ]);

    prisma.company.findFirst.mockResolvedValue({ id: 'c-7' });
    await svc.record(SUPER_ADMIN, 'c-7');
    expect(JSON.parse(redis.store.get(KEY)!)).toEqual([
      'c-7',
      'c-9',
      'c-8',
      'c-6',
      'c-5',
      'c-4',
      'c-3',
      'c-2',
    ]);
  });

  it('404s for a member without a membership, before the existence probe', async () => {
    const prisma = makePrisma();
    const redis = makeRedis();
    prisma.company.findFirst.mockResolvedValue({ id: 'c-1' });

    await expect(
      svcWith(prisma, redis).record(MEMBER, 'c-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    // The membership gate answers first so the endpoint cannot be
    // used to probe which company ids exist.
    expect(prisma.company.findFirst).not.toHaveBeenCalled();
    expect(redis.client.set).not.toHaveBeenCalled();
  });

  it('404s identically for a nonexistent company', async () => {
    const prisma = makePrisma();
    const redis = makeRedis();

    await expect(
      svcWith(prisma, redis).record(SUPER_ADMIN, 'c-gone'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(redis.client.set).not.toHaveBeenCalled();
  });

  it('records for a member with an active membership, using the shared predicate', async () => {
    const prisma = makePrisma();
    const redis = makeRedis();
    prisma.membership.findMany.mockResolvedValue([{ companyId: 'c-1' }]);
    prisma.company.findFirst.mockResolvedValue({ id: 'c-1' });

    await svcWith(prisma, redis).record(MEMBER, 'c-1');

    expect(redis.client.set).toHaveBeenCalled();
    const where = prisma.membership.findMany.mock.calls[0]![0]!.where as {
      userId: string;
      revokedAt: null;
      OR: unknown;
    };
    expect(where.userId).toBe('actor-1');
    expect(where.revokedAt).toBeNull();
    expect(where.OR).toEqual([
      { expiresAt: null },
      { expiresAt: { gt: expect.any(Date) } },
    ]);
  });
});

describe('RecentCompaniesService.list', () => {
  it('returns empty without touching Prisma when nothing is stored', async () => {
    const prisma = makePrisma();
    const redis = makeRedis();

    await expect(svcWith(prisma, redis).list(SUPER_ADMIN)).resolves.toEqual({
      items: [],
    });
    expect(prisma.membership.findMany).not.toHaveBeenCalled();
    expect(prisma.company.findMany).not.toHaveBeenCalled();
  });

  it('preserves recency order and drops deleted companies', async () => {
    const prisma = makePrisma();
    const redis = makeRedis();
    redis.store.set(KEY, JSON.stringify(['c-2', 'c-gone', 'c-1']));
    // DB returns rows in its own order; recency must come from Redis.
    prisma.company.findMany.mockResolvedValue([
      { id: 'c-1', name: 'Alpha' },
      { id: 'c-2', name: 'Beta' },
    ]);

    await expect(svcWith(prisma, redis).list(SUPER_ADMIN)).resolves.toEqual({
      items: [
        { id: 'c-2', name: 'Beta' },
        { id: 'c-1', name: 'Alpha' },
      ],
    });
  });

  it('filters stored ids through the membership scope before querying names', async () => {
    const prisma = makePrisma();
    const redis = makeRedis();
    redis.store.set(KEY, JSON.stringify(['c-secret', 'c-1']));
    prisma.membership.findMany.mockResolvedValue([{ companyId: 'c-1' }]);
    prisma.company.findMany.mockResolvedValue([{ id: 'c-1', name: 'Alpha' }]);

    await expect(svcWith(prisma, redis).list(MEMBER)).resolves.toEqual({
      items: [{ id: 'c-1', name: 'Alpha' }],
    });
    // The inaccessible id never reaches the name query.
    const where = prisma.company.findMany.mock.calls[0]![0]!.where as {
      id: { in: string[] };
    };
    expect(where.id.in).toEqual(['c-1']);
  });

  it('returns empty for a member with no visible entries, skipping the name query', async () => {
    const prisma = makePrisma();
    const redis = makeRedis();
    redis.store.set(KEY, JSON.stringify(['c-secret']));

    await expect(svcWith(prisma, redis).list(MEMBER)).resolves.toEqual({
      items: [],
    });
    expect(prisma.company.findMany).not.toHaveBeenCalled();
  });

  it('treats corrupt or wrong-shape blobs as empty', async () => {
    const prisma = makePrisma();
    const redis = makeRedis();
    const svc = svcWith(prisma, redis);

    redis.store.set(KEY, 'not json{');
    await expect(svc.list(SUPER_ADMIN)).resolves.toEqual({ items: [] });

    redis.store.set(KEY, JSON.stringify({ id: 'c-1' }));
    await expect(svc.list(SUPER_ADMIN)).resolves.toEqual({ items: [] });

    redis.store.set(KEY, JSON.stringify(['c-1', 42, null]));
    prisma.company.findMany.mockResolvedValue([{ id: 'c-1', name: 'Alpha' }]);
    await expect(svc.list(SUPER_ADMIN)).resolves.toEqual({
      items: [{ id: 'c-1', name: 'Alpha' }],
    });
  });
});
