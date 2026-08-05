import {
  INTERNAL_TOKEN_HEADER,
  deriveInternalApiToken,
  type IpRuleBlockedReport,
} from '@weavestream/shared';
import { API_INTERNAL_URL, COOKIE_SIGNING_KEY } from './api-config';

/**
 * Fire-and-forget report of a page load the proxy denied under a DENY
 * IP rule. Those requests never reach the API, so without this report
 * they would be invisible to the audit trail and to the "IP blocked or
 * rate limited" security alert. Called from `proxy.ts` via
 * `event.waitUntil(...)` so the work survives the already-returned 403.
 *
 * Design constraints (mirrors `ip-rules-cache.ts`):
 *   - Internal auth: `x-ws-internal-token` derived from
 *     COOKIE_SIGNING_KEY, memoized. No key → no report (the API would
 *     reject it anyway); the 403 to the client is unaffected.
 *   - The blocked IP travels in the JSON BODY, never in
 *     `x-forwarded-for`: `IpRuleGuard` runs on every API request and
 *     would 403 a report that presents the denied IP as its own.
 *   - Local cooldown: one report per (ip, cidr) per window so a blocked
 *     client hammering the web tier doesn't turn into an internal POST
 *     per 403. The API coalesces again server-side (Redis), so this map
 *     is purely a network-traffic bound — best-effort, per-instance,
 *     size-capped with oldest-first eviction.
 *   - All failures are swallowed after a single console.warn per
 *     process — a lost report costs one alert email; the deny stands.
 */

const COOLDOWN_MS = 15 * 60_000;
const MAX_COOLDOWN_ENTRIES = 1_000;

const lastReportedAt = new Map<string, number>();
let tokenPromise: Promise<string> | null = null;
let warnedFailure = false;

function resolveInternalToken(): Promise<string> | null {
  if (!COOKIE_SIGNING_KEY) return null;
  if (!tokenPromise) {
    tokenPromise = deriveInternalApiToken(COOKIE_SIGNING_KEY);
  }
  return tokenPromise;
}

function underCooldown(key: string, now: number): boolean {
  const last = lastReportedAt.get(key);
  return last !== undefined && now - last < COOLDOWN_MS;
}

function rememberReport(key: string, now: number): void {
  if (lastReportedAt.size >= MAX_COOLDOWN_ENTRIES) {
    // Maps iterate in insertion order — drop the oldest entry. Crude
    // but bounded; the API-side Redis gate is the real dedup.
    const oldest = lastReportedAt.keys().next().value;
    if (oldest !== undefined) lastReportedAt.delete(oldest);
  }
  lastReportedAt.set(key, now);
}

export async function reportIpBlock(input: IpRuleBlockedReport): Promise<void> {
  try {
    const now = Date.now();
    const cooldownKey = `${input.ip}|${input.cidr}`;
    if (underCooldown(cooldownKey, now)) return;

    const token = await resolveInternalToken();
    if (!token) return;

    rememberReport(cooldownKey, now);
    const res = await fetch(`${API_INTERNAL_URL}/api/v1/ip-rules/blocked-report`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        [INTERNAL_TOKEN_HEADER]: token,
      },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      throw new Error(`upstream returned ${res.status}`);
    }
  } catch (err) {
    if (!warnedFailure) {
      warnedFailure = true;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[ip-block-report] failed to report blocked page hit (further failures silent): ${message}`,
      );
    }
  }
}

/** Test-only: reset module state between cases. */
export function __resetIpBlockReportStateForTests(): void {
  lastReportedAt.clear();
  tokenPromise = null;
  warnedFailure = false;
}
