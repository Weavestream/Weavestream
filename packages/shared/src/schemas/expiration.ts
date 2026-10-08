import { z } from 'zod';

/**
 * Response contracts for `GET /expirations` and
 * `GET /companies/:id/expirations` — the unified feed of asset-field
 * (isExpiry) dates, domain (registrar/TLS) expiries, and password
 * expiry/rotation dates. Read-only; the API builds these rows with ISO
 * string dates.
 */

export const expirationStatusSchema = z.enum(['EXPIRED', 'WARNING']);


/** Set on a row when it was dismissed for this due date (only returned with `includeDismissed`). */
export const expirationDismissalInfoSchema = z.object({
  id: z.string().uuid(),
  note: z.string().nullable(),
  dismissedAt: z.string(),
  dismissedBy: z.string().uuid().nullable(),
});

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
  dismissal: expirationDismissalInfoSchema.optional(),
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
  dismissal: expirationDismissalInfoSchema.optional(),
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
  dismissal: expirationDismissalInfoSchema.optional(),
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

/**
 * Dismiss one Expiring-soon row for its current due date. `source` is the
 * asset field id for `asset-field` rows, `registrar`/`tls` for domains and
 * `expiry`/`rotation` for passwords.
 */
export const dismissExpirationSchema = z
  .object({
    kind: z.enum(['asset-field', 'domain', 'password']),
    entityId: z.string().uuid(),
    source: z.string().min(1).max(64),
    dueAt: z.string().min(1).max(40),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type DismissExpirationInput = z.infer<typeof dismissExpirationSchema>;

/** The identity of a row for dismissal purposes: one item, one source, one due date. */
export function expirationDismissalKey(
  kind: string,
  entityId: string,
  source: string,
  dueAt: string | Date,
): string {
  return `${kind}:${entityId}:${source}:${new Date(dueAt).toISOString()}`;
}

/** Map a row to the (entityId, source) that identify it. */
export function expirationRowIdentity(row: ExpirationRow): { entityId: string; source: string } {
  if (row.kind === 'asset-field') return { entityId: row.assetId, source: row.fieldId };
  if (row.kind === 'domain') return { entityId: row.domainId, source: row.source };
  return { entityId: row.passwordId, source: row.source };
}

