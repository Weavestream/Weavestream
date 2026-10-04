import { z } from 'zod';

/**
 * Response contracts for `GET /expirations` and
 * `GET /companies/:id/expirations` — the unified feed of asset-field
 * (isExpiry) dates, domain (registrar/TLS) expiries, and password
 * expiry/rotation dates. Read-only; the API builds these rows with ISO
 * string dates.
 */

export const expirationStatusSchema = z.enum(['EXPIRED', 'WARNING']);

export const assetFieldExpirationSchema = z.object({
  kind: z.literal('asset-field'),
  companyId: z.string().uuid(),
  companyName: z.string(),
  companySlug: z.string(),
  assetId: z.string().uuid(),
  assetName: z.string(),
  layoutId: z.string().uuid(),
  layoutName: z.string(),
  layoutIcon: z.string(),
  layoutColor: z.string(),
  fieldId: z.string().uuid(),
  fieldSlug: z.string(),
  fieldLabel: z.string(),
  fieldType: z.enum(['DATE', 'DATETIME']),
  /** ISO 8601 (date-only for DATE, full timestamp for DATETIME). */
  expiresAt: z.string(),
  /** Signed whole days to expiry. Negative values are already expired. */
  daysUntil: z.number().int(),
  status: expirationStatusSchema,
  /** Effective threshold used to keep this row (per-field override or default). */
  warnWithinDays: z.number().int(),
});

export const domainExpirationSchema = z.object({
  kind: z.literal('domain'),
  companyId: z.string().uuid(),
  companyName: z.string(),
  companySlug: z.string(),
  domainId: z.string().uuid(),
  hostname: z.string(),
  source: z.enum(['registrar', 'tls']),
  expiresAt: z.string(),
  daysUntil: z.number().int(),
  status: expirationStatusSchema,
});

export const passwordExpirationSchema = z.object({
  kind: z.literal('password'),
  companyId: z.string().uuid(),
  companyName: z.string(),
  companySlug: z.string(),
  passwordId: z.string().uuid(),
  passwordName: z.string(),
  /**
   * Two disjoint sources per password: `expiry` for the hard
   * `expiresAt` cutoff (the credential should stop being used after
   * this date) and `rotation` for the soft "should be rotated by now"
   * date derived from `lastRotatedAt + rotationReminderDays`. A single
   * credential can yield up to one row of each kind.
   */
  source: z.enum(['expiry', 'rotation']),
  expiresAt: z.string(),
  daysUntil: z.number().int(),
  status: expirationStatusSchema,
});

export const expirationRowSchema = z.discriminatedUnion('kind', [
  assetFieldExpirationSchema,
  domainExpirationSchema,
  passwordExpirationSchema,
]);

export type ExpirationStatus = z.infer<typeof expirationStatusSchema>;
export type AssetFieldExpiration = z.infer<typeof assetFieldExpirationSchema>;
export type DomainExpiration = z.infer<typeof domainExpirationSchema>;
export type PasswordExpiration = z.infer<typeof passwordExpirationSchema>;
export type ExpirationRow = z.infer<typeof expirationRowSchema>;
