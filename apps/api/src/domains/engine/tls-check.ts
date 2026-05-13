/**
 * TLS certificate check.
 *
 * Thin wrapper around the injected `TlsPort` so the engine doesn't
 * have to know whether we're using `node:tls` directly or some mock.
 * The port is expected to set SNI to `hostname` and request the full
 * peer certificate chain (`detailed = true` in `getPeerCertificate`)
 * so we can count the chain length.
 *
 * Status mapping:
 *   FAIL — connection error, handshake failure, expired cert
 *   WARN — cert valid but self-signed / chain length < 2 / hostname
 *          mismatch reported by the port
 *   OK   — handshake succeeded and `validTo` is in the future
 *
 * The engine caller is responsible for applying the per-domain
 * `alertThresholdDays` warning — we only look at hard expiry here.
 */

import type { SubCheckResult, TlsPort, TlsSubResult } from './types.js';

const TLS_PORT = 443;

export async function runTlsCheck(
  tls: TlsPort,
  hostname: string,
  opts: { timeoutMs: number; now: Date },
): Promise<SubCheckResult<TlsSubResult>> {
  try {
    const info = await tls.probe(hostname, TLS_PORT, opts.timeoutMs);
    const validFrom = info.validFrom ? new Date(info.validFrom) : null;
    const validTo = info.validTo ? new Date(info.validTo) : null;
    const validToDate =
      validTo && !Number.isNaN(validTo.getTime()) ? validTo : null;
    const daysUntilExpiry = validToDate
      ? Math.floor(
          (validToDate.getTime() - opts.now.getTime()) / 86_400_000,
        )
      : null;

    const data: TlsSubResult = {
      validFrom: validFrom && !Number.isNaN(validFrom.getTime()) ? validFrom : null,
      validTo: validToDate,
      issuer: info.issuer,
      subjectAltNames: info.subjectAltNames,
      chainLength: info.chainLength,
      protocol: info.protocol,
      authorized: info.authorized,
      authorizationError: info.authorizationError,
      keyAlgo: info.keyAlgo,
      keyBits: info.keyBits,
      sigAlgo: info.sigAlgo,
      mustStaple: info.mustStaple,
      ocspStapled: info.ocspStapled,
      daysUntilExpiry,
    };

    if (!data.validTo) {
      return {
        status: 'WARN',
        data,
        error: 'certificate has no notAfter date',
      };
    }
    if (data.validTo.getTime() <= opts.now.getTime()) {
      return {
        status: 'FAIL',
        data,
        error: `certificate expired on ${data.validTo.toISOString()}`,
      };
    }

    const warnings: string[] = [];
    if (data.chainLength < 2) warnings.push('chain length < 2 (self-signed?)');
    // Trust verdict from Node's TLS validator. We probe with
    // `rejectUnauthorized: false` so we can read expired / mismatched
    // certs, but we still surface the verdict so callers can alert on
    // untrusted issuers, hostname mismatches, etc.
    if (data.authorized === false) {
      warnings.push(
        data.authorizationError
          ? `untrusted: ${data.authorizationError}`
          : 'untrusted (peer failed system store / hostname validation)',
      );
    }

    return {
      status: warnings.length === 0 ? 'OK' : 'WARN',
      data,
      error: warnings.length === 0 ? null : warnings.join('; '),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'FAIL',
      data: null,
      error: message,
    };
  }
}
