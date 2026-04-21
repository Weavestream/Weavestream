/**
 * Domain check engine — the orchestrator.
 *
 * Runs WHOIS (RDAP first, whois:43 fallback), DNS, and TLS checks in
 * parallel and folds their results into a single `DomainCheckResult`.
 * Pure: no Prisma, no Nest decorators, no logging — the processor
 * handles persistence and audit logging.
 *
 * Failure semantics (per sub-check):
 *   - skipped (flag off)               → status = SKIP, data = null
 *   - succeeded                        → status = OK  | WARN
 *   - errored (network, parse, timeout)→ status = FAIL, data best-effort
 *
 * The aggregate `DomainStatus` (OK / EXPIRING / EXPIRED / FAIL /
 * UNKNOWN) is computed by the caller because it depends on the
 * per-domain `alertThresholdDays`.
 */

import type { DomainCheckDetails } from '@weavestream/shared';
import { queryRdap } from './rdap.js';
import { queryWhois43 } from './whois43.js';
import { runDnsCheck } from './dns-check.js';
import { runTlsCheck } from './tls-check.js';
import type {
  DnsSubResult,
  DomainCheckResult,
  EnginePorts,
  EngineRunOptions,
  SubCheckResult,
  TlsSubResult,
  WhoisSubResult,
} from './types.js';

const RDAP_CACHE_HOURS_DEFAULT = 24;

async function runWhoisWithFallback(
  ports: EnginePorts,
  hostname: string,
  timeoutMs: number,
  cacheMs: number,
): Promise<SubCheckResult<WhoisSubResult>> {
  try {
    const rdap = await queryRdap(ports, hostname, {
      timeoutMs,
      cacheMs,
    });
    if (rdap && rdap.expiresAt) {
      return { status: 'OK', data: rdap, error: null };
    }
    // RDAP returned partial or nothing — try whois:43.
    const whois = await queryWhois43(ports, hostname, { timeoutMs });
    if (whois) {
      const status: 'OK' | 'WARN' = whois.expiresAt ? 'OK' : 'WARN';
      return {
        status,
        data: whois,
        error: whois.expiresAt ? null : 'whois:43 response missing expiresAt',
      };
    }
    // Neither source produced anything useful.
    if (rdap) {
      return {
        status: 'WARN',
        data: rdap,
        error: 'rdap response missing expiresAt, whois:43 returned nothing',
      };
    }
    return {
      status: 'FAIL',
      data: null,
      error: 'no rdap or whois:43 data for this TLD',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'FAIL', data: null, error: message };
  }
}

function toIsoOrNull(d: Date | null | undefined): string | null {
  if (!d) return null;
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function buildDetails(
  whois: SubCheckResult<WhoisSubResult>,
  dns: SubCheckResult<DnsSubResult>,
  tls: SubCheckResult<TlsSubResult>,
  checkFlags: { whois: boolean; dns: boolean; tls: boolean },
): DomainCheckDetails {
  const out: DomainCheckDetails = {};
  if (checkFlags.whois) {
    out.whois = {
      registrar: whois.data?.registrar ?? null,
      registeredAt: toIsoOrNull(whois.data?.registeredAt),
      expiresAt: toIsoOrNull(whois.data?.expiresAt),
      source: whois.data?.source ?? 'none',
    };
  }
  if (checkFlags.dns) {
    out.dns = {
      a: dns.data?.a ?? [],
      aaaa: dns.data?.aaaa ?? [],
      mx: dns.data?.mx ?? [],
      ns: dns.data?.ns ?? [],
    };
  }
  if (checkFlags.tls) {
    out.tls = {
      validFrom: toIsoOrNull(tls.data?.validFrom),
      validTo: toIsoOrNull(tls.data?.validTo),
      issuer: tls.data?.issuer ?? null,
      subjectAltNames: tls.data?.subjectAltNames ?? [],
      chainLength: tls.data?.chainLength ?? 0,
      protocol: tls.data?.protocol ?? null,
    };
  }
  return out;
}

function aggregateError(
  whois: SubCheckResult<WhoisSubResult>,
  dns: SubCheckResult<DnsSubResult>,
  tls: SubCheckResult<TlsSubResult>,
): string | null {
  const parts: string[] = [];
  if (whois.status === 'FAIL' && whois.error) parts.push(`whois: ${whois.error}`);
  if (dns.status === 'FAIL' && dns.error) parts.push(`dns: ${dns.error}`);
  if (tls.status === 'FAIL' && tls.error) parts.push(`tls: ${tls.error}`);
  return parts.length === 0 ? null : parts.join('; ');
}

export async function runDomainCheck(
  ports: EnginePorts,
  opts: EngineRunOptions & { rdapCacheHours?: number },
): Promise<DomainCheckResult> {
  const checkedAt = ports.clock.now();
  const rdapCacheMs =
    (opts.rdapCacheHours ?? RDAP_CACHE_HOURS_DEFAULT) * 60 * 60 * 1000;

  const skipped: SubCheckResult<never> = {
    status: 'SKIP',
    data: null,
    error: null,
  };

  const [whois, dns, tls] = await Promise.all([
    opts.checkWhois
      ? runWhoisWithFallback(ports, opts.hostname, opts.timeoutMs, rdapCacheMs)
      : Promise.resolve(skipped as SubCheckResult<WhoisSubResult>),
    opts.checkDns
      ? runDnsCheck(ports.dns, opts.hostname)
      : Promise.resolve(skipped as SubCheckResult<DnsSubResult>),
    opts.checkTls
      ? runTlsCheck(ports.tls, opts.hostname, {
          timeoutMs: opts.timeoutMs,
          now: checkedAt,
        })
      : Promise.resolve(skipped as SubCheckResult<TlsSubResult>),
  ]);

  return {
    checkedAt,
    whois,
    dns,
    tls,
    details: buildDetails(whois, dns, tls, {
      whois: opts.checkWhois,
      dns: opts.checkDns,
      tls: opts.checkTls,
    }),
    aggregateError: aggregateError(whois, dns, tls),
  };
}

/**
 * Derives the denormalised `DomainStatus` from an engine run and the
 * per-domain alert threshold. Kept here so the processor and any
 * "compute without persisting" path produce identical statuses.
 */
export function deriveDomainStatus(
  result: DomainCheckResult,
  alertThresholdDays: number,
): 'OK' | 'EXPIRING' | 'EXPIRED' | 'FAIL' | 'UNKNOWN' {
  const now = result.checkedAt.getTime();
  const thresholdMs = alertThresholdDays * 24 * 60 * 60 * 1000;

  const whoisExpiry = result.whois.data?.expiresAt?.getTime() ?? null;
  const tlsExpiry = result.tls.data?.validTo?.getTime() ?? null;

  const expired =
    (whoisExpiry !== null && whoisExpiry <= now) ||
    (tlsExpiry !== null && tlsExpiry <= now);
  if (expired) return 'EXPIRED';

  const expiring =
    (whoisExpiry !== null && whoisExpiry - now <= thresholdMs) ||
    (tlsExpiry !== null && tlsExpiry - now <= thresholdMs);
  if (expiring) return 'EXPIRING';

  const anyFail =
    result.whois.status === 'FAIL' ||
    result.dns.status === 'FAIL' ||
    result.tls.status === 'FAIL';
  if (anyFail) return 'FAIL';

  const anyOk =
    result.whois.status === 'OK' ||
    result.dns.status === 'OK' ||
    result.tls.status === 'OK';
  return anyOk ? 'OK' : 'UNKNOWN';
}
