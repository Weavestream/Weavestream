import type { IpRuleAction } from './schemas/ip-rule.js';
import { bigIntToIpv6, ipv6Mask, ipv6ToBigInt } from './ipv6.js';

/**
 * Shared IPv4 + IPv6 CIDR matcher for the IP allow/deny rules.
 *
 * Used by both `IpRuleGuard` (API, blocks API requests) and the
 * Next.js `proxy.ts` (web, blocks page renders) so the two layers
 * can't drift on edge cases (IPv4-mapped IPv6, /32 vs single-IP,
 * malformed input, etc.).
 *
 * Address families never cross. An IPv4 rule matches IPv4 clients —
 * including IPv4-mapped IPv6 clients (`::ffff:1.2.3.4`) — exactly as it
 * did before IPv6 support; an IPv6 rule matches the remaining IPv6
 * clients. So `0.0.0.0/0` does not match an IPv6 visitor and `::/0`
 * does not match an IPv4 one: a catch-all needs one rule per family,
 * and `findCatchAllFamilyGap` reports a rule set that denies only one.
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
export function matchIpRule<R extends IpRuleLike>(ip: string, rules: readonly R[]): R | null {
  const client = classifyClientIp(ip);
  for (const rule of rules) {
    const contains =
      client.family === 6
        ? ipv6CidrContains(rule.cidr, client.value)
        : cidrContains(rule.cidr, client.text);
    if (contains) return rule;
  }
  return null;
}

/**
 * The client IP as the matcher sees it. An IPv4-mapped IPv6 address in
 * any spelling collapses to plain IPv4 (`::ffff:1.2.3.4` → `1.2.3.4`)
 * so a dual-stack client matches IPv4 rules; any other IPv6 address
 * becomes its RFC 5952 form. Other inputs pass through trimmed and
 * lower-cased.
 */
export function normalizeIpForMatch(ip: string): string {
  const client = classifyClientIp(ip);
  return client.family === 6 ? bigIntToIpv6(client.value) : client.text;
}

/**
 * The identity per-IP limits count against: the address itself for
 * IPv4 (an IPv4-mapped client counts as its IPv4 address), and the /64
 * prefix for IPv6, written `2001:db8:1:2::/64`. One IPv6 subscriber
 * normally holds a whole /64 and can rotate through it at will, so
 * counting each address separately would give a single client 2^64
 * lockout and throttle buckets. Anything that is not an IP address (the
 * `unknown` fallback) comes back trimmed and lower-cased.
 */
export function ipLimitKey(ip: string): string {
  const client = classifyClientIp(ip);
  if (client.family === 4) return client.text;
  return `${bigIntToIpv6(client.value & ipv6Mask(64))}/64`;
}

/** Why a value is not a usable IPv6 rule, precise enough to word a fix. */
export type Ipv6CidrRejection =
  | 'not-ipv6'
  | 'zone-id'
  | 'brackets-or-port'
  | 'prefix'
  | 'ipv4-mapped';

export type Ipv6CidrParseResult =
  | {
      ok: true;
      /** The address with its host bits cleared. */
      network: bigint;
      mask: bigint;
      prefix: number;
      /** RFC 5952 address, plus `/prefix` when one was written. */
      canonical: string;
    }
  | { ok: false; reason: Ipv6CidrRejection };

/**
 * Parse an IPv6 address or CIDR written for an IP rule. A bare address
 * is a /128.
 *
 * Rejected: zone IDs (rules match addresses, not interfaces), brackets
 * or ports, a prefix outside 0–128, and IPv4-mapped addresses — mapped
 * clients are matched as IPv4, so such a rule could never match
 * anything. The IP rule schema turns each reason into its message, and
 * the matcher uses this same parser, so a rule that validates is a rule
 * that can match.
 */
export function parseIpv6Cidr(input: string): Ipv6CidrParseResult {
  const text = input.trim();
  const slash = text.indexOf('/');
  const address = slash === -1 ? text : text.slice(0, slash);
  const prefixText = slash === -1 ? null : text.slice(slash + 1);

  const value = ipv6ToBigInt(address);
  if (value === null) return { ok: false, reason: whyNotIpv6(address) };
  if (prefixText !== null && (!/^\d{1,3}$/.test(prefixText) || Number(prefixText) > 128)) {
    return { ok: false, reason: 'prefix' };
  }
  if (value >> 32n === IPV4_MAPPED_HIGH_BITS) {
    return { ok: false, reason: 'ipv4-mapped' };
  }

  const prefix = prefixText === null ? 128 : Number(prefixText);
  const mask = ipv6Mask(prefix);
  const canonicalAddress = bigIntToIpv6(value);
  return {
    ok: true,
    network: value & mask,
    mask,
    prefix,
    canonical: prefixText === null ? canonicalAddress : `${canonicalAddress}/${prefix}`,
  };
}

export type IpFamily = 'IPv4' | 'IPv6';

/** A catch-all DENY that covers only one address family. */
export type CatchAllFamilyGap = {
  /** The family a catch-all DENY rule covers. */
  family: IpFamily;
  /** The family no catch-all covers, whose clients fall through to default-allow. */
  uncoveredFamily: IpFamily;
  /** That DENY rule's CIDR as stored, e.g. `0.0.0.0/0`. */
  cidr: string;
};

/**
 * Detect the "DENY 0.0.0.0/0 still lets IPv6 in" mistake. Catch-alls
 * are per family (see the module comment), so this reports a gap when
 * the first catch-all of one family is a DENY and the other family has
 * no catch-all at all — its clients then fall through to default-allow.
 * An explicit catch-all for the other family, ALLOW or DENY, is a
 * deliberate choice and is not reported; neither is an ALLOW catch-all
 * on its own, which behaves like default-allow anyway. Pass the enabled
 * rules in evaluation order.
 */
export function findCatchAllFamilyGap<R extends IpRuleLike>(
  rules: readonly R[],
): CatchAllFamilyGap | null {
  const first: Partial<Record<IpFamily, R>> = {};
  for (const rule of rules) {
    const family = catchAllFamily(rule.cidr);
    if (family && !first[family]) first[family] = rule;
  }
  const pairs = [
    ['IPv4', 'IPv6'],
    ['IPv6', 'IPv4'],
  ] as const;
  for (const [family, uncoveredFamily] of pairs) {
    const rule = first[family];
    if (rule?.action === 'DENY' && !first[uncoveredFamily]) {
      return { family, uncoveredFamily, cidr: rule.cidr };
    }
  }
  return null;
}

/**
 * Operator-facing explanation of a `CatchAllFamilyGap`, shared by the
 * IP rules page and the Security Center so both say the same thing.
 */
export function describeCatchAllFamilyGap(gap: CatchAllFamilyGap): string {
  const counterpart = gap.uncoveredFamily === 'IPv6' ? '::/0' : '0.0.0.0/0';
  return (
    `The DENY rule ${gap.cidr} blocks every ${gap.family} client that no ` +
    `earlier rule allows, but no rule covers all of ${gap.uncoveredFamily}, ` +
    `so ${gap.uncoveredFamily} visitors that match no other rule are allowed. ` +
    `Add a ${counterpart} rule with the action you want for them.`
  );
}

// ── Internals ───────────────────────────────────────────────────────

type ClientIp = { family: 4; text: string } | { family: 6; value: bigint };

// The high 96 bits of `::ffff:0:0/96`, the IPv4-mapped block.
const IPV4_MAPPED_HIGH_BITS = 0xffffn;

/**
 * Sort a client IP into the family whose rules can match it. IPv4, an
 * IPv4-mapped address, and anything unparseable take the IPv4 path with
 * its original string handling (so no IPv4 behavior changes, and junk
 * simply matches nothing); a real IPv6 address takes the IPv6 path.
 */
function classifyClientIp(ip: string): ClientIp {
  const trimmed = ip.trim().toLowerCase();
  if (trimmed.startsWith('::ffff:')) {
    const v4 = trimmed.slice('::ffff:'.length);
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(v4)) return { family: 4, text: v4 };
  }
  const value = trimmed.includes(':') ? ipv6ToBigInt(trimmed) : null;
  if (value === null) return { family: 4, text: trimmed };
  if (value >> 32n === IPV4_MAPPED_HIGH_BITS) {
    return { family: 4, text: intToIpv4(Number(value & 0xffffffffn)) };
  }
  return { family: 6, value };
}

function intToIpv4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

// Name the near miss so the schema's message can say what to remove.
function whyNotIpv6(address: string): Ipv6CidrRejection {
  const zone = address.indexOf('%');
  if (zone > 0 && ipv6ToBigInt(address.slice(0, zone)) !== null) {
    return 'zone-id';
  }
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(address);
  if (bracketed?.[1] && ipv6ToBigInt(bracketed[1]) !== null) {
    return 'brackets-or-port';
  }
  return 'not-ipv6';
}

/** The family a rule covers entirely (a /0), or null for anything narrower. */
function catchAllFamily(cidr: string): IpFamily | null {
  const pattern = cidr.trim().toLowerCase();
  if (!pattern.includes('/')) return null;
  if (pattern.includes(':')) {
    const parsed = parseIpv6Cidr(pattern);
    return parsed.ok && parsed.prefix === 0 ? 'IPv6' : null;
  }
  // Mirrors `cidrContains`: a valid IPv4 subnet with a /0 prefix
  // contains every IPv4 client.
  const [subnet, prefixStr] = pattern.split('/');
  if (!subnet || !prefixStr || ipv4ToNumber(subnet) === null) return null;
  return parseInt(prefixStr, 10) === 0 ? 'IPv4' : null;
}

function ipv6CidrContains(cidr: string, value: bigint): boolean {
  const parsed = parseIpv6Cidr(cidr);
  return parsed.ok && (value & parsed.mask) === parsed.network;
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
