import { Injectable } from '@nestjs/common';

export type CachedRule = { cidr: string; action: string; priority: number };

/**
 * Tiny shared cache for the IP allow/deny ruleset.
 *
 * Extracted from `IpRuleGuard` so that both the guard (reader) and
 * `IpRulesService` (writer) can depend on a single source of truth
 * without forming a circular dependency between guard and service.
 *
 * - The guard calls `get()`; on miss it loads via `IpRulesService`
 *   and stores the result with `set()`.
 * - The service calls `invalidate()` after every create/update/delete
 *   so the next request observes the new ruleset immediately within
 *   the same API instance. Multi-instance deployments tolerate up to
 *   `CACHE_TTL_MS` of staleness for writes from peer instances.
 */
@Injectable()
export class IpRuleCacheService {
  static readonly CACHE_TTL_MS = 30_000;

  private cached: CachedRule[] | null = null;
  private expiresAt = 0;

  get(): CachedRule[] | null {
    if (this.cached !== null && Date.now() < this.expiresAt) {
      return this.cached;
    }
    return null;
  }

  set(rules: CachedRule[]): void {
    this.cached = rules;
    this.expiresAt = Date.now() + IpRuleCacheService.CACHE_TTL_MS;
  }

  invalidate(): void {
    this.cached = null;
    this.expiresAt = 0;
  }
}
