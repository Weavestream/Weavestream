/**
 * Legacy port-43 WHOIS fallback.
 *
 * Used only when RDAP returns nothing. We hop at most twice: the IANA
 * root knows which registry server holds the record, and the registry
 * server knows which registrar server holds the authoritative copy.
 * More than two hops means we're chasing redirects — almost always a
 * sign the TLD is unsupported or the response isn't WHOIS at all.
 *
 * Parsing is best-effort: we look for `Registrar:`, `Expiration Date:`,
 * and a handful of common aliases. If the registry returns free-form
 * text we have no hope of interpreting, the function returns a
 * `WhoisSubResult` whose `expiresAt`/`registrar` fields are null —
 * the processor will log a WARN, not a FAIL, because we've still
 * proved the domain exists.
 */

import type { EnginePorts, WhoisSubResult } from './types.js';

const IANA_WHOIS = 'whois.iana.org';
const MAX_HOPS = 2;

function extractField(text: string, labels: RegExp): string | null {
  const m = text.match(labels);
  return m && m[1] ? m[1].trim() : null;
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function extractReferralServer(text: string): string | null {
  // Handles both "whois:" and "Registrar WHOIS Server:" styles.
  const direct = text.match(/^\s*whois:\s*([^\s]+)/im);
  if (direct && direct[1]) return direct[1].trim();
  const registrar = text.match(/Registrar WHOIS Server:\s*([^\s]+)/i);
  if (registrar && registrar[1]) return registrar[1].trim();
  return null;
}

export async function queryWhois43(
  ports: EnginePorts,
  hostname: string,
  opts: { timeoutMs: number },
): Promise<WhoisSubResult | null> {
  let server = IANA_WHOIS;
  let lastResponse: string | null = null;

  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    try {
      const payload = await ports.whois43.query(server, hostname, opts.timeoutMs);
      lastResponse = payload;
      const referral = extractReferralServer(payload);
      if (!referral || referral === server || hop === MAX_HOPS) break;
      server = referral;
    } catch {
      break;
    }
  }

  if (!lastResponse) return null;

  const registrar =
    extractField(lastResponse, /^\s*Registrar:\s*(.+)$/im) ??
    extractField(lastResponse, /^\s*Sponsoring Registrar:\s*(.+)$/im);
  const expires =
    extractField(
      lastResponse,
      /^\s*(?:Registry Expiry Date|Registrar Registration Expiration Date|Expiration Date|Expires(?: On)?):\s*(.+)$/im,
    );
  const registered =
    extractField(
      lastResponse,
      /^\s*(?:Creation Date|Created(?: On)?|Registered(?: on)?):\s*(.+)$/im,
    );

  if (!registrar && !expires && !registered) return null;
  return {
    registrar,
    registeredAt: parseDate(registered),
    expiresAt: parseDate(expires),
    source: 'whois43',
  };
}
