/**
 * Lightweight HTTP availability probe used by the alerts feature's
 * `WEBSITE_DOWN` evaluator.
 *
 * The standard Phase 8 engine (WHOIS / DNS / TLS) intentionally does
 * NOT perform an HTTP request — we don't want to hammer customer
 * origins on every check, and TLS handshake success is enough signal
 * that the host is "reachable" for cert monitoring.
 *
 * For uptime alerts we need a real reachability signal, so this probe
 * runs an HTTPS HEAD with a short timeout, falls back to GET if the
 * origin doesn't allow HEAD, and reports:
 *
 *   - `ok` = true  for any 2xx / 3xx response (origin replied)
 *   - `ok` = false for any 4xx (we treat 401/403 as "up but gated"
 *                  by checking a small whitelist), 5xx, network or
 *                  TLS failure, or timeout
 *
 * Returning `status` as `null` means we never received an HTTP
 * response — useful so the caller can distinguish "got a 503" from
 * "DNS resolution failed".
 */

import { safeFetch } from '../../common/egress/safe-fetch.js';
import type { HttpEngineSubResult, SubCheckResult } from './types.js';

export interface HttpCheckResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

export interface HttpCheckOptions {
  timeoutMs: number;
}

/**
 * Status codes that we treat as "up". 2xx / 3xx / 401 / 403 — the
 * origin is plainly responding, just gated. We don't include the
 * 5xx range because a 502 / 503 is exactly the failure mode admins
 * configure WEBSITE_DOWN to catch.
 */
function isUpStatus(status: number): boolean {
  if (status >= 200 && status < 400) return true;
  if (status === 401 || status === 403) return true;
  return false;
}

export async function runHttpCheck(
  hostname: string,
  options: HttpCheckOptions,
): Promise<HttpCheckResult> {
  const url = `https://${hostname}`;
  try {
    const result = await fetchWithTimeout(url, 'HEAD', options.timeoutMs);
    if (result.status === 405 || result.status === 501) {
      // Some origins reject HEAD — try GET. Cap the body read so we
      // don't pull a 50 MB homepage just to learn the origin is up.
      const fallback = await fetchWithTimeout(url, 'GET', options.timeoutMs);
      return summarise(fallback.status);
    }
    return summarise(result.status);
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function summarise(status: number): HttpCheckResult {
  return { ok: isUpStatus(status), status, error: null };
}

async function fetchWithTimeout(
  url: string,
  method: 'HEAD' | 'GET',
  timeoutMs: number,
): Promise<{ status: number }> {
  // safeFetch enforces the timeout, blocks SSRF targets, and caps the
  // response body. We never read the body of a HEAD/GET probe.
  const res = await safeFetch(url, {
    method,
    redirect: 'follow',
    timeoutMs,
    headers: { 'User-Agent': 'weavestream-alerts/1.0 (+https://weavestream.io)' },
  });
  return { status: res.status };
}

// =====================================================================
// v2 engine HTTP sub-check.
//
// Separate function (kept distinct from `runHttpCheck` above which is
// used by the alerts feature) so each surface can evolve
// independently. This probe does three things that the alerts probe
// does not:
//
//   1. Hits `http://<host>` and `https://<host>` separately so we can
//      tell whether port 80 redirects to HTTPS.
//   2. Walks redirects manually (up to 5 hops) so we can inspect
//      each intermediate `Location` header without losing the chain
//      to fetch's opaque `redirect: 'follow'` behaviour.
//   3. Parses the final `Strict-Transport-Security` header into its
//      structured pieces (max-age, includeSubDomains, preload) so the
//      rubric can grade by RFC 6797 thresholds rather than a binary
//      "header present" check.
//
// Every outbound call routes through `safeFetch` so the SSRF guard
// (private-IP block, response size cap, hard timeout) still applies.
// =====================================================================

const HTTP_USER_AGENT = 'weavestream-domain-check/2.0 (+https://weavestream.io)';
const MAX_REDIRECTS = 5;

const HSTS_RE =
  /max-age=(\d+)|(includesubdomains)|(preload)/gi;

export function parseHstsHeader(
  raw: string | null | undefined,
): HttpEngineSubResult['hsts'] {
  if (!raw) {
    return { present: false, maxAge: null, includeSubDomains: false, preload: false };
  }
  let maxAge: number | null = null;
  let includeSubDomains = false;
  let preload = false;
  // Reset regex state — we use a single shared RE in a global scope.
  HSTS_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HSTS_RE.exec(raw))) {
    if (match[1]) {
      const parsed = parseInt(match[1], 10);
      if (!Number.isNaN(parsed)) maxAge = parsed;
    } else if (match[2]) {
      includeSubDomains = true;
    } else if (match[3]) {
      preload = true;
    }
  }
  return {
    present: true,
    maxAge,
    includeSubDomains,
    preload,
  };
}

interface HopResult {
  status: number;
  location: string | null;
  hstsHeader: string | null;
  url: string;
}

async function fetchOneHop(
  url: string,
  timeoutMs: number,
): Promise<HopResult> {
  const res = await safeFetch(url, {
    method: 'HEAD',
    redirect: 'manual',
    timeoutMs,
    headers: { 'User-Agent': HTTP_USER_AGENT },
  });
  // Many origins reject HEAD on the apex with 405/501. Fall back to
  // GET so we can still read the headers; the body is capped by
  // safeFetch's `maxResponseBytes` so a hostile origin can't stream
  // a multi-GB payload back at us.
  if (res.status === 405 || res.status === 501) {
    const fallback = await safeFetch(url, {
      method: 'GET',
      redirect: 'manual',
      timeoutMs,
      headers: { 'User-Agent': HTTP_USER_AGENT },
    });
    return {
      status: fallback.status,
      location: fallback.headers.get('location'),
      hstsHeader: fallback.headers.get('strict-transport-security'),
      url,
    };
  }
  return {
    status: res.status,
    location: res.headers.get('location'),
    hstsHeader: res.headers.get('strict-transport-security'),
    url,
  };
}

function resolveLocation(base: string, location: string): string {
  try {
    return new URL(location, base).toString();
  } catch {
    return location;
  }
}

async function followChain(
  startUrl: string,
  timeoutMs: number,
): Promise<{ chain: HopResult[]; error: string | null }> {
  const chain: HopResult[] = [];
  let url = startUrl;
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    try {
      const hop = await fetchOneHop(url, timeoutMs);
      chain.push(hop);
      if (hop.status >= 300 && hop.status < 400 && hop.location) {
        url = resolveLocation(url, hop.location);
        continue;
      }
      return { chain, error: null };
    } catch (err) {
      return {
        chain,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return { chain, error: 'redirect chain exceeded 5 hops' };
}

/**
 * Engine-side HTTPS reachability + security-header probe.
 *
 * Returns a `SubCheckResult` so the engine can fold it into the same
 * `Promise.all` as the other sub-checks. Read-only — no application
 * data is ever sent in the request body.
 */
export async function runEngineHttpCheck(
  hostname: string,
  opts: { timeoutMs: number },
): Promise<SubCheckResult<HttpEngineSubResult>> {
  // Tier 1: hit plain HTTP first to learn whether it redirects to
  // HTTPS. We don't fail the whole check when port 80 is closed —
  // some hardened hosts only listen on 443.
  const httpStart = `http://${hostname}`;
  const httpsStart = `https://${hostname}`;

  const [httpRes, httpsRes] = await Promise.all([
    followChain(httpStart, opts.timeoutMs).catch((err) => ({
      chain: [] as HopResult[],
      error: err instanceof Error ? err.message : String(err),
    })),
    followChain(httpsStart, opts.timeoutMs).catch((err) => ({
      chain: [] as HopResult[],
      error: err instanceof Error ? err.message : String(err),
    })),
  ]);

  // Redirect-to-HTTPS verdict:
  //   true  — any hop in the HTTP chain returns a 3xx whose Location
  //           is an https:// URL, OR the chain finally resolves on
  //           an HTTPS URL.
  //   false — every hop stays on http://
  let redirectsToHttps = false;
  if (httpRes.chain.length > 0) {
    redirectsToHttps =
      httpRes.chain.some((hop) =>
        hop.location
          ? resolveLocation(hop.url, hop.location).startsWith('https://')
          : false,
      ) || httpRes.chain[httpRes.chain.length - 1]!.url.startsWith('https://');
  }

  // HSTS lives on the HTTPS response — there is no point reading it
  // off a plain HTTP response (the browser would never honour it).
  const finalHttps = httpsRes.chain[httpsRes.chain.length - 1] ?? null;
  const hsts = parseHstsHeader(finalHttps?.hstsHeader ?? null);

  // We treat the sub-check as OK when HTTPS responds at all. WARN
  // when only plain HTTP responds (no HTTPS), FAIL only when both
  // legs error out.
  let status: SubCheckResult<HttpEngineSubResult>['status'];
  const errs: string[] = [];
  if (httpsRes.chain.length > 0) {
    status = 'OK';
  } else if (httpRes.chain.length > 0) {
    status = 'WARN';
    errs.push(`https unreachable: ${httpsRes.error ?? 'no response'}`);
  } else {
    status = 'FAIL';
    if (httpRes.error) errs.push(`http: ${httpRes.error}`);
    if (httpsRes.error) errs.push(`https: ${httpsRes.error}`);
  }

  return {
    status,
    data: {
      redirectsToHttps,
      finalStatus: finalHttps?.status ?? null,
      finalUrl: finalHttps?.url ?? null,
      hsts,
      error: errs.length === 0 ? null : errs.join('; '),
    },
    error: errs.length === 0 ? null : errs.join('; '),
  };
}
