import type { SourceFieldDto } from '@weavestream/shared';
import { fieldSlugSchema, layoutSlugSchema } from '@weavestream/shared';
import { DriverRateLimitError } from './integration-driver.js';
import type { RecommendedDestination } from './integration-driver.js';
import { safeFetch } from '../../common/egress/safe-fetch.js';

export interface FetchWithRetryOpts {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  redirect?: 'follow' | 'manual' | 'error';
  timeoutMs: number;
  maxRetries: number;
  backoffMs: number;
  correlationId: string;
  serviceName: string;
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
      // safeFetch handles its own AbortController + timeout, validates
      // the resolved IPs against the egress blocklist, and caps the
      // response body. Operator-supplied integration baseUrls flow
      // through here, so the egress guard is the SSRF backstop.
      const res = await safeFetch(url, {
        method: opts.method,
        headers: opts.headers,
        body: opts.body,
        redirect: opts.redirect,
        timeoutMs: opts.timeoutMs,
      });
      if (res.status === 429) {
        const retryAfterRaw = res.headers.get('Retry-After');
        const retryAfterMs = parseRetryAfter(
          retryAfterRaw,
          opts.backoffMs * 2 ** attempt,
        );
        if (attempt === opts.maxRetries) {
          throw new DriverRateLimitError(
            `${opts.serviceName} rate limited after ${opts.maxRetries + 1} attempts`,
            retryAfterMs,
          );
        }
        await sleep(retryAfterMs);
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
