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

import type {
  CaaRecord,
  DnsPort,
  DnsSubResult,
  SubCheckResult,
} from './types.js';
import { isNoDataError, safeResolve } from './dns-utils.js';

export async function runDnsCheck(
  dns: DnsPort,
  hostname: string,
): Promise<SubCheckResult<DnsSubResult>> {
  // v2 — fan TXT + CAA into the same parallel block as A/AAAA/MX/NS so
  // we don't pay a sequential round-trip per record type. The new
  // queries are best-effort: a NODATA TXT response is *normal* for
  // domains that don't sign mail.
  const [aRes, aaaaRes, mxRes, nsRes, txtRes, caaRes] = await Promise.all([
    safeResolve(() => dns.resolve4(hostname), [] as string[]),
    safeResolve(() => dns.resolve6(hostname), [] as string[]),
    safeResolve(
      () => dns.resolveMx(hostname),
      [] as Array<{ exchange: string; priority: number }>,
    ),
    safeResolve(() => dns.resolveNs(hostname), [] as string[]),
    safeResolve(() => dns.resolveTxt(hostname), [] as string[][]),
    safeResolve(() => dns.resolveCaa(hostname), [] as CaaRecord[]),
  ]);

  const mx = mxRes.value.map((rec) => ({
    preference: rec.priority,
    exchange: rec.exchange,
  }));

  // Each TXT record can be a tuple of <=255 byte strings; the canonical
  // representation is to concatenate the tuple into a single record
  // string (see RFC 6763 §6.3). DKIM/SPF parsers downstream expect the
  // joined form.
  const txt = txtRes.value.map((parts) => parts.join(''));

  const data: DnsSubResult = {
    a: aRes.value,
    aaaa: aaaaRes.value,
    mx,
    ns: nsRes.value,
    txt,
    caa: caaRes.value,
  };

  // Distinguish "resolver itself broken" (every query errored) from
  // "domain just has nothing here" (NODATA from every query). The
  // former is FAIL; the latter is treated as WARN at most below.
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

// Re-export so callers that import from `dns-check` only still see the
// helpers; the v2 sub-checks (`email-check`, `dnssec-check`) reach into
// `dns-utils` directly.
export { isNoDataError, safeResolve };
