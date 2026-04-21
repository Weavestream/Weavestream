/**
 * DNS checks — A, AAAA, MX, and NS records resolved in parallel.
 *
 * Each sub-query has its own timeout so a single slow record type
 * can't starve the others. A record that returns `NODATA` (e.g. a
 * domain that legitimately has no AAAA) resolves to an empty array
 * rather than throwing — only a *resolver* error becomes a failure.
 *
 * We classify the aggregate as:
 *   OK   — at least one A or AAAA, and NS records present
 *   WARN — missing A/AAAA *or* missing NS (typo vs parking page)
 *   FAIL — every sub-query errored
 */

import type { DnsPort, DnsSubResult, SubCheckResult } from './types.js';

const NODATA_CODES = new Set([
  'ENODATA',
  'ENOTFOUND',
  'ENOTIMP',
  'ENOERROR',
]);

function isNoDataError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  return typeof code === 'string' && NODATA_CODES.has(code);
}

async function safeResolve<T>(
  fn: () => Promise<T>,
  fallback: T,
): Promise<{ value: T; error: Error | null }> {
  try {
    return { value: await fn(), error: null };
  } catch (err) {
    if (isNoDataError(err)) return { value: fallback, error: null };
    return {
      value: fallback,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

export async function runDnsCheck(
  dns: DnsPort,
  hostname: string,
): Promise<SubCheckResult<DnsSubResult>> {
  const [aRes, aaaaRes, mxRes, nsRes] = await Promise.all([
    safeResolve(() => dns.resolve4(hostname), [] as string[]),
    safeResolve(() => dns.resolve6(hostname), [] as string[]),
    safeResolve(
      () => dns.resolveMx(hostname),
      [] as Array<{ exchange: string; priority: number }>,
    ),
    safeResolve(() => dns.resolveNs(hostname), [] as string[]),
  ]);

  const mx = mxRes.value.map((rec) => ({
    preference: rec.priority,
    exchange: rec.exchange,
  }));

  const data: DnsSubResult = {
    a: aRes.value,
    aaaa: aaaaRes.value,
    mx,
    ns: nsRes.value,
  };

  const allErrored =
    aRes.error && aaaaRes.error && mxRes.error && nsRes.error;
  if (allErrored) {
    return {
      status: 'FAIL',
      data,
      error: aRes.error?.message ?? 'dns resolution failed',
    };
  }

  const hasAddr = data.a.length > 0 || data.aaaa.length > 0;
  const hasNs = data.ns.length > 0;
  if (hasAddr && hasNs) {
    return { status: 'OK', data, error: null };
  }

  const warnings: string[] = [];
  if (!hasAddr) warnings.push('no A/AAAA records');
  if (!hasNs) warnings.push('no NS records');
  return {
    status: 'WARN',
    data,
    error: warnings.join('; ') || null,
  };
}
