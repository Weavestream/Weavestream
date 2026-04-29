import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { ipAddressOptionsSchema } from '@weavestream/shared';
import type { FieldTypeStrategy } from '../field-type-strategy.js';

/**
 * Stores a single IPv4 or IPv6 address, optionally with a CIDR suffix,
 * as a plain string. The shape is intentionally flat so Phase 6 search
 * can index it and the upcoming IPAM feature can issue inexpensive
 * equality / prefix filters against it via `AssetFieldValue.value` JSON
 * ops.
 *
 * Validation is regex-first — we don't pull in a full IP library because
 * the canonical forms we accept are narrow:
 *   - IPv4: four 0-255 octets separated by dots
 *   - IPv6: RFC 4291 textual form (compressed `::` allowed at most once)
 *   - CIDR: trailing `/N` where N is within the family's valid range
 *
 * IPv6 literals are lowercased on write so two operators entering
 * `2001:DB8::1` and `2001:db8::1` don't produce visually distinct rows
 * in the list and conflict-check UI.
 */

const IPV4_OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_RX = new RegExp(`^${IPV4_OCTET}(\\.${IPV4_OCTET}){3}$`);

// Compressed or fully-expanded IPv6 form. Validating every corner of
// RFC 4291 with a single regex is notoriously fiddly, so we check the
// overall shape here and rely on `normalizeIp()` to reject degenerate
// inputs (e.g. multiple `::`).
const IPV6_SEGMENT = '[0-9a-fA-F]{1,4}';
const IPV6_RX = new RegExp(
  `^(` +
    `(${IPV6_SEGMENT}:){7}${IPV6_SEGMENT}` + // 1:2:3:4:5:6:7:8
    `|(${IPV6_SEGMENT}:){1,7}:` + // 1::   1:2:3:4:5:6:7::
    `|(${IPV6_SEGMENT}:){1,6}:${IPV6_SEGMENT}` + // 1::8   1:2:3:4:5:6::8
    `|(${IPV6_SEGMENT}:){1,5}(:${IPV6_SEGMENT}){1,2}` +
    `|(${IPV6_SEGMENT}:){1,4}(:${IPV6_SEGMENT}){1,3}` +
    `|(${IPV6_SEGMENT}:){1,3}(:${IPV6_SEGMENT}){1,4}` +
    `|(${IPV6_SEGMENT}:){1,2}(:${IPV6_SEGMENT}){1,5}` +
    `|${IPV6_SEGMENT}:(:${IPV6_SEGMENT}){1,6}` +
    `|:(:${IPV6_SEGMENT}){1,7}` +
    `|::` +
  `)$`,
);

type IpOptions = z.infer<typeof ipAddressOptionsSchema>;

function splitCidr(raw: string): { host: string; prefix: number | null } {
  const idx = raw.indexOf('/');
  if (idx < 0) return { host: raw, prefix: null };
  const host = raw.slice(0, idx);
  const n = Number(raw.slice(idx + 1));
  return { host, prefix: Number.isFinite(n) ? n : NaN };
}

function detectVersion(host: string): 'v4' | 'v6' | null {
  if (IPV4_RX.test(host)) return 'v4';
  if (IPV6_RX.test(host)) return 'v6';
  return null;
}

function withResolvedOptions(options: Record<string, unknown>): IpOptions {
  const parsed = ipAddressOptionsSchema.safeParse(options);
  return parsed.success
    ? parsed.data
    : { version: 'any', allowCidr: false };
}

/**
 * Returns the canonical string form when valid, or `null` otherwise. We
 * accept inputs liberally (any casing, surrounding whitespace) and emit
 * a normalized form so downstream consumers can compare IPs byte-wise.
 */
function normalizeIp(input: string, opts: IpOptions): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const { host, prefix } = splitCidr(trimmed);
  const detected = detectVersion(host);
  if (!detected) return null;
  if (opts.version !== 'any' && detected !== opts.version) return null;

  if (prefix !== null) {
    if (!opts.allowCidr) return null;
    const max = detected === 'v4' ? 32 : 128;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  }

  // IPv6 text form is case-insensitive; lowercasing gives us a single
  // canonical surface. We keep IPv4 as-is since it has no case variation.
  const canonicalHost = detected === 'v6' ? host.toLowerCase() : host;
  return prefix === null ? canonicalHost : `${canonicalHost}/${prefix}`;
}

export class IpAddressStrategy implements FieldTypeStrategy {
  readonly kind = 'IP_ADDRESS' as const;
  readonly searchable = true;
  readonly optionsSchema = ipAddressOptionsSchema;

  valueSchema(options: Record<string, unknown>): z.ZodTypeAny {
    const opts = withResolvedOptions(options);
    return z.union([
      z.null(),
      z
        .string()
        .min(1)
        .max(64)
        .refine(
          (v) => normalizeIp(v, opts) !== null,
          opts.allowCidr
            ? 'Must be a valid IPv4 or IPv6 address, optionally with a /N CIDR suffix'
            : 'Must be a valid IPv4 or IPv6 address',
        ),
    ]);
  }

  normalize(
    input: unknown,
    options: Record<string, unknown>,
  ): Prisma.InputJsonValue {
    if (input === null || input === undefined || input === '')
      return null as unknown as Prisma.InputJsonValue;
    const opts = withResolvedOptions(options);
    const out = normalizeIp(String(input), opts);
    // Honor the strategy contract: the normalized value MUST round-trip
    // through `valueSchema`. Returning a non-IP string here would let
    // unvalidated callers (e.g. the integration sync runner pulling an
    // upstream "10.0.0.35, 10.0.0.50" string from a multi-NIC RMM agent)
    // persist garbage that later breaks IPAM `inet` queries. Reject by
    // returning `null` so the caller treats the value as unset rather
    // than as a typed IP address.
    return (out ?? null) as unknown as Prisma.InputJsonValue;
  }

  toPlaintext(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }
}
