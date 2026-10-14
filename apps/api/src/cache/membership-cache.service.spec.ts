import { MembershipCacheService } from './membership-cache.service.js';
import { inMemoryRedis } from './in-memory-redis.testing.js';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function setup() {
  const redis = inMemoryRedis();
  return { redis, cache: new MembershipCacheService(redis as never) };
}

const KEY = MembershipCacheService.key('u-1');

describe('MembershipCacheService.readThrough', () => {
  it('loads once, then serves the cached value', async () => {
    const { cache } = setup();
    const load = jest.fn().mockResolvedValue(['c-1']);
    expect(await cache.readThrough('u-1', KEY, load)).toEqual(['c-1']);
    expect(await cache.readThrough('u-1', KEY, load)).toEqual(['c-1']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reloads after invalidate', async () => {
    const { cache } = setup();
    const load = jest.fn().mockResolvedValueOnce(['c-1']).mockResolvedValueOnce([]);
    await cache.readThrough('u-1', KEY, load);
    await cache.invalidate('u-1');
    expect(await cache.readThrough('u-1', KEY, load)).toEqual([]);
  });

  it('never serves a load that started before an invalidate, even if it is written after', async () => {
    const { cache } = setup();
    // Request A misses and starts reading the database (old rows).
    const oldRows = deferred<string[]>();
    const a = cache.readThrough('u-1', KEY, () => oldRows.promise);
    await new Promise((r) => setImmediate(r));
    // The membership write commits and invalidates.
    await cache.invalidate('u-1');
    // A's old rows arrive and are written to the cache after the invalidate.
    oldRows.resolve(['c-1', 'c-revoked']);
    expect(await a).toEqual(['c-1', 'c-revoked']);
    // The next request must not trust them.
    const load = jest.fn().mockResolvedValue(['c-1']);
    expect(await cache.readThrough('u-1', KEY, load)).toEqual(['c-1']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('treats a lost generation key as a miss for every older entry', async () => {
    const { redis, cache } = setup();
    await cache.readThrough('u-1', KEY, async () => ['old']);
    redis.client.store.delete(MembershipCacheService.generationKey('u-1'));
    const load = jest.fn().mockResolvedValue(['new']);
    expect(await cache.readThrough('u-1', KEY, load)).toEqual(['new']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('ignores entries in the old unstamped format', async () => {
    const { redis, cache } = setup();
    redis.client.store.set(KEY, JSON.stringify(['stale']));
    expect(await cache.readThrough('u-1', KEY, async () => ['fresh'])).toEqual(['fresh']);
  });

  it('applies revive to cached values only', async () => {
    const { cache } = setup();
    const revive = jest.fn((raw: unknown) => (raw as string[]).map((s) => s.toUpperCase()));
    expect(await cache.readThrough('u-1', KEY, async () => ['a'], { revive })).toEqual(['a']);
    expect(await cache.readThrough('u-1', KEY, async () => ['x'], { revive })).toEqual(['A']);
  });

  it('with fresh, never touches Redis', async () => {
    const { redis, cache } = setup();
    expect(await cache.readThrough('u-1', KEY, async () => ['c-1'], { fresh: true })).toEqual([
      'c-1',
    ]);
    expect(redis.client.mget).not.toHaveBeenCalled();
    expect(redis.client.set).not.toHaveBeenCalled();
  });
});

describe('MembershipCacheService.invalidate', () => {
  it('rotates the generation and clears both caches for each distinct user', async () => {
    const { redis, cache } = setup();
    await cache.readThrough('u-1', KEY, async () => []);
    const gen = redis.client.store.get(MembershipCacheService.generationKey('u-1'));
    await cache.invalidateMany(['u-1', 'u-2', 'u-1']);
    expect(redis.client.store.get(MembershipCacheService.generationKey('u-1'))).not.toEqual(gen);
    expect(redis.client.store.has(MembershipCacheService.generationKey('u-2'))).toBe(true);
    expect(redis.client.del).toHaveBeenCalledTimes(2);
    expect(redis.client.del).toHaveBeenCalledWith(
      MembershipCacheService.key('u-1'),
      MembershipCacheService.snapshotKey('u-1'),
    );
  });

  it('does not call Redis for an empty set', async () => {
    const { redis, cache } = setup();
    await cache.invalidateMany([]);
    expect(redis.client.multi).not.toHaveBeenCalled();
  });

  it('throws when the MULTI fails, so the caller sees it', async () => {
    const { redis, cache } = setup();
    redis.client.multi.mockReturnValueOnce({
      set: () => undefined,
      del: () => undefined,
      exec: async () => [[new Error('READONLY'), null]],
    } as never);
    await expect(cache.invalidate('u-1')).rejects.toThrow('READONLY');
  });
});
