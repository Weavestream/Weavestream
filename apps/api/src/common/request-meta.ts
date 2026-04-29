import type { Request } from 'express';

/**
 * Audit-row metadata extracted from an Express request: the resolved
 * client IP and a length-bounded User-Agent string.
 *
 * The IP comes from {@link ipOf}, which trusts only what Express has
 * already resolved via its `trust proxy` setting. We deliberately do
 * NOT re-parse the raw `X-Forwarded-For` header here — when the API
 * is reachable directly (no reverse proxy in front, misconfigured
 * `TRUST_PROXY_HOPS`, contractor poking at the host port), a client
 * can set whatever XFF value they like and previous code would have
 * accepted it as ground truth, defeating per-IP rate limiting,
 * lockouts, and audit attribution. With Express's `trust proxy`
 * model `req.ip` is the leftmost untrusted hop of the verified
 * forwarded chain (or the socket peer if no proxy is trusted), which
 * is the value we actually want everywhere.
 */
export type RequestMeta = { ip: string; userAgent: string };

export function requestMetaOf(req: Request): RequestMeta {
  return { ip: ipOf(req), userAgent: userAgentOf(req) };
}

export function ipOf(req: Request): string {
  return normalizeIp(req.ip);
}

/**
 * Strip the `::ffff:` IPv4-mapped IPv6 prefix that Node sets when an
 * IPv4 client connects to a dual-stack listener. Without this, an
 * inbound `192.168.1.50` shows up everywhere as `::ffff:192.168.1.50`,
 * which:
 *   - never matches IPv4 CIDRs in the IP allow/deny rules,
 *   - splits per-IP lockout / throttle counters between the v4 and
 *     v4-in-v6 representations of the same client,
 *   - clutters audit rows.
 * The mapped form is purely a transport artifact, so collapsing it
 * down to plain v4 here is the consistent thing to do.
 */
export function normalizeIp(ip: string | null | undefined): string {
  if (!ip) return '0.0.0.0';
  if (ip.startsWith('::ffff:')) {
    const v4 = ip.slice('::ffff:'.length);
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(v4)) return v4;
  }
  return ip;
}

export function userAgentOf(req: Request): string {
  return (req.headers['user-agent'] ?? 'unknown').toString().slice(0, 500);
}
