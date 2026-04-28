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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      // Keep the request small — we never read the body.
      headers: { 'User-Agent': 'weavestream-alerts/1.0 (+https://weavestream.io)' },
    });
    return { status: res.status };
  } finally {
    clearTimeout(timer);
  }
}
