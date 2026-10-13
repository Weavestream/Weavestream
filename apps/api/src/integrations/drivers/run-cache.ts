import { DriverRateLimitError, type IntegrationContext } from './integration-driver.js';
import type { Lookup } from './section-rows.js';

/**
 * Per-run lookup cache shared by the drivers that page several resources
 * off the same tenant lookups (licences, usage reports, ...).
 *
 * ponytail: single process, per run. Keyed by integration + connection +
 * snapshot so every page of one run shares one fetch; entries expire after
 * the TTL. The connection is part of the key because one OAuth integration
 * serves several client tenants: two tenants never share a lookup.
 */
const RUN_CACHE_TTL_MS = 15 * 60_000;
const runCache = new Map<string, { expiresAt: number; value: Promise<unknown> }>();

/** @internal only `*.spec.ts` should call this. */
export function __resetRunCacheForTests(): void {
  runCache.clear();
}

/** @internal only `*.spec.ts` should call this. */
export function __runCacheSizeForTests(): number {
  return runCache.size;
}

function prefixOf(ctx: IntegrationContext, snapshotAt: string): string {
  return `${ctx.integrationId ?? ctx.correlationId}\0${ctx.connectionId ?? ''}\0${snapshotAt}\0`;
}

/** Drops every cached lookup of one run (called when a resource finishes). */
export function evictRun(ctx: IntegrationContext, snapshotAt: string): void {
  const prefix = prefixOf(ctx, snapshotAt);
  for (const key of runCache.keys()) if (key.startsWith(prefix)) runCache.delete(key);
}

export function runCached<T>(ctx: IntegrationContext, snapshotAt: string, name: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  for (const [key, entry] of runCache) if (entry.expiresAt <= now) runCache.delete(key);
  const key = `${prefixOf(ctx, snapshotAt)}${name}`;
  const hit = runCache.get(key);
  if (hit) return hit.value as Promise<T>;
  const value = load();
  runCache.set(key, { expiresAt: now + RUN_CACHE_TTL_MS, value });
  // A failed load is not cached; the next page retries it.
  value.catch(() => runCache.delete(key));
  return value;
}

/**
 * Optional data: any failure becomes a note, never a failed run. Only a
 * rate limit propagates, so the runner retries the page later. Errors for
 * which `fixedText` is true carry our own operator-safe message and are
 * shown as is; anything else gets the generic `unavailable` note.
 */
export async function optional<T>(
  load: () => Promise<T | null>,
  unavailable: string,
  fixedText: (e: unknown) => boolean,
): Promise<Lookup<T>> {
  try {
    const value = await load();
    return value === null ? { ok: false, reason: unavailable } : { ok: true, value };
  } catch (e) {
    if (e instanceof DriverRateLimitError) throw e;
    if (fixedText(e)) return { ok: false, reason: (e as Error).message };
    return { ok: false, reason: unavailable };
  }
}
