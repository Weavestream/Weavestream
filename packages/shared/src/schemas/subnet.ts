import { z } from 'zod';

// ---------------------------------------------------------------------------
// IPv4 helpers
// ---------------------------------------------------------------------------

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const m = IPV4_RE.exec(ip);
  if (!m) return null;
  const octets = [+m[1]!, +m[2]!, +m[3]!, +m[4]!] as [number, number, number, number];
  if (octets.some((o) => o > 255)) return null;
  return octets;
}

function ipToUint32(octets: [number, number, number, number]): number {
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function uint32ToIp(n: number): string {
  return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
}

function prefixMask(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

/**
 * Normalise a CIDR string to its canonical network address form.
 * `10.0.0.5/24` -> `10.0.0.0/24`.  Returns `null` on invalid input.
 */
export function normalizeCidrV4(input: string): string | null {
  const trimmed = input.trim();
  const slash = trimmed.indexOf('/');
  if (slash < 0) return null;
  const host = trimmed.slice(0, slash);
  const prefixStr = trimmed.slice(slash + 1);
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const octets = parseIpv4Octets(host);
  if (!octets) return null;
  const network = (ipToUint32(octets) & prefixMask(prefix)) >>> 0;
  return `${uint32ToIp(network)}/${prefix}`;
}

/**
 * Return the number of usable host IPs for a given prefix length.
 * /31 and /32 are special-cased per RFC 3021.
 */
export function usableHostCount(prefix: number): number {
  if (prefix === 32) return 1;
  if (prefix === 31) return 2;
  const total = 2 ** (32 - prefix);
  return total - 2; // subtract network + broadcast
}

/**
 * Check whether a host IP falls within a CIDR. Both must be valid IPv4.
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  const hostOctets = parseIpv4Octets(ip.trim());
  if (!hostOctets) return false;
  const normalized = normalizeCidrV4(cidr);
  if (!normalized) return false;
  const slash = normalized.indexOf('/');
  const netOctets = parseIpv4Octets(normalized.slice(0, slash));
  const prefix = Number(normalized.slice(slash + 1));
  if (!netOctets) return false;
  const mask = prefixMask(prefix);
  return ((ipToUint32(hostOctets) & mask) >>> 0) === ((ipToUint32(netOctets) & mask) >>> 0);
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const cidrV4Schema = z
  .string()
  .min(1)
  .max(18) // 255.255.255.255/32
  .transform((v) => normalizeCidrV4(v))
  .refine((v): v is string => v !== null, {
    message: 'Must be a valid IPv4 CIDR (e.g. 10.0.0.0/24)',
  });

export const ipv4HostSchema = z
  .string()
  .min(1)
  .max(15) // 255.255.255.255
  .refine((v) => parseIpv4Octets(v.trim()) !== null, {
    message: 'Must be a valid IPv4 address',
  })
  .transform((v) => v.trim());

function validateDhcpRange(
  o: {
    cidr?: string | null;
    dhcpRangeStart?: string | null;
    dhcpRangeEnd?: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  const start = o.dhcpRangeStart ?? null;
  const end = o.dhcpRangeEnd ?? null;
  if (start == null && end == null) return;
  if (start == null || end == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [start == null ? 'dhcpRangeStart' : 'dhcpRangeEnd'],
      message: 'DHCP range start and end must both be set',
    });
    return;
  }
  const startOctets = parseIpv4Octets(start);
  const endOctets = parseIpv4Octets(end);
  if (!startOctets || !endOctets) return; // ipv4HostSchema will have already flagged it
  if (ipToUint32(startOctets) > ipToUint32(endOctets)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dhcpRangeEnd'],
      message: 'DHCP range end must be >= start',
    });
  }
  if (o.cidr) {
    if (!ipInCidr(start, o.cidr)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dhcpRangeStart'],
        message: `Outside subnet ${o.cidr}`,
      });
    }
    if (!ipInCidr(end, o.cidr)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dhcpRangeEnd'],
        message: `Outside subnet ${o.cidr}`,
      });
    }
  }
}

export const createSubnetSchema = z
  .object({
    name: z.string().min(1).max(200),
    cidr: cidrV4Schema,
    vlanId: z.number().int().min(1).max(4094).nullish(),
    gateway: ipv4HostSchema.nullish(),
    dhcpRangeStart: ipv4HostSchema.nullish(),
    dhcpRangeEnd: ipv4HostSchema.nullish(),
    description: z.string().max(2000).nullish(),
  })
  .superRefine(validateDhcpRange);
export type CreateSubnetInput = z.input<typeof createSubnetSchema>;

export const updateSubnetSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    cidr: cidrV4Schema.optional(),
    vlanId: z.number().int().min(1).max(4094).nullish(),
    gateway: ipv4HostSchema.nullish(),
    dhcpRangeStart: ipv4HostSchema.nullish(),
    dhcpRangeEnd: ipv4HostSchema.nullish(),
    description: z.string().max(2000).nullish(),
  })
  .refine((o) => Object.keys(o).length > 0, {
    message: 'At least one field must be provided',
  })
  .superRefine(validateDhcpRange);
export type UpdateSubnetInput = z.input<typeof updateSubnetSchema>;

export const createIpReservationSchema = z.object({
  ipAddress: ipv4HostSchema,
  label: z.string().min(1).max(200),
  notes: z.string().max(2000).nullish(),
});
export type CreateIpReservationInput = z.input<typeof createIpReservationSchema>;

export const updateIpReservationSchema = z
  .object({
    ipAddress: ipv4HostSchema.optional(),
    label: z.string().min(1).max(200).optional(),
    notes: z.string().max(2000).nullish(),
  })
  .refine((o) => Object.keys(o).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateIpReservationInput = z.input<typeof updateIpReservationSchema>;
