import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service.js';

/**
 * Centralizes the key shape for the membership cache that the
 * TenantContextInterceptor reads. Every write that changes a user's
 * memberships or global role must call `invalidate(userId)`.
 */
@Injectable()
export class MembershipCacheService {
  private static readonly VERSION = 'v1';

  constructor(private readonly redis: RedisService) {}

  static key(userId: string): string {
    return `user:${userId}:memberships:${MembershipCacheService.VERSION}`;
  }

  async invalidate(userId: string): Promise<void> {
    await this.redis.client.del(MembershipCacheService.key(userId));
  }

  async invalidateMany(userIds: Iterable<string>): Promise<void> {
    const keys = Array.from(new Set(userIds)).map((id) => MembershipCacheService.key(id));
    if (keys.length === 0) return;
    await this.redis.client.del(...keys);
  }
}
