/**
 * NS reconciliation: DNS NS answer vs WHOIS/RDAP nameservers.
 *
 * The registry's stored nameserver set is the canonical view of where
 * the zone is supposed to be served from. The DNS answer is what the
 * world actually resolves. Mismatches indicate a stale delegation —
 * common during nameserver migrations and a real source of "why is
 * the domain unreachable for some users" incidents.
 *
 * Verdicts:
 *   - `match`           — the two sets are equal after normalisation.
 *   - `mismatch`        — both sides have values but they differ.
 *   - `unverifiable`    — the WHOIS side returned no NS data. We treat
 *                         this as *not* a problem because many TLDs
 *                         (.gov, several ccTLDs) don't expose NS
 *                         records via RDAP/whois:43. The rubric awards
 *                         full credit so we don't penalise customers
 *                         on legitimately opaque TLDs.
 *
 * Normalisation is critical: registrars return mixed-case, trailing-
 * dot, and reordered lists. We lower-case, strip trailing dots, and
 * compare as a Set.
 */

import type { NsMatchSubResult, SubCheckResult } from './types.js';

function normalise(list: readonly string[]): string[] {
  return Array.from(
    new Set(
      list
        .map((s) => s.trim().toLowerCase())
        .map((s) => s.replace(/\.$/, ''))
        .filter(Boolean),
    ),
  ).sort();
}

export function compareNs(
  dnsNs: readonly string[],
  whoisNs: readonly string[],
): SubCheckResult<NsMatchSubResult> {
  const dns = normalise(dnsNs);
  const whois = normalise(whoisNs);

  if (whois.length === 0) {
    return {
      status: 'SKIP',
      data: { dnsNs: dns, whoisNs: whois, match: 'unverifiable' },
      error: null,
    };
  }
  if (dns.length === 0) {
    return {
      status: 'WARN',
      data: { dnsNs: dns, whoisNs: whois, match: 'mismatch' },
      error: 'dns returned no NS records',
    };
  }

  // Set-equality after normalisation.
  const equal =
    dns.length === whois.length && dns.every((host, i) => host === whois[i]);
  if (equal) {
    return {
      status: 'OK',
      data: { dnsNs: dns, whoisNs: whois, match: 'match' },
      error: null,
    };
  }
  return {
    status: 'WARN',
    data: { dnsNs: dns, whoisNs: whois, match: 'mismatch' },
    error: `dns NS set differs from registry (${dns.join(',')} vs ${whois.join(',')})`,
  };
}
