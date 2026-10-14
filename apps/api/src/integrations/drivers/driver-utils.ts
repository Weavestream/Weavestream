import type { SourceFieldDto } from '@weavestream/shared';
import { fieldSlugSchema, layoutSlugSchema } from '@weavestream/shared';
import { DriverRateLimitError } from './integration-driver.js';
import type { RecommendedDestination } from './integration-driver.js';
import { safeFetch } from '../../common/egress/safe-fetch.js';

export interface FetchWithRetryOpts {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  /**
   * Default `'error'`: a 3xx comes back as a non-OK response and is never
   * followed. Integration APIs do not redirect, and safeFetch keeps every
   * header (API keys, bearer tokens) on a same-origin redirect.
   */
  redirect?: 'follow' | 'manual' | 'error';
  timeoutMs: number;
  maxRetries: number;
  backoffMs: number;
  correlationId: string;
  serviceName: string;
  /**
   * Space every attempt (retries included) at least `minIntervalMs` apart
   * across all callers that share `key`, so a provider that rate-limits
   * per account is never sent a burst.
   */
  pace?: RequestPace;
}

export interface RequestPace {
  /** One per upstream account (e.g. the integration id). Never a secret. */
  key: string;
  minIntervalMs: number;
}

/**
 * Next free request slot per pace key, and the time until which a 429
 * holds the key. ponytail: single process; a second API or worker process
 * paces on its own, and the 429 handling below still backs off if the
 * provider pushes back.
 */
const paceSlots = new Map<string, number>();
const paceHolds = new Map<string, number>();

/** @internal only `*.spec.ts` should call this. */
export function __resetRequestPaceForTests(): void {
  paceSlots.clear();
  paceHolds.clear();
}

/**
 * Waits for this key's next slot and reserves the one after it. A caller
 * that wakes inside a hold (a 429 arrived while it waited) queues again
 * behind the hold instead of sending.
 */
export async function awaitRequestSlot(pace: RequestPace): Promise<void> {
  for (;;) {
    const now = Date.now();
    for (const [key, slot] of paceSlots) if (slot <= now) paceSlots.delete(key);
    for (const [key, until] of paceHolds) if (until <= now) paceHolds.delete(key);
    const slot = Math.max(now, paceHolds.get(pace.key) ?? 0, paceSlots.get(pace.key) ?? 0);
    paceSlots.set(pace.key, slot + pace.minIntervalMs);
    if (slot > now) await sleep(slot - now);
    if ((paceHolds.get(pace.key) ?? 0) <= Date.now()) return;
  }
}

/** A rate-limit response holds every caller sharing the key until it may retry. */
function holdRequestSlots(pace: RequestPace, waitMs: number): void {
  const until = Date.now() + waitMs;
  if ((paceHolds.get(pace.key) ?? 0) < until) paceHolds.set(pace.key, until);
}

/**
 * Fetch with exponential-backoff retry on 429 + 5xx, honouring the
 * `Retry-After` header on rate-limit responses.
 */
export async function fetchWithRetry(
  url: string,
  opts: FetchWithRetryOpts,
): Promise<Response> {
  let attempt = 0;
  let lastErr: unknown = null;
  while (attempt <= opts.maxRetries) {
    try {
      if (opts.pace) await awaitRequestSlot(opts.pace);
      // safeFetch handles its own AbortController + timeout, validates
      // the resolved IPs against the egress blocklist, and caps the
      // response body. Operator-supplied integration baseUrls flow
      // through here, so the egress guard is the SSRF backstop.
      const res = await safeFetch(url, {
        method: opts.method,
        headers: opts.headers,
        body: opts.body,
        redirect: opts.redirect ?? 'error',
        timeoutMs: opts.timeoutMs,
      });
      if (res.status === 429) {
        const retryAfterRaw = res.headers.get('Retry-After');
        const retryAfterMs = parseRetryAfter(
          retryAfterRaw,
          opts.backoffMs * 2 ** attempt,
        );
        if (opts.pace) holdRequestSlots(opts.pace, retryAfterMs);
        if (attempt === opts.maxRetries) {
          throw new DriverRateLimitError(
            `${opts.serviceName} rate limited after ${opts.maxRetries + 1} attempts`,
            retryAfterMs,
          );
        }
        // A paced caller waits for its slot, which the hold above moved past the delay.
        if (!opts.pace) await sleep(retryAfterMs);
        attempt += 1;
        continue;
      }
      if (res.status >= 500 && res.status < 600) {
        if (attempt === opts.maxRetries) return res;
        await sleep(opts.backoffMs * 2 ** attempt);
        attempt += 1;
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (e instanceof DriverRateLimitError) throw e;
      // Egress blocks are deterministic — retrying the same operator
      // URL will never resolve to a different (public) IP, so bail
      // out immediately and let the caller surface the reason.
      if (e instanceof Error && e.name === 'EgressBlockedError') throw e;
      if (attempt === opts.maxRetries) break;
      await sleep(opts.backoffMs * 2 ** attempt);
      attempt += 1;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`${opts.serviceName} request failed: ${String(lastErr)}`);
}

export function parseRetryAfter(raw: string | null, fallbackMs: number): number {
  if (!raw) return fallbackMs;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds)) return seconds * 1_000;
  const date = new Date(raw).getTime();
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return fallbackMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function inferHintType(
  values: unknown[],
  normalizeDateTimeString?: (value: string) => string | null,
): SourceFieldDto['hintType'] {
  const first = values.find((v) => v !== null && v !== undefined);
  if (first === undefined) return 'TEXT';
  if (typeof first === 'boolean') return 'BOOLEAN';
  if (typeof first === 'number') return 'NUMBER';
  if (typeof first === 'string') {
    const s = first;
    if (normalizeDateTimeString?.(s) || isIsoDateTime(s)) return 'DATETIME';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'DATE';
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return 'EMAIL';
    if (/^https?:\/\/\S+$/i.test(s)) return 'URL';
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s)) return 'IP_ADDRESS';
    return 'TEXT';
  }
  return 'TEXT';
}

export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ');
  const titled = spaced.replace(/\b\w/g, (c) => c.toUpperCase());
  return titled
    .replace(/\bIp\b/g, 'IP')
    .replace(/\bIpv6\b/g, 'IPv6')
    .replace(/\bOs\b/g, 'OS')
    .replace(/\bCpu\b/g, 'CPU')
    .replace(/\bRam\b/g, 'RAM')
    .replace(/\bMac\b/g, 'MAC')
    .replace(/\bDns\b/g, 'DNS')
    .replace(/\bUuid\b/g, 'UUID')
    .replace(/\bId\b/g, 'ID')
    .replace(/\bUrl\b/g, 'URL');
}

export function sortByLabel(fields: SourceFieldDto[]): SourceFieldDto[] {
  return [...fields].sort((a, b) => a.label.localeCompare(b.label));
}

function isIsoDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.test(
    value.trim(),
  );
}

/**
 * Validate a driver's recommended destinations against the same slug
 * contract the layout API enforces.
 *
 * `ensureResourceDestination` writes layouts and fields straight through
 * Prisma, so `layoutSlugSchema` / `fieldSlugSchema` never run on this
 * path. A driver that ships kebab-case slugs therefore mints rows the
 * layout builder and the `field.<slug>=` filter DSL both reject. Drivers
 * call this at module load so a bad constant fails at boot, not after an
 * operator activates the integration.
 */
export function assertRecommendedDestinations<T extends Readonly<Record<string, RecommendedDestination>>>(
  driverKey: string,
  destinations: T,
): T {
  for (const [resourceKey, destination] of Object.entries(destinations)) {
    const where = `${driverKey} "${resourceKey}"`;
    const layout = layoutSlugSchema.safeParse(destination.layout.slug);
    if (!layout.success) {
      throw new Error(
        `${where} layout slug "${destination.layout.slug}" is invalid: ${layout.error.issues[0]!.message}`,
      );
    }
    for (const field of destination.fields) {
      const parsed = fieldSlugSchema.safeParse(field.slug);
      if (!parsed.success) {
        throw new Error(
          `${where} field slug "${field.slug}" is invalid: ${parsed.error.issues[0]!.message}`,
        );
      }
    }
  }
  return destinations;
}
