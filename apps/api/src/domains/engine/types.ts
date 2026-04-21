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

/** The subset of `dns/promises` we consume. */
export interface DnsPort {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  resolveMx(
    hostname: string,
  ): Promise<Array<{ exchange: string; priority: number }>>;
  resolveNs(hostname: string): Promise<string[]>;
}

export interface TlsCertificateInfo {
  validFrom: string | null;
  validTo: string | null;
  issuer: string | null;
  subjectAltNames: string[];
  chainLength: number;
  protocol: string | null;
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
}

export interface DnsSubResult {
  a: string[];
  aaaa: string[];
  mx: Array<{ preference: number; exchange: string }>;
  ns: string[];
}

export interface TlsSubResult {
  validFrom: Date | null;
  validTo: Date | null;
  issuer: string | null;
  subjectAltNames: string[];
  chainLength: number;
  protocol: string | null;
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
  /** Serialisable details payload for `domain_checks.details` (jsonb). */
  details: DomainCheckDetails;
  /** Aggregated error string surfaced at the row level. `null` if fully OK. */
  aggregateError: string | null;
}
