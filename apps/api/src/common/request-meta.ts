import type { Request } from 'express';
import { matchIpRule, type IpRuleLike } from '@weavestream/shared';

/**
 * Audit-row metadata extracted from an Express request: the resolved
 * client IP and a length-bounded User-Agent string.
 *
 * The IP comes from {@link ipOf}, which trusts only what Express has
 * already resolved via its `trust proxy` setting. We deliberately do
 * NOT re-parse the raw `X-Forwarded-For` header here — when the API
 * is reachable directly (no reverse proxy in front, mis-exposed
 * api:4000 port, contractor poking at the host port), a client
 * can set whatever XFF value they like and previous code would have
 * accepted it as ground truth, defeating per-IP rate limiting,
 * lockouts, and audit attribution. The current `trust proxy` config
 * (private-bridge CIDRs, see `apps/api/src/main.ts`) means XFF is
 * honored only when the TCP peer is the `web` container, which
 * itself emits a sanitized single-entry chain — so `req.ip` is
 * either the real resolved client IP (bridge peer) or the socket
 * peer (anyone else).
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

const PRIVATE_PEER_RULES: IpRuleLike[] = [
  { cidr: '127.0.0.0/8', action: 'ALLOW', priority: 0 },
  { cidr: '169.254.0.0/16', action: 'ALLOW', priority: 0 },
  { cidr: '10.0.0.0/8', action: 'ALLOW', priority: 0 },
  { cidr: '172.16.0.0/12', action: 'ALLOW', priority: 0 },
  { cidr: '192.168.0.0/16', action: 'ALLOW', priority: 0 },
];

/**
 * Returns true if `ip` is a loopback, link-local, RFC1918 (IPv4) or
 * IPv6 loopback / link-local / unique-local address — i.e. the same
 * peer-trust families used by Express's `trust proxy` setting in
 * `main.ts`.
 *
 * Used to gate the internal `GET /api/v1/ip-rules/active` endpoint
 * that the Next.js `proxy.ts` calls so it can mirror the IP allow/
 * deny rules at the page-render layer. The TCP peer address can't
 * be spoofed by `X-Forwarded-For` headers, so this is a stronger
 * boundary than an `X-Internal-Token` shared secret would be (and
 * needs no env var).
 */
export function isPrivatePeer(ip: string | undefined | null): boolean {
  if (!ip) return false;
  const normalized = normalizeIp(ip).toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('fe80:')) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true;
  return matchIpRule(normalized, PRIVATE_PEER_RULES) !== null;
}
