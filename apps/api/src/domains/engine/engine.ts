/**
 * Domain check engine — the orchestrator.
 *
 * Runs WHOIS (RDAP first, whois:43 fallback), DNS, TLS, email-auth
 * (SPF/DMARC/DKIM), DNSSEC, NS-match, and an HTTPS reachability probe
 * in parallel and folds their results into a single
 * `DomainCheckResult`. Pure: no Prisma, no Nest decorators, no
 * logging — the processor handles persistence and audit logging.
 *
 * Failure semantics (per sub-check):
 *   - skipped (flag off, or no-MX for email) → status = SKIP, data may be partial
 *   - succeeded                              → status = OK  | WARN
 *   - errored (network, parse, timeout)      → status = FAIL, data best-effort
 *
 * The aggregate `DomainStatus` (OK / EXPIRING / EXPIRED / FAIL /
 * UNKNOWN) is computed by the caller because it depends on the
 * per-domain `alertThresholdDays`. The new percent `score` lives on
 * the result root for convenience and inside `details.score` for the
 * persisted blob.
 */

import type { DomainCheckDetails } from '@weavestream/shared';
import { queryRdap } from './rdap.js';
import { queryWhois43 } from './whois43.js';
import { runDnsCheck } from './dns-check.js';
import { runTlsCheck } from './tls-check.js';
import { runEmailAuthCheck } from './email-check.js';
import { runDnssecCheck } from './dnssec-check.js';
import { compareNs } from './nsmatch.js';
import { runEngineHttpCheck } from './http-check.js';
import { computeScore, DOMAIN_SCORE_VERSION } from './score.js';
import type {
  DnsSubResult,
  DnssecSubResult,
  DomainCheckResult,
  EmailSubResult,
  EnginePorts,
  EngineRunOptions,
  HttpEngineSubResult,
  NsMatchSubResult,
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
      // Carry RDAP's secureDNS forward when whois:43 took over for the
      // expiry date — registry signing data is too valuable to lose
      // just because the fallback parser couldn't find an expiry.
      const merged: WhoisSubResult = {
        ...whois,
        secureDns: whois.secureDns ?? rdap?.secureDns ?? null,
      };
      const status: 'OK' | 'WARN' = merged.expiresAt ? 'OK' : 'WARN';
      return {
        status,
        data: merged,
        error: merged.expiresAt ? null : 'whois:43 response missing expiresAt',
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

interface BuildDetailsInput {
  whois: SubCheckResult<WhoisSubResult>;
  dns: SubCheckResult<DnsSubResult>;
  tls: SubCheckResult<TlsSubResult>;
  email: SubCheckResult<EmailSubResult>;
  dnssec: SubCheckResult<DnssecSubResult>;
  nsMatch: SubCheckResult<NsMatchSubResult>;
  http: SubCheckResult<HttpEngineSubResult>;
  checkFlags: { whois: boolean; dns: boolean; tls: boolean };
}

function buildDetails(input: BuildDetailsInput): DomainCheckDetails {
  const out: DomainCheckDetails = {
    schemaVersion: DOMAIN_SCORE_VERSION,
  };
  if (input.checkFlags.whois) {
    out.whois = {
      registrar: input.whois.data?.registrar ?? null,
      registeredAt: toIsoOrNull(input.whois.data?.registeredAt),
      expiresAt: toIsoOrNull(input.whois.data?.expiresAt),
      source: input.whois.data?.source ?? 'none',
      statusCodes: input.whois.data?.statusCodes ?? [],
      locked: input.whois.data?.locked ?? false,
      hold: input.whois.data?.hold ?? false,
      whoisNs: input.whois.data?.whoisNs ?? [],
    };
  }
  if (input.checkFlags.dns) {
    out.dns = {
      a: input.dns.data?.a ?? [],
      aaaa: input.dns.data?.aaaa ?? [],
      mx: input.dns.data?.mx ?? [],
      ns: input.dns.data?.ns ?? [],
      txt: input.dns.data?.txt ?? [],
      caa: input.dns.data?.caa ?? [],
      dnssec: input.dnssec.data
        ? {
            signed: input.dnssec.data.signed,
            source: input.dnssec.data.source,
            dsRecordCount: input.dnssec.data.dsRecordCount,
          }
        : undefined,
      nsMatch: input.nsMatch.data
        ? {
            dnsNs: input.nsMatch.data.dnsNs,
            whoisNs: input.nsMatch.data.whoisNs,
            match: input.nsMatch.data.match,
          }
        : undefined,
    };
  }
  if (input.checkFlags.tls) {
    out.tls = {
      validFrom: toIsoOrNull(input.tls.data?.validFrom),
      validTo: toIsoOrNull(input.tls.data?.validTo),
      issuer: input.tls.data?.issuer ?? null,
      subjectAltNames: input.tls.data?.subjectAltNames ?? [],
      chainLength: input.tls.data?.chainLength ?? 0,
      protocol: input.tls.data?.protocol ?? null,
      authorized: input.tls.data?.authorized ?? null,
      authorizationError: input.tls.data?.authorizationError ?? null,
      cert: input.tls.data
        ? {
            keyAlgo: input.tls.data.keyAlgo,
            keyBits: input.tls.data.keyBits,
            sigAlgo: input.tls.data.sigAlgo,
            mustStaple: input.tls.data.mustStaple,
            ocspStapled: input.tls.data.ocspStapled,
            daysUntilExpiry: input.tls.data.daysUntilExpiry,
          }
        : undefined,
    };
  }
  if (input.email.status !== 'SKIP' || input.email.data?.hasMx) {
    out.email = {
      hasMx: input.email.data?.hasMx ?? false,
      spf: input.email.data?.spf
        ? {
            present: input.email.data.spf.present,
            record: input.email.data.spf.record,
            mechanisms: input.email.data.spf.mechanisms,
            all: input.email.data.spf.all,
            lookupCount: input.email.data.spf.lookupCount,
            valid: input.email.data.spf.valid,
          }
        : undefined,
      dmarc: input.email.data?.dmarc
        ? {
            present: input.email.data.dmarc.present,
            policy: input.email.data.dmarc.policy,
            subdomainPolicy: input.email.data.dmarc.subdomainPolicy,
            pct: input.email.data.dmarc.pct,
            rua: input.email.data.dmarc.rua,
            ruf: input.email.data.dmarc.ruf,
            raw: input.email.data.dmarc.raw,
          }
        : undefined,
      dkim: input.email.data?.dkim
        ? {
            selectorsChecked: input.email.data.dkim.selectorsChecked,
            selectorsFound: input.email.data.dkim.selectorsFound,
            provider: input.email.data.dkim.provider,
          }
        : undefined,
    };
  } else {
    // Always emit `hasMx: false` so the UI can show "email scoring
    // skipped — no MX" without checking a thousand undefineds.
    out.email = { hasMx: false };
  }
  if (input.http.data) {
    out.http = {
      redirectsToHttps: input.http.data.redirectsToHttps,
      finalStatus: input.http.data.finalStatus,
      finalUrl: input.http.data.finalUrl,
      hsts: input.http.data.hsts ?? undefined,
      error: input.http.data.error,
    };
  }
  return out;
}

function aggregateError(input: BuildDetailsInput): string | null {
  const parts: string[] = [];
  if (input.whois.status === 'FAIL' && input.whois.error)
    parts.push(`whois: ${input.whois.error}`);
  if (input.dns.status === 'FAIL' && input.dns.error)
    parts.push(`dns: ${input.dns.error}`);
  if (input.tls.status === 'FAIL' && input.tls.error)
    parts.push(`tls: ${input.tls.error}`);
  // Email / DNSSEC / NS-match / HTTP only contribute their FAIL
  // strings — WARN is normal and would flood the parent row's `error`
  // column with non-actionable noise.
  if (input.email.status === 'FAIL' && input.email.error)
    parts.push(`email: ${input.email.error}`);
  if (input.http.status === 'FAIL' && input.http.error)
    parts.push(`http: ${input.http.error}`);
  return parts.length === 0 ? null : parts.join('; ');
}

/**
 * Wrap a sub-check promise in a per-call timeout. Used for the v2
 * sub-checks so one slow TXT lookup can't starve the whole engine
 * fan-out. The base WHOIS/DNS/TLS checks already enforce their own
 * timeouts via the injected `EnginePorts`.
 */
async function withTimeout<T>(
  fn: () => Promise<SubCheckResult<T>>,
  timeoutMs: number,
  label: string,
  fallback: T,
): Promise<SubCheckResult<T>> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<SubCheckResult<T>>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              status: 'WARN',
              data: fallback,
              error: `${label} timed out after ${timeoutMs}ms`,
            }),
          timeoutMs,
        );
      }),
    ]);
  } catch (err) {
    return {
      status: 'FAIL',
      data: fallback,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const SKIP_WHOIS: SubCheckResult<WhoisSubResult> = {
  status: 'SKIP',
  data: null,
  error: null,
};
const SKIP_DNS: SubCheckResult<DnsSubResult> = {
  status: 'SKIP',
  data: null,
  error: null,
};
const SKIP_TLS: SubCheckResult<TlsSubResult> = {
  status: 'SKIP',
  data: null,
  error: null,
};

export async function runDomainCheck(
  ports: EnginePorts,
  opts: EngineRunOptions & { rdapCacheHours?: number },
): Promise<DomainCheckResult> {
  const checkedAt = ports.clock.now();
  const rdapCacheMs =
    (opts.rdapCacheHours ?? RDAP_CACHE_HOURS_DEFAULT) * 60 * 60 * 1000;

  // Phase 1: the three legacy sub-checks run in parallel. We need
  // DNS's MX answer before we can dispatch the email check (auto-skip
  // depends on it), and we need WHOIS's `secureDns` before the
  // DNSSEC fallback knows whether RDAP gave us authoritative data.
  const [whois, dns, tls] = await Promise.all([
    opts.checkWhois
      ? runWhoisWithFallback(ports, opts.hostname, opts.timeoutMs, rdapCacheMs)
      : Promise.resolve(SKIP_WHOIS),
    opts.checkDns
      ? runDnsCheck(ports.dns, opts.hostname)
      : Promise.resolve(SKIP_DNS),
    opts.checkTls
      ? runTlsCheck(ports.tls, opts.hostname, {
          timeoutMs: opts.timeoutMs,
          now: checkedAt,
        })
      : Promise.resolve(SKIP_TLS),
  ]);

  // Phase 2: the v2 sub-checks. Each is wrapped in a per-call timeout
  // so a slow TXT lookup can't drag the whole fan-out down.
  const mxHosts = (dns.data?.mx ?? []).map((rec) => rec.exchange);
  const subTimeout = Math.min(opts.timeoutMs, 8_000);

  const emailPromise: Promise<SubCheckResult<EmailSubResult>> = opts.checkDns
    ? withTimeout(
        () =>
          runEmailAuthCheck(ports.dns, {
            hostname: opts.hostname,
            mxHosts,
            dkimSelectorOverride: opts.dkimSelectorOverride,
          }),
        subTimeout,
        'email-auth',
        { hasMx: mxHosts.length > 0, spf: null, dmarc: null, dkim: null },
      )
    : Promise.resolve<SubCheckResult<EmailSubResult>>({
        status: 'SKIP',
        data: { hasMx: false, spf: null, dmarc: null, dkim: null },
        error: null,
      });

  const dnssecPromise: Promise<SubCheckResult<DnssecSubResult>> = opts.checkDns
    ? withTimeout(
        () =>
          runDnssecCheck(
            ports.dns,
            opts.hostname,
            whois.data?.secureDns ?? null,
          ),
        subTimeout,
        'dnssec',
        { signed: false, source: 'none', dsRecordCount: 0 },
      )
    : Promise.resolve<SubCheckResult<DnssecSubResult>>({
        status: 'SKIP',
        data: null,
        error: null,
      });

  const httpPromise: Promise<SubCheckResult<HttpEngineSubResult>> = opts.checkTls
    ? withTimeout(
        () => runEngineHttpCheck(opts.hostname, { timeoutMs: subTimeout }),
        subTimeout,
        'http',
        {
          redirectsToHttps: false,
          finalStatus: null,
          finalUrl: null,
          hsts: null,
          error: 'timeout',
        },
      )
    : Promise.resolve<SubCheckResult<HttpEngineSubResult>>({
        status: 'SKIP',
        data: null,
        error: null,
      });

  const [email, dnssec, http] = await Promise.all([
    emailPromise,
    dnssecPromise,
    httpPromise,
  ]);

  // NS-match is pure: zero I/O, just set-compare the two arrays.
  const nsMatch = compareNs(
    dns.data?.ns ?? [],
    whois.data?.whoisNs ?? [],
  );

  const buildInput: BuildDetailsInput = {
    whois,
    dns,
    tls,
    email,
    dnssec,
    nsMatch,
    http,
    checkFlags: {
      whois: opts.checkWhois,
      dns: opts.checkDns,
      tls: opts.checkTls,
    },
  };
  const details = buildDetails(buildInput);
  const score = computeScore(details, checkedAt);
  if (score) {
    details.score = score;
  }

  return {
    checkedAt,
    whois,
    dns,
    tls,
    email,
    dnssec,
    nsMatch,
    http,
    details,
    aggregateError: aggregateError(buildInput),
    score: score?.percent ?? null,
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

  // Hard FAIL on registry hold — domain is suspended at the registry
  // level regardless of expiry, see EPP RFC 5731 §3.2.2.
  if (result.whois.data?.hold) return 'FAIL';

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
