/**
 * IPv6 address arithmetic, shared by the IP allow/deny matcher
 * (`ip-match.ts`, used by the API guard and the Next.js proxy) and the
 * API's egress guard (`apps/api/src/common/egress/private-cidrs.ts`).
 *
 * Browser-safe: only `URL` and `BigInt`, no Node built-ins.
 */

// Hex digits, colons, and the dots of an embedded IPv4 tail. Checked
// before the URL parser sees the value, so brackets, ports, slashes,
// zone IDs, and whitespace can never be smuggled through it — without
// this, `::1]:80/[::2` would parse as `::1`.
const IPV6_TEXT = /^[0-9a-f:.]+$/i;

/**
 * Parse one plain textual IPv6 address into its 128-bit value, or return
 * null.
 *
 * Accepts the compressed (`::`) and full forms in any letter case, and an
 * embedded IPv4 tail (`::ffff:192.0.2.1`). Rejects everything else,
 * including zone IDs (`fe80::1%eth0`), brackets, ports, and prefix
 * lengths. A caller that must tolerate a zone ID strips it first.
 */
export function ipv6ToBigInt(ip: string): bigint | null {
  if (!ip.includes(':') || !IPV6_TEXT.test(ip)) return null;
  // The WHATWG URL host parser rejects malformed forms and canonicalises
  // the rest: lower case, with an IPv4 tail rewritten as two hex groups.
  let canonical: string;
  try {
    const u = new URL(`http://[${ip}]/`);
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

/** Mask covering the leading `prefix` bits of a 128-bit address. */
export function ipv6Mask(prefix: number): bigint {
  if (prefix === 0) return 0n;
  const ones = (1n << BigInt(prefix)) - 1n;
  return ones << BigInt(128 - prefix);
}

/**
 * Render a 128-bit value as canonical IPv6 text (RFC 5952: lower case,
 * no leading zeros, the first longest run of zero groups compressed to
 * `::`).
 */
export function bigIntToIpv6(value: bigint): string {
  const groups: string[] = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) {
    groups.push(((value >> shift) & 0xffffn).toString(16));
  }
  // The URL serializer applies exactly the RFC 5952 compression rules.
  const u = new URL(`http://[${groups.join(':')}]/`);
  return u.hostname.replace(/^\[/, '').replace(/\]$/, '');
}
