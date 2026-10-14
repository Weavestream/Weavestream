import { PermissionService, type PermissionInput } from './permission.service.js';
import { MembershipCacheService } from '../cache/membership-cache.service.js';
import { inMemoryRedis } from '../cache/in-memory-redis.testing.js';

const COMPANY = 'c-1';
const FULL = [{ companyId: COMPANY, role: 'FULL', expiresAt: null, revokedAt: null }];
const READONLY = [{ companyId: COMPANY, role: 'READONLY', expiresAt: null, revokedAt: null }];

function setup() {
  const redis = inMemoryRedis();
  const cache = new MembershipCacheService(redis as never);
  const prisma = { membership: { findMany: jest.fn() } };
  return { redis, cache, prisma, svc: new PermissionService(prisma as never, cache) };
}

const CONTRACTOR: PermissionInput = {
  id: 'u-1',
  role: 'CONTRACTOR',
  globalAccess: null,
  platformCapabilities: [],
};

const canWrite = (svc: PermissionService, user: PermissionInput = CONTRACTOR) =>
  svc.can(user, 'asset.write', { companyId: COMPANY }).then((d) => d.allowed);

describe('PermissionService membership cache', () => {
  it('serves an interactive session from the cache until invalidated', async () => {
    const { cache, prisma, svc } = setup();
    prisma.membership.findMany.mockResolvedValueOnce(FULL).mockResolvedValueOnce(READONLY);
    expect(await canWrite(svc)).toBe(true);
    expect(await canWrite(svc)).toBe(true);
    expect(prisma.membership.findMany).toHaveBeenCalledTimes(1);
    await cache.invalidate('u-1');
    expect(await canWrite(svc)).toBe(false);
  });

  it('a browser load that read FULL before a downgrade cannot restore write access', async () => {
    const { cache, prisma, svc } = setup();
    // Browser request misses and reads FULL; its result is held back.
    let release!: () => void;
    prisma.membership.findMany.mockImplementationOnce(
      () => new Promise((r) => (release = () => r(FULL))),
    );
    const stale = canWrite(svc);
    await new Promise((r) => setImmediate(r));
    // The downgrade commits and invalidates; the database now says READONLY.
    prisma.membership.findMany.mockResolvedValue(READONLY);
    await cache.invalidate('u-1');
    // The stale load finishes and writes its FULL snapshot to the cache.
    release();
    expect(await stale).toBe(true);
    // Every later browser request is still denied.
    expect(await canWrite(svc)).toBe(false);
    expect(await canWrite(svc)).toBe(false);
  });

  it.each([
    ['API key', { apiKeyId: 'k-1' }],
    ['remote MCP connection', { mcpConnectionId: 'mc-1' }],
  ])('reads the database for a %s and never touches Redis', async (_label, marker) => {
    const { redis, prisma, svc } = setup();
    // The cache still says FULL from an earlier browser request.
    prisma.membership.findMany.mockResolvedValueOnce(FULL).mockResolvedValue(READONLY);
    await canWrite(svc);
    redis.client.mget.mockClear();
    redis.client.set.mockClear();

    expect(await canWrite(svc, { ...CONTRACTOR, ...marker })).toBe(false);
    expect(prisma.membership.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { userId: 'u-1' } }),
    );
    expect(redis.client.mget).not.toHaveBeenCalled();
    expect(redis.client.set).not.toHaveBeenCalled();
  });

  it('revives Dates from a cached snapshot', async () => {
    const { prisma, svc } = setup();
    const expiresAt = new Date('2030-01-01T00:00:00Z');
    prisma.membership.findMany.mockResolvedValue([{ ...READONLY[0], expiresAt }]);
    await svc.loadMemberships('u-1');
    const [cached] = await svc.loadMemberships('u-1');
    expect(prisma.membership.findMany).toHaveBeenCalledTimes(1);
    expect(cached?.expiresAt).toEqual(expiresAt);
  });
});
