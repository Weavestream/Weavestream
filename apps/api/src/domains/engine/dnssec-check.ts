/**
 * DNSSEC sub-check.
 *
 * Two-tier detection, ordered cheapest-and-most-authoritative first:
 *
 *   1. **RDAP `secureDNS` block** — the registry tells us straight up
 *      whether the delegation is signed (`delegationSigned: true`) and
 *      how many DS records are on file. This is the gold-standard
 *      signal because it reflects the actual parent-side delegation,
 *      not what an arbitrary resolver returns.
 *
 *   2. **DNSKEY probe** — when RDAP didn't include `secureDNS` (e.g.
 *      we fell back to whois:43, or the registry just doesn't expose
 *      it), we ask the resolver for the zone's DNSKEY records. The
 *      presence of any DNSKEY is suggestive but **not** authoritative
 *      proof of a signed delegation — an unsigned parent can still
 *      have DNSKEY records inside the child zone. We surface that
 *      uncertainty via `source: 'dnskey'` so the UI/auditors can
 *      see which signal we relied on.
 *
 * The check is intentionally read-only — no DS validation, no recursive
 * chain walk. Operators who need cryptographic proof of signing
 * should run `delv` or a dedicated DNSSEC monitoring tool; this check
 * answers the much more common "is this domain signed at all?" use
 * case.
 */

import type {
  DnsPort,
  DnssecSubResult,
  SubCheckResult,
  WhoisSubResult,
} from './types.js';
import { safeResolve } from './dns-utils.js';

export async function runDnssecCheck(
  dns: DnsPort,
  hostname: string,
  rdapSecureDns: WhoisSubResult['secureDns'] | null,
): Promise<SubCheckResult<DnssecSubResult>> {
  // ---- Tier 1: registry-side RDAP signal ----------------------------
  if (rdapSecureDns) {
    return {
      status: rdapSecureDns.delegationSigned ? 'OK' : 'WARN',
      data: {
        signed: rdapSecureDns.delegationSigned,
        source: 'rdap',
        dsRecordCount: rdapSecureDns.dsRecordCount,
      },
      error: rdapSecureDns.delegationSigned ? null : 'delegation not signed',
    };
  }

  // ---- Tier 2: DNSKEY probe -----------------------------------------
  const res = await safeResolve(
    () => dns.resolve(hostname, 'DNSKEY'),
    [] as unknown[],
  );
  if (res.error) {
    return {
      status: 'WARN',
      data: { signed: false, source: 'none', dsRecordCount: 0 },
      error: `dnssec probe failed: ${res.error.message}`,
    };
  }
  const signed = res.value.length > 0;
  return {
    status: signed ? 'OK' : 'WARN',
    data: {
      signed,
      source: signed ? 'dnskey' : 'none',
      dsRecordCount: 0,
    },
    error: signed ? null : 'no DNSKEY records (and no registry secureDNS data)',
  };
}
