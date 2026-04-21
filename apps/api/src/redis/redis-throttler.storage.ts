import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';

// Inlined to avoid importing from the deep subpath that 6.5 no longer re-exports.
interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttlMs: number,
    limit: number,
    blockDurationMs: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const fullKey = `throttle:${throttlerName}:${key}`;
    const blockKey = `throttle-block:${throttlerName}:${key}`;
    const now = Date.now();

    const blockedUntilRaw = await this.redis.get(blockKey);
    if (blockedUntilRaw) {
      const blockedUntil = parseInt(blockedUntilRaw, 10);
      if (blockedUntil > now) {
        return {
          totalHits: limit + 1,
          timeToExpire: 0,
          isBlocked: true,
          timeToBlockExpire: blockedUntil - now,
        };
      }
    }

    const multi = this.redis.multi();
    multi.incr(fullKey);
    multi.pttl(fullKey);
    const res = (await multi.exec()) ?? [];
    const hits = (res[0]?.[1] as number | null) ?? 0;
    let pttl = (res[1]?.[1] as number | null) ?? -1;

    if (hits === 1 || pttl < 0) {
      await this.redis.pexpire(fullKey, ttlMs);
      pttl = ttlMs;
    }

    if (hits > limit && blockDurationMs > 0) {
      const blockedUntil = now + blockDurationMs;
      await this.redis.set(blockKey, String(blockedUntil), 'PX', blockDurationMs);
      return {
        totalHits: hits,
        timeToExpire: pttl,
        isBlocked: true,
        timeToBlockExpire: blockDurationMs,
      };
    }

    return {
      totalHits: hits,
      timeToExpire: pttl,
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }
}
