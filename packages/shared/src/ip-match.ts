import type { IpRuleAction } from './schemas/ip-rule.js';

/**
 * Shared IPv4 + CIDR matcher for the IP allow/deny rules.
 *
 * Used by both `IpRuleGuard` (API, blocks API requests) and the
 * Next.js `proxy.ts` (web, blocks page renders) so the two layers
 * can't drift on edge cases (IPv4-mapped IPv6, /32 vs single-IP,
 * malformed input, etc.).
 *
 * IPv4 only. An IPv6 client IP collapses to plain v4 if it's an
 * IPv4-mapped address (`::ffff:1.2.3.4`); otherwise nothing matches
 * — rules use IPv4 CIDR syntax exclusively.
 */

export type IpRuleLike = {
  cidr: string;
  action: IpRuleAction;
  priority: number;
};

/**
 * Find the first rule whose CIDR contains `ip`. Returns `null` if
 * no rule matches (caller decides default-allow vs default-deny).
 *
 * Rules are evaluated in the order given — the caller is responsible
 * for sorting by priority ascending before calling this.
 */
export function matchIpRule<R extends IpRuleLike>(
  ip: string,
  rules: readonly R[],
): R | null {
  const target = normalizeIpForMatch(ip);
  for (const rule of rules) {
    if (cidrContains(rule.cidr, target)) return rule;
  }
  return null;
}

/**
 * Strip the IPv4-mapped IPv6 prefix (`::ffff:1.2.3.4` → `1.2.3.4`) so
 * a dual-stack client matches plain IPv4 rules. Other inputs pass
 * through unchanged.
 */
export function normalizeIpForMatch(ip: string): string {
  const trimmed = ip.trim().toLowerCase();
  if (trimmed.startsWith('::ffff:')) {
    const v4 = trimmed.slice('::ffff:'.length);
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(v4)) return v4;
  }
  return trimmed;
}

function cidrContains(cidr: string, ip: string): boolean {
  const pattern = cidr.trim().toLowerCase();
  if (!pattern.includes('/')) {
    return ip === pattern;
  }
  const [subnet, prefixStr] = pattern.split('/');
  if (!subnet || !prefixStr) return false;
  const prefix = parseInt(prefixStr, 10);
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return false;

  const ipNum = ipv4ToNumber(ip);
  const subnetNum = ipv4ToNumber(subnet);
  if (ipNum === null || subnetNum === null) return false;

  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return ((ipNum ^ subnetNum) & mask) === 0;
}

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = parseInt(part, 10);
    if (n < 0 || n > 255) return null;
    result = (result * 256 + n) >>> 0;
  }
  return result >>> 0;
}
