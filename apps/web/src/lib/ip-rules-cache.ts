import type { IpRuleLike } from '@weavestream/shared';

/**
 * Module-level cache of the active IP allow/deny rules, polled from
 * the API's internal `/ip-rules/active` endpoint so the Next.js
 * `proxy.ts` can block page renders the same way `IpRuleGuard` blocks
 * API calls.
 *
 * Cache semantics:
 *   - 30s TTL (matches `IpRuleCacheService.CACHE_TTL_MS` on the API).
 *   - Single in-flight refresh — concurrent callers share one fetch.
 *   - Fail-open: on fetch error, last-known rules are returned (or an
 *     empty array if we've never succeeded). Matches `IpRuleGuard`'s
 *     fail-open posture so a broken API can't lock everyone out of
 *     even the login page.
 *
 * Propagation: an admin add/remove takes up to 30s to reach the web
 * layer (the API still enforces immediately on its own endpoints).
 */

const TTL_MS = 30_000;
const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://api:4000';

let cached: IpRuleLike[] = [];
let fetchedAt = 0;
let everSucceeded = false;
let inflight: Promise<IpRuleLike[]> | null = null;

export async function getActiveIpRules(): Promise<IpRuleLike[]> {
  const now = Date.now();
  if (everSucceeded && now - fetchedAt < TTL_MS) {
    return cached;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const res = await fetch(`${API_INTERNAL_URL}/api/v1/ip-rules/active`, {
        method: 'GET',
        // Don't let Next's data cache memoize this; we manage the TTL
        // ourselves so admin writes propagate predictably.
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        throw new Error(`upstream returned ${res.status}`);
      }
      const body = (await res.json()) as { rules?: IpRuleLike[] };
      const rules = Array.isArray(body.rules) ? body.rules : [];
      cached = rules;
      fetchedAt = Date.now();
      everSucceeded = true;
      return rules;
    } catch (err) {
      // Fail-open: serve the last known good ruleset (or [] on cold
      // start). Log once at warn level so it doesn't drown out other
      // signals if the API is down.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[ip-rules-cache] failed to refresh active rules — falling back to last-known (${cached.length} rules): ${message}`,
      );
      // Treat the failure as a partial success for TTL purposes so we
      // don't hammer a down API every page render. Retry on next TTL.
      fetchedAt = Date.now();
      return cached;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}
