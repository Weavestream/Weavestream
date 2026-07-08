import {
  INTERNAL_TOKEN_HEADER,
  deriveInternalApiToken,
  type IpRuleLike,
} from '@weavestream/shared';
import { API_INTERNAL_URL, COOKIE_SIGNING_KEY } from './api-config';

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

let cached: IpRuleLike[] = [];
let fetchedAt = 0;
let everSucceeded = false;
let inflight: Promise<IpRuleLike[]> | null = null;

// The internal-API token is derived from COOKIE_SIGNING_KEY once and
// reused. Returns null (and warns once) when the key isn't visible to the
// web container — the poll will then be rejected and page-layer IP rules
// fail open (the API still enforces on its own endpoints). (WS-028)
let tokenPromise: Promise<string> | null = null;
let warnedMissingKey = false;

function resolveInternalToken(): Promise<string> | null {
  if (!COOKIE_SIGNING_KEY) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      console.warn(
        '[ip-rules-cache] COOKIE_SIGNING_KEY not visible to web — internal poll will be rejected and page-layer IP rules fail open',
      );
    }
    return null;
  }
  if (!tokenPromise) {
    tokenPromise = deriveInternalApiToken(COOKIE_SIGNING_KEY);
  }
  return tokenPromise;
}

export async function getActiveIpRules(): Promise<IpRuleLike[]> {
  const now = Date.now();
  if (everSucceeded && now - fetchedAt < TTL_MS) {
    return cached;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const token = await resolveInternalToken();
      const headers: Record<string, string> = { accept: 'application/json' };
      if (token) headers[INTERNAL_TOKEN_HEADER] = token;
      const res = await fetch(`${API_INTERNAL_URL}/api/v1/ip-rules/active`, {
        method: 'GET',
        // Don't let Next's data cache memoize this; we manage the TTL
        // ourselves so admin writes propagate predictably.
        cache: 'no-store',
        headers,
      });
      if (!res.ok) {
        if (res.status === 403) {
          // The only loud signal that the shared secret is wrong: the
          // cache is fail-open, so a 403 otherwise silently degrades
          // page-layer IP enforcement.
          console.warn(
            '[ip-rules-cache] 403 from ip-rules/active — COOKIE_SIGNING_KEY likely missing or mismatched between web and api; page-layer IP enforcement is failing open',
          );
        }
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
