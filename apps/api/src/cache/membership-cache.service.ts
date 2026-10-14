import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service.js';

/**
 * Owns the two per-user membership caches and the only way to read them:
 *
 *  - `key` — the active company ids the TenantContextInterceptor scopes
 *    queries with.
 *  - `snapshotKey` — every membership row (role, expiry, revocation) that
 *    `PermissionService.can` decides per-action FULL/READONLY access from.
 *
 * Every write that changes a user's memberships or global role must call
 * `invalidate(userId)` after it commits.
 *
 * Deleting the keys alone is not enough. A request that missed the cache and
 * read the database just before the write commits would store its old rows
 * just after the delete, and every later request would trust them until the
 * TTL ran out. So each user also has a generation token: `invalidate`
 * replaces it with a new random value, `readThrough` stamps an entry with the
 * token it saw *before* loading, and an entry whose stamp is not the current
 * token is a miss. An old load can still be written, but never served.
 *
 * Tokens are random rather than a counter so losing the generation key
 * (TTL, eviction, flush) is safe: the next read mints a fresh token and every
 * older entry misses. A counter would restart at a value an old entry might
 * still carry.
 *
 * Programmatic principals (API keys, remote MCP connections) pass `fresh`
 * and never touch Redis — see `isProgrammatic`. A browser session tolerates
 * a cache; a key running unattended reads the database every request.
 */
@Injectable()
export class MembershipCacheService {
  // v2: generation-stamped envelope.
  private static readonly VERSION = 'v2';
  // v2: bumped when the membership-role enum collapsed to FULL/READONLY.
  // v3: generation-stamped envelope.
  private static readonly SNAPSHOT_VERSION = 'v3';

  /** Entry TTL for both caches. */
  static readonly TTL_SEC = 60;
  /**
   * Generation-token TTL. Any value is safe (see above); longer only means
   * fewer token re-mints for idle users.
   */
  private static readonly GENERATION_TTL_SEC = 86_400;

  constructor(private readonly redis: RedisService) {}

  static key(userId: string): string {
    return `user:${userId}:memberships:${MembershipCacheService.VERSION}`;
  }

  static snapshotKey(userId: string): string {
    return `user:${userId}:memberships:full:${MembershipCacheService.SNAPSHOT_VERSION}`;
  }

  static generationKey(userId: string): string {
    return `user:${userId}:memberships:gen`;
  }

  /**
   * Serve `key` from the cache when its entry carries the user's current
   * generation; otherwise run `load` and store the result stamped with the
   * generation read before `load` started. `fresh` skips Redis entirely.
   *
   * `revive` rebuilds non-JSON types (e.g. Dates) from a cached value.
   */
  async readThrough<T>(
    userId: string,
    key: string,
    load: () => Promise<T>,
    { fresh = false, revive }: { fresh?: boolean; revive?: (raw: unknown) => T } = {},
  ): Promise<T> {
    if (fresh) return load();

    const genKey = MembershipCacheService.generationKey(userId);
    const [raw, gen] = await this.redis.client.mget(key, genKey);
    const generation = gen ?? (await this.mintGeneration(genKey));
    if (raw && gen) {
      try {
        const entry = JSON.parse(raw) as { g?: unknown; v?: unknown };
        if (entry.g === generation) {
          return revive ? revive(entry.v) : (entry.v as T);
        }
      } catch {
        // Unreadable entry: treat as a miss and overwrite it below.
      }
    }

    const value = await load();
    await this.redis.client.set(
      key,
      JSON.stringify({ g: generation, v: value }),
      'EX',
      MembershipCacheService.TTL_SEC,
    );
    return value;
  }

  /**
   * Create the generation token if none exists and return whichever token
   * is current. `NX` keeps a racing `invalidate` (or another reader) from
   * being overwritten.
   */
  private async mintGeneration(genKey: string): Promise<string> {
    await this.redis.client.set(
      genKey,
      randomUUID(),
      'EX',
      MembershipCacheService.GENERATION_TTL_SEC,
      'NX',
    );
    // Missing again only if it expired in between; then this load is simply
    // not servable, which is safe.
    return (await this.redis.client.get(genKey)) ?? randomUUID();
  }

  async invalidate(userId: string): Promise<void> {
    await this.invalidateMany([userId]);
  }

  async invalidateMany(userIds: Iterable<string>): Promise<void> {
    const ids = Array.from(new Set(userIds));
    if (ids.length === 0) return;
    const tx = this.redis.client.multi();
    for (const id of ids) {
      // The new token is what makes any in-flight load unservable; the
      // delete only frees memory early.
      tx.set(
        MembershipCacheService.generationKey(id),
        randomUUID(),
        'EX',
        MembershipCacheService.GENERATION_TTL_SEC,
      );
      tx.del(MembershipCacheService.key(id), MembershipCacheService.snapshotKey(id));
    }
    const results = await tx.exec();
    const failed = results?.find(([err]) => err);
    if (!results || failed) {
      throw failed?.[0] ?? new Error('membership cache invalidation was aborted');
    }
  }
}
