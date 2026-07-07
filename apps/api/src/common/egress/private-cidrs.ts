/**
 * Hard-coded blocklist of address ranges that should never be reachable
 * from operator-supplied URLs. Covers every ground covered by RFC 6890
 * "Special-Purpose IP Address Registries" plus a couple of cloud-specific
 * gotchas (notably 169.254.169.254 — AWS / GCP / Azure metadata).
 *
 * Operators can punch holes in this for legitimate on-prem integrations
 * via `EGRESS_ALLOWED_PRIVATE_CIDRS`, or short-circuit the whole guard
 * with `EGRESS_ALLOW_PRIVATE_NETWORKS=true`. Both are wired in at boot
 * by `configureEgressGuard`.
 */

export type Cidr = {
  readonly raw: string;
  readonly family: 4 | 6;
  /** v4: 32-bit unsigned. v6: BigInt (128-bit). */
  readonly base: number | bigint;
  /** Mask covering the leading `prefix` bits. */
  readonly mask: number | bigint;
  readonly prefix: number;
};

const PRIVATE_BLOCKLIST_V4: ReadonlyArray<string> = [
  '0.0.0.0/8', // "this network"
  '10.0.0.0/8', // RFC1918
  '100.64.0.0/10', // Carrier-grade NAT
  '127.0.0.0/8', // Loopback
  '169.254.0.0/16', // Link-local incl. cloud metadata (169.254.169.254)
  '172.16.0.0/12', // RFC1918
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // TEST-NET-1
  '192.168.0.0/16', // RFC1918
  '198.18.0.0/15', // Benchmarking
  '198.51.100.0/24', // TEST-NET-2
  '203.0.113.0/24', // TEST-NET-3
  '224.0.0.0/4', // Multicast
  '240.0.0.0/4', // Reserved
  '255.255.255.255/32', // Limited broadcast
];

const PRIVATE_BLOCKLIST_V6: ReadonlyArray<string> = [
  '::/128', // Unspecified
  '::1/128', // Loopback
  '::ffff:0:0/96', // IPv4-mapped (caught upstream by normalizeIp, but defense in depth)
  '64:ff9b::/96', // IPv4/IPv6 translation
  '100::/64', // Discard
  '2001::/23', // IETF protocol assignments
  '2001:db8::/32', // Documentation
  'fc00::/7', // Unique local
  'fe80::/10', // Link-local
  'ff00::/8', // Multicast
];

/**
 * Curated private ranges reachable when an admin explicitly opts an AI
 * endpoint into private-network access (Settings → AI → "Allow
 * private-network addresses"). Passed per-call via
 * `SafeFetchOptions.extraAllowedPrivateCidrs`, so — unlike the blanket
 * `allowPrivateNetworks: true` bypass — DNS-rebinding pinning stays on
 * and everything outside this list (cloud metadata 169.254.169.254,
 * link-local, multicast, reserved) stays blocked. Includes CGNAT
 * 100.64.0.0/10 for Tailscale-hosted LLMs. Operators needing anything
 * beyond this list still have `EGRESS_ALLOWED_PRIVATE_CIDRS`.
 */
export const ADMIN_PRIVATE_ENDPOINT_CIDRS: readonly Cidr[] = parseCidrList(
  '127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,::1/128,fc00::/7',
);

let cachedDefaults: Cidr[] | null = null;

export function defaultBlockedCidrs(): readonly Cidr[] {
  if (cachedDefaults) return cachedDefaults;
  cachedDefaults = [
    ...PRIVATE_BLOCKLIST_V4.map((c) => parseCidr(c)),
    ...PRIVATE_BLOCKLIST_V6.map((c) => parseCidr(c)),
  ];
  return cachedDefaults;
}

/**
 * Parse a CIDR string into a structured form. Throws on garbage so a
 * misconfigured `EGRESS_ALLOWED_PRIVATE_CIDRS` fails loudly at boot
 * rather than silently letting traffic through.
 */
export function parseCidr(input: string): Cidr {
  const raw = input.trim();
  const slash = raw.indexOf('/');
  const addr = slash === -1 ? raw : raw.slice(0, slash);
  const prefixStr = slash === -1 ? null : raw.slice(slash + 1);

  if (addr.includes(':')) {
    const fullPrefix = prefixStr === null ? 128 : Number.parseInt(prefixStr, 10);
    if (!Number.isFinite(fullPrefix) || fullPrefix < 0 || fullPrefix > 128) {
      throw new Error(`Invalid IPv6 CIDR prefix: ${raw}`);
    }
    const base = ipv6ToBigInt(addr);
    if (base === null) throw new Error(`Invalid IPv6 address: ${raw}`);
    const mask = ipv6Mask(fullPrefix);
    return { raw, family: 6, base: base & mask, mask, prefix: fullPrefix };
  }

  const fullPrefix = prefixStr === null ? 32 : Number.parseInt(prefixStr, 10);
  if (!Number.isFinite(fullPrefix) || fullPrefix < 0 || fullPrefix > 32) {
    throw new Error(`Invalid IPv4 CIDR prefix: ${raw}`);
  }
  const base = ipv4ToInt(addr);
  if (base === null) throw new Error(`Invalid IPv4 address: ${raw}`);
  const mask = ipv4Mask(fullPrefix);
  return { raw, family: 4, base: (base & mask) >>> 0, mask, prefix: fullPrefix };
}

export function parseCidrList(input: string | null | undefined): Cidr[] {
  if (!input) return [];
  return input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(parseCidr);
}

export function ipMatchesAny(ip: string, cidrs: readonly Cidr[]): Cidr | null {
  if (ip.includes(':')) {
    const v6 = ipv6ToBigInt(ip);
    if (v6 === null) return null;
    for (const c of cidrs) {
      if (c.family !== 6) continue;
      if ((v6 & (c.mask as bigint)) === (c.base as bigint)) return c;
    }
    return null;
  }
  const v4 = ipv4ToInt(ip);
  if (v4 === null) return null;
  for (const c of cidrs) {
    if (c.family !== 4) continue;
    if (((v4 & (c.mask as number)) >>> 0) === (c.base as number)) return c;
  }
  return null;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number.parseInt(p, 10);
    if (n < 0 || n > 255) return null;
    acc = (acc << 8) | n;
  }
  return acc >>> 0;
}

function ipv4Mask(prefix: number): number {
  if (prefix === 0) return 0;
  return (0xffffffff << (32 - prefix)) >>> 0;
}

function ipv6ToBigInt(ip: string): bigint | null {
  // Strip optional zone (e.g. fe80::1%eth0); we don't route on zones.
  const stripped = ip.split('%')[0] ?? ip;
  // Reject anything that isn't a valid v6 form. We use Node's URL parser
  // for canonicalisation by feeding it `[ip]:80` — non-standard chars
  // throw and we return null.
  let canonical: string;
  try {
    const u = new URL(`http://[${stripped}]/`);
    // hostname comes back lowercased, with leading [
    canonical = u.hostname.replace(/^\[/, '').replace(/\]$/, '');
  } catch {
    return null;
  }

  // Expand `::` shorthand.
  let head: string[] = [];
  let tail: string[] = [];
  if (canonical.includes('::')) {
    const [hRaw = '', tRaw = ''] = canonical.split('::');
    head = hRaw.length > 0 ? hRaw.split(':') : [];
    tail = tRaw.length > 0 ? tRaw.split(':') : [];
    const fillCount = 8 - head.length - tail.length;
    if (fillCount < 0) return null;
    head = [...head, ...Array<string>(fillCount).fill('0'), ...tail];
  } else {
    head = canonical.split(':');
  }
  if (head.length !== 8) return null;

  let acc = 0n;
  for (const group of head) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    acc = (acc << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return acc;
}

function ipv6Mask(prefix: number): bigint {
  if (prefix === 0) return 0n;
  const ones = (1n << BigInt(prefix)) - 1n;
  return ones << BigInt(128 - prefix);
}

// Test-only export so the spec can verify CIDR arithmetic without
// re-parsing the IPs through the higher-level safeFetch layer.
export const __testing = { ipv4ToInt, ipv4Mask, ipv6ToBigInt, ipv6Mask };
