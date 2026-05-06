import { z } from 'zod';

/**
 * Cloudflare Rules Lists integration — DTOs and validators.
 *
 * The integration manages Cloudflare IP allow-lists. Weavestream is the
 * authoritative source: every UI mutation pushes the full list to
 * Cloudflare via atomic bulk PUT replace, and a periodic worker reads
 * Cloudflare's view back to detect drift. Rich local metadata (a free-
 * text `description` per entry) lives in Postgres; the description is
 * NOT echoed into Cloudflare's per-item `comment` field.
 */

// ---------------------------------------------------------------------
// IP / CIDR validation
// ---------------------------------------------------------------------

/**
 * Strict IPv4 octet — 0-255 with no leading zeros (so "01.2.3.4" is
 * rejected). Cloudflare rejects leading-zero octets too.
 */
const IPV4_OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])';
const IPV4_RE = new RegExp(`^(?:${IPV4_OCTET}\\.){3}${IPV4_OCTET}$`);

/**
 * Permissive IPv6 matcher. Covers all common shapes (full, compressed,
 * IPv4-mapped) but not zone identifiers like `fe80::1%eth0` — Cloudflare
 * doesn't accept those for rules lists. False positives are caught by
 * Cloudflare on push and surfaced to the operator.
 */
const IPV6_RE =
  /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,7}:$|^(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}$|^(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}$|^(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}$|^[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}$|^::$/;

export type IpEntryKind = 'ipv4' | 'ipv6';

export interface IpEntryParseResult {
  kind: IpEntryKind;
  /** Lowercased / trimmed canonical form. IPv6 is lowercased; IPv4 stays as-is. */
  canonical: string;
  /** Optional CIDR prefix length. NULL for a single host. */
  prefix: number | null;
}

/**
 * Parse and canonicalise an IPv4/IPv6 entry, with or without a CIDR
 * prefix. Returns NULL if the input is not a valid Cloudflare list
 * entry. The result's `canonical` is the form Weavestream stores and
 * sends to Cloudflare.
 */
export function parseIpEntry(input: string): IpEntryParseResult | null {
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 64) return null;

  let address = raw;
  let prefix: number | null = null;
  const slashIdx = raw.indexOf('/');
  if (slashIdx >= 0) {
    address = raw.slice(0, slashIdx);
    const prefixPart = raw.slice(slashIdx + 1);
    if (!/^\d+$/.test(prefixPart)) return null;
    prefix = Number(prefixPart);
    if (!Number.isFinite(prefix)) return null;
  }

  if (IPV4_RE.test(address)) {
    if (prefix !== null && (prefix < 0 || prefix > 32)) return null;
    return {
      kind: 'ipv4',
      canonical: prefix === null ? address : `${address}/${prefix}`,
      prefix,
    };
  }
  if (IPV6_RE.test(address)) {
    if (prefix !== null && (prefix < 0 || prefix > 128)) return null;
    const lower = address.toLowerCase();
    return {
      kind: 'ipv6',
      canonical: prefix === null ? lower : `${lower}/${prefix}`,
      prefix,
    };
  }
  return null;
}

export const cloudflareIpEntryValueSchema = z
  .string()
  .min(1, 'IP is required')
  .max(64, 'IP is too long')
  .transform((v, ctx) => {
    const parsed = parseIpEntry(v);
    if (!parsed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Must be a valid IPv4 or IPv6 address or CIDR range.',
      });
      return z.NEVER;
    }
    return parsed.canonical;
  });

const cloudflareDescriptionSchema = z
  .string()
  .trim()
  .max(1000, 'Description is too long (max 1000 characters)')
  .optional()
  .default('');

// ---------------------------------------------------------------------
// External Cloudflare list (browser → register flow)
// ---------------------------------------------------------------------

/**
 * Snapshot of a Cloudflare list as returned by `GET /accounts/.../rules/lists`.
 * Used by the "Register list" dialog so the operator can pick from the
 * lists that exist in their CF account.
 */
export const cloudflareExternalListDtoSchema = z.object({
  externalListId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** Cloudflare-reported entry count at the time of the read. */
  numItems: z.number().int().nonnegative(),
  /**
   * Cloudflare list kind: `ip`, `redirect`, `hostname`, `asn`, etc.
   * Only `ip` lists can be registered; the dialog shows others greyed
   * out so the operator can see why they aren't available.
   */
  kind: z.string(),
  /** True when Weavestream is already managing this list. */
  alreadyRegistered: z.boolean(),
});

export type CloudflareExternalListDto = z.infer<
  typeof cloudflareExternalListDtoSchema
>;

// ---------------------------------------------------------------------
// CloudflareIpList DTOs
// ---------------------------------------------------------------------

export const cloudflareDriftStatusSchema = z.enum([
  'in_sync',
  'drift_detected',
  'unknown',
  'error',
]);
export type CloudflareDriftStatusValue = z.infer<
  typeof cloudflareDriftStatusSchema
>;

export const cloudflareIpEntryDtoSchema = z.object({
  /** Canonicalised IP / CIDR — also serves as the entry key in PATCH/DELETE URLs. */
  ip: z.string(),
  description: z.string().default(''),
});
export type CloudflareIpEntryDto = z.infer<typeof cloudflareIpEntryDtoSchema>;

export const cloudflareDriftDetailsSchema = z
  .object({
    /** Entries Weavestream has but Cloudflare doesn't. */
    missingOnCf: z.array(z.string()).default([]),
    /** Entries Cloudflare has but Weavestream doesn't. */
    extraOnCf: z
      .array(z.object({ ip: z.string(), comment: z.string().nullable() }))
      .default([]),
    /** Diagnostic from the last drift check, set when the check itself failed. */
    lastError: z.string().nullable().optional(),
  })
  .nullable();
export type CloudflareDriftDetailsDto = z.infer<
  typeof cloudflareDriftDetailsSchema
>;

export const cloudflareIpListDtoSchema = z.object({
  id: z.string().uuid(),
  integrationId: z.string().uuid(),
  externalAccountId: z.string(),
  externalListId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  entries: z.array(cloudflareIpEntryDtoSchema),
  entriesVersion: z.number().int(),
  driftStatus: cloudflareDriftStatusSchema,
  driftDetails: cloudflareDriftDetailsSchema,
  lastDriftCheckAt: z.string().nullable(),
  lastPushedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CloudflareIpListDto = z.infer<typeof cloudflareIpListDtoSchema>;

// ---------------------------------------------------------------------
// Mutation inputs
// ---------------------------------------------------------------------

export const registerCloudflareListSchema = z.object({
  externalListId: z.string().min(1),
});
export type RegisterCloudflareListInput = z.infer<
  typeof registerCloudflareListSchema
>;

export const cloudflareEntryInputSchema = z.object({
  ip: cloudflareIpEntryValueSchema,
  description: cloudflareDescriptionSchema,
});
export type CloudflareEntryInput = z.infer<typeof cloudflareEntryInputSchema>;

/**
 * All mutation requests carry the `entriesVersion` the client loaded so
 * the API can detect a concurrent edit and 409 instead of clobbering.
 */
export const cloudflareAddEntrySchema = cloudflareEntryInputSchema.extend({
  entriesVersion: z.number().int().nonnegative(),
});
export type CloudflareAddEntryInput = z.infer<typeof cloudflareAddEntrySchema>;

export const cloudflareUpdateEntrySchema = cloudflareEntryInputSchema.extend({
  entriesVersion: z.number().int().nonnegative(),
});
export type CloudflareUpdateEntryInput = z.infer<
  typeof cloudflareUpdateEntrySchema
>;

export const cloudflareRemoveEntrySchema = z.object({
  entriesVersion: z.number().int().nonnegative(),
});
export type CloudflareRemoveEntryInput = z.infer<
  typeof cloudflareRemoveEntrySchema
>;

export const cloudflareOverwriteSchema = z.object({
  entriesVersion: z.number().int().nonnegative(),
});
export type CloudflareOverwriteInput = z.infer<typeof cloudflareOverwriteSchema>;

/**
 * Response shape from any mutation. Cloudflare's Gateway PATCH endpoint
 * is synchronous, so every successful push completes within the API
 * request — no async polling required.
 */
export const cloudflarePushResponseSchema = z.object({
  list: cloudflareIpListDtoSchema,
});
export type CloudflarePushResponse = z.infer<typeof cloudflarePushResponseSchema>;
