// Resolve the real client IP from inbound forwarded headers, using the
// operator-configured `TRUST_PROXY_HOPS` (number of trusted edge
// proxies between the internet and this web container).
//
// Mirrors Express's `proxy-addr` semantics with an integer trust value:
// the connection peer is hop 1, the rightmost X-Forwarded-For entry is
// hop 2, and so on. We treat the first `N` hops as trusted and return
// the first untrusted entry (walking from the right) as the client IP.
// Formula: client = entries[max(0, length - N)], or null if N <= 0 or
// the chain is empty.
//
// The downstream API trusts only requests arriving from the private
// docker bridge and reads `req.ip` from the (single) sanitized XFF
// entry the web tier emits — see `apps/api/src/main.ts`. This helper
// is the single place the web tier decides what that sanitized entry
// is.

export const RESOLVED_CLIENT_IP_HEADER = 'x-ws-resolved-client-ip';

// Sentinel used when the edge tier doesn't provide an XFF chain (or
// `TRUST_PROXY_HOPS=0`). Mirrors the API's `normalizeIp(undefined)`
// fallback so audit rows and throttler buckets stay consistent.
export const UNKNOWN_CLIENT_IP = '0.0.0.0';

function trustProxyHops(): number {
  const raw = process.env.TRUST_PROXY_HOPS;
  if (raw == null || raw === '') return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 1;
  return Math.min(n, 10);
}

export function resolveClientIpFromXff(
  xff: string | null | undefined,
  trustHops = trustProxyHops(),
): string | null {
  if (trustHops <= 0) return null;
  if (!xff) return null;
  const entries = xff
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) return null;
  const idx = Math.max(0, entries.length - trustHops);
  return entries[idx] ?? null;
}

// Strip the IPv4-mapped IPv6 prefix (`::ffff:1.2.3.4` → `1.2.3.4`).
// Matches `normalizeIp` in `apps/api/src/common/request-meta.ts` so the
// same client never splits between the v4 and v4-in-v6 representations
// in throttler / lockout / audit storage.
export function normalizeClientIp(ip: string | null | undefined): string {
  if (!ip) return UNKNOWN_CLIENT_IP;
  if (ip.startsWith('::ffff:')) {
    const v4 = ip.slice('::ffff:'.length);
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(v4)) return v4;
  }
  return ip;
}

// Pull the resolved client IP that `proxy.ts` stashed on the inbound
// request headers, falling back to a fresh resolve (in case the
// caller is reached via a code path that bypasses `proxy.ts`).
export function getResolvedClientIp(headers: Headers): string {
  const stashed = headers.get(RESOLVED_CLIENT_IP_HEADER);
  if (stashed) return normalizeClientIp(stashed);
  const xff = headers.get('x-forwarded-for') ?? headers.get('x-real-ip');
  return normalizeClientIp(resolveClientIpFromXff(xff));
}
