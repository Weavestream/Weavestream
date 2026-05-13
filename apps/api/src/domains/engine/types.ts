/**
 * Phase 8 — Domain & SSL monitor engine contracts.
 *
 * The engine is a set of *pure* functions: it takes a hostname + a set
 * of injected "ports" (fetch, DNS resolver, TLS connector, a clock)
 * and returns a fully-populated `DomainCheckResult`. Production wires
 * the real implementations via `createDefaultPorts()`; tests inject
 * mocks so we never hit the network.
 *
 * This pattern lives in its own file so the engine modules can pull
 * types without importing each other and creating cycles. Do NOT add
 * logic here.
 */

import type { DomainCheckDetails } from '@weavestream/shared';

/** A monotonically-increasing millisecond clock, injectable for tests. */
export interface Clock {
  now(): Date;
}

export interface CaaRecord {
  flag: number;
  tag: string;
  value: string;
}

/** The subset of `dns/promises` we consume. */
export interface DnsPort {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  resolveMx(
    hostname: string,
  ): Promise<Array<{ exchange: string; priority: number }>>;
  resolveNs(hostname: string): Promise<string[]>;
  /**
   * v2 — TXT records as arrays of strings (each TXT record can be a
   * tuple of strings the resolver returns; we join them downstream).
   * Used for SPF (apex), DMARC (`_dmarc.<host>`), and DKIM
   * (`<selector>._domainkey.<host>`).
   */
  resolveTxt(hostname: string): Promise<string[][]>;
  /** v2 — CAA records (used by the CAA sub-check). */
  resolveCaa(hostname: string): Promise<CaaRecord[]>;
  /**
   * v2 — Generic resolve for record types not exposed via dedicated
   * helpers. We use this for DNSKEY (DNSSEC fallback).
   */
  resolve(hostname: string, rrtype: 'DNSKEY'): Promise<unknown[]>;
}

export interface TlsCertificateInfo {
  validFrom: string | null;
  validTo: string | null;
  issuer: string | null;
  subjectAltNames: string[];
  chainLength: number;
  protocol: string | null;
  /**
   * Result of Node's built-in trust validation against the system CA
   * store + hostname. The probe itself runs with `rejectUnauthorized:
   * false` so we can inspect expired / self-signed / mismatched certs;
   * this field surfaces the verdict separately so the caller can still
   * alert on it. `null` if the runtime didn't report either way.
   */
  authorized: boolean;
  /** OpenSSL error code when `authorized === false`, else `null`. */
  authorizationError: string | null;
  /**
   * v2 — Cert crypto metadata extracted from the peer certificate.
   * `keyAlgo` follows Node's PeerCertificate.asn1Curve / pubkey OID
   * conventions ("RSA", "EC", "ED25519"); `keyBits` is the modulus
   * size for RSA or curve order for EC. `sigAlgo` is the cert
   * signature algorithm string (e.g. `RSA-SHA256`).
   */
  keyAlgo: string | null;
  keyBits: number | null;
  sigAlgo: string | null;
  /** True if the cert carries the TLS Feature `status_request` (Must-Staple). */
  mustStaple: boolean;
  /** True if the server stapled an OCSP response during the handshake. */
  ocspStapled: boolean;
}

/** TLS probe. Returns `null` on connection failure (caller logs FAIL). */
export interface TlsPort {
  probe(
    hostname: string,
    port: number,
    timeoutMs: number,
  ): Promise<TlsCertificateInfo>;
}

/** Raw port-43 WHOIS socket. Returns the concatenated ASCII payload. */
export interface Whois43Port {
  query(server: string, hostname: string, timeoutMs: number): Promise<string>;
}

/** A lazily-evaluated port bundle so each call can get a fresh clock. */
export interface EnginePorts {
  clock: Clock;
  dns: DnsPort;
  tls: TlsPort;
  whois43: Whois43Port;
  /**
   * `fetch`-compatible signature used by the RDAP + bootstrap fetchers.
   * Kept narrow so the mock doesn't have to reimplement the whole spec.
   */
  fetch: (
    url: string,
    init?: { signal?: AbortSignal; headers?: Record<string, string> },
  ) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }>;
}

export interface EngineRunOptions {
  hostname: string;
  checkWhois: boolean;
  checkDns: boolean;
  checkTls: boolean;
  /** Max duration for any single sub-check (RDAP, DNS, TLS). */
  timeoutMs: number;
  /**
   * v2 — Additional DKIM selectors to probe in addition to the engine's
   * MX-keyed defaults. Comes from `MonitoredDomain.dkimSelectorOverride`.
   * Empty / undefined → defaults only.
   */
  dkimSelectorOverride?: string[];
}

export interface SubCheckResult<T> {
  status: 'OK' | 'WARN' | 'FAIL' | 'SKIP';
  data: T | null;
  error: string | null;
}

export interface WhoisSubResult {
  registrar: string | null;
  registeredAt: Date | null;
  expiresAt: Date | null;
  source: 'rdap' | 'whois43' | 'none';
  /**
   * v2 — Parsed EPP status codes (e.g. `clientTransferProhibited`).
   * Always lower-cased and de-duplicated. `locked` is true when any
   * transfer/delete/update prohibition is set; `hold` is true for
   * `clientHold` / `serverHold` (registry-level suspension).
   */
  statusCodes: string[];
  locked: boolean;
  hold: boolean;
  /**
   * v2 — Nameservers as reported by the registry. Lower-cased and
   * stripped of trailing dots so `nsmatch.ts` can set-compare against
   * the DNS NS answer. Empty array when the registry did not return
   * NS data (common for `.gov` and several ccTLDs).
   */
  whoisNs: string[];
  /**
   * v2 — Raw `secureDNS` block from RDAP, if present. Truthy
   * `delegationSigned` here is authoritative evidence of DNSSEC
   * delegation; `dsRecordCount` reports how many DS records the
   * registry has on file. `null` when RDAP did not include the
   * block (e.g. when the fallback whois:43 path was taken).
   */
  secureDns: { delegationSigned: boolean; dsRecordCount: number } | null;
}

export interface DnsSubResult {
  a: string[];
  aaaa: string[];
  mx: Array<{ preference: number; exchange: string }>;
  ns: string[];
  /** v2 — Joined TXT records at the apex (one string per record). */
  txt: string[];
  /** v2 — CAA records at the apex. */
  caa: CaaRecord[];
}

export interface TlsSubResult {
  validFrom: Date | null;
  validTo: Date | null;
  issuer: string | null;
  subjectAltNames: string[];
  chainLength: number;
  protocol: string | null;
  /** See `TlsCertificateInfo.authorized`. */
  authorized: boolean;
  authorizationError: string | null;
  /** v2 — cert crypto + lifetime metadata, mirrors TlsCertificateInfo. */
  keyAlgo: string | null;
  keyBits: number | null;
  sigAlgo: string | null;
  mustStaple: boolean;
  ocspStapled: boolean;
  /** Whole-day count from `now` to `validTo`. Negative when expired. */
  daysUntilExpiry: number | null;
}

/** v2 — Email authentication sub-check result. */
export interface EmailSubResult {
  hasMx: boolean;
  spf: SpfRecordResult | null;
  dmarc: DmarcRecordResult | null;
  dkim: DkimProbeResult | null;
}

export interface SpfRecordResult {
  present: boolean;
  record: string | null;
  mechanisms: string[];
  all: '+all' | '-all' | '~all' | '?all' | null;
  lookupCount: number;
  valid: boolean;
}

export interface DmarcRecordResult {
  present: boolean;
  policy: 'none' | 'quarantine' | 'reject' | null;
  subdomainPolicy: 'none' | 'quarantine' | 'reject' | null;
  pct: number | null;
  rua: string[];
  ruf: string[];
  raw: string | null;
}

export interface DkimProbeResult {
  selectorsChecked: string[];
  selectorsFound: string[];
  provider: 'google' | 'microsoft' | 'mailgun' | 'sendgrid' | 'unknown';
}

/** v2 — DNSSEC sub-check. */
export interface DnssecSubResult {
  signed: boolean;
  source: 'rdap' | 'dnskey' | 'none';
  dsRecordCount: number;
}

/** v2 — DNS NS vs WHOIS NS reconciliation. */
export interface NsMatchSubResult {
  dnsNs: string[];
  whoisNs: string[];
  match: 'match' | 'mismatch' | 'unverifiable';
}

/** v2 — HTTPS + security header probe. */
export interface HttpEngineSubResult {
  redirectsToHttps: boolean;
  finalStatus: number | null;
  finalUrl: string | null;
  hsts: {
    present: boolean;
    maxAge: number | null;
    includeSubDomains: boolean;
    preload: boolean;
  } | null;
  error: string | null;
}

/**
 * The top-level engine output. The processor persists this into a
 * `DomainCheck` row and denormalises the relevant fields onto the
 * parent `MonitoredDomain`.
 */
export interface DomainCheckResult {
  checkedAt: Date;
  whois: SubCheckResult<WhoisSubResult>;
  dns: SubCheckResult<DnsSubResult>;
  tls: SubCheckResult<TlsSubResult>;
  /** v2 — email auth (SPF/DMARC/DKIM). SKIP when domain has no MX. */
  email: SubCheckResult<EmailSubResult>;
  /** v2 — DNSSEC signing verdict (RDAP first, DNSKEY fallback). */
  dnssec: SubCheckResult<DnssecSubResult>;
  /** v2 — DNS NS vs WHOIS NS set comparison. */
  nsMatch: SubCheckResult<NsMatchSubResult>;
  /** v2 — HTTPS reachability + security headers. */
  http: SubCheckResult<HttpEngineSubResult>;
  /** Serialisable details payload for `domain_checks.details` (jsonb). */
  details: DomainCheckDetails;
  /** Aggregated error string surfaced at the row level. `null` if fully OK. */
  aggregateError: string | null;
  /**
   * v2 — Denormalised percent score (0-100). NULL means the engine
   * could not score the run (every sub-check FAIL'd / SKIP'd). Mirrors
   * `details.score.percent` for callers that don't want to crack open
   * the details blob.
   */
  score: number | null;
}
