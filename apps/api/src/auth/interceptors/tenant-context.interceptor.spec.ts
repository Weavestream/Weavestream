import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, Observable } from 'rxjs';
import { getTenantContext } from '@weavestream/shared/server';
import { TenantContextInterceptor } from './tenant-context.interceptor.js';
import { MembershipCacheService } from '../../cache/membership-cache.service.js';
import { inMemoryRedis } from '../../cache/in-memory-redis.testing.js';

function setup() {
  const redis = inMemoryRedis();
  const cache = new MembershipCacheService(redis as never);
  const prisma = {
    membership: {
      // First read: before the revocation. Later reads: after it.
      findMany: jest
        .fn()
        .mockResolvedValueOnce([{ companyId: 'c-1' }, { companyId: 'c-revoked' }])
        .mockResolvedValue([{ companyId: 'c-1' }]),
    },
  };
  return { redis, cache, prisma, interceptor: new TenantContextInterceptor(prisma as never, cache) };
}

function makeCtx(user: Record<string, unknown>): ExecutionContext {
  const req = { user, id: 'req-1', headers: {}, socket: {} };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

/** Runs the interceptor and returns the allowedCompanyIds the handler saw. */
async function scopeSeen(
  interceptor: TenantContextInterceptor,
  user: Record<string, unknown>,
): Promise<string[] | undefined> {
  const next: CallHandler = {
    handle: () =>
      new Observable((s) => {
        s.next(getTenantContext()?.allowedCompanyIds);
        s.complete();
      }),
  };
  const out = await interceptor.intercept(makeCtx(user), next);
  return (await lastValueFrom(out)) as string[] | undefined;
}

const USER = {
  id: 'u-1',
  email: 'u@x',
  role: 'CONTRACTOR',
  globalAccess: null,
  platformCapabilities: [],
};

describe('TenantContextInterceptor membership scope', () => {
  it('serves an interactive session from the cache until invalidated', async () => {
    const { cache, prisma, interceptor } = setup();
    expect(await scopeSeen(interceptor, USER)).toEqual(['c-1', 'c-revoked']);
    expect(await scopeSeen(interceptor, USER)).toEqual(['c-1', 'c-revoked']);
    expect(prisma.membership.findMany).toHaveBeenCalledTimes(1);
    await cache.invalidate('u-1');
    expect(await scopeSeen(interceptor, USER)).toEqual(['c-1']);
  });

  it.each([
    ['API key', { apiKeyId: 'k-1' }],
    ['remote MCP connection', { mcpConnectionId: 'mc-1' }],
  ])('scopes a %s from the database, never Redis', async (_label, marker) => {
    const { redis, prisma, interceptor } = setup();
    // A browser request cached the pre-revocation scope.
    await scopeSeen(interceptor, USER);
    redis.client.mget.mockClear();
    redis.client.set.mockClear();

    expect(await scopeSeen(interceptor, { ...USER, ...marker })).toEqual(['c-1']);
    expect(prisma.membership.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'u-1', revokedAt: null }),
      }),
    );
    expect(redis.client.mget).not.toHaveBeenCalled();
    expect(redis.client.set).not.toHaveBeenCalled();
  });
});
