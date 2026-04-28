import { z } from 'zod';

/**
 * User-configurable email alert system.
 *
 * Five disjoint alert types share a single envelope so the admin list
 * can render every config in one table. Per-type validation is enforced
 * at the API boundary via `alertConfigInputSchema.refine(...)` which
 * picks the matching shape based on `type`.
 *
 * Two execution paths consume these configs:
 *   - Scheduled BullMQ (alerts:scan) for the three time/state-based
 *     types (SINGLE_EXPIRATION, EXPIRATION_LIST, WEBSITE_DOWN).
 *   - `AlertEmitterService`, called synchronously inside
 *     `AuditLogService.log()`, for RECORD_EVENT and PASSWORD_EVENT.
 *
 * Keep the shared schema isomorphic — no Node imports — so the web
 * dialog can reuse the same Zod object for its client-side validation.
 */

export const alertTypeValues = [
  'SINGLE_EXPIRATION',
  'EXPIRATION_LIST',
  'WEBSITE_DOWN',
  'RECORD_EVENT',
  'PASSWORD_EVENT',
] as const;
export const alertTypeSchema = z.enum(alertTypeValues);
export type AlertType = z.infer<typeof alertTypeSchema>;

// Subset of expiration sources the runner inspects. `all` is a
// convenience marker the runner expands to the four concrete kinds.
export const expirationKindValues = [
  'asset',
  'domain_registrar',
  'domain_tls',
  'password',
  'all',
] as const;
export const expirationKindSchema = z.enum(expirationKindValues);
export type AlertExpirationKind = z.infer<typeof expirationKindSchema>;

// Entity types we surface for RECORD_EVENT alerts. `all` matches every
// entity type the audit log emits a CRUD row for.
export const recordEntityTypeValues = [
  'asset',
  'article',
  'password',
  'domain',
  'all',
] as const;
export const recordEntityTypeSchema = z.enum(recordEntityTypeValues);
export type AlertRecordEntityType = z.infer<typeof recordEntityTypeSchema>;

export const recordActionValues = [
  'created',
  'updated',
  'deleted',
  'all',
] as const;
export const recordActionSchema = z.enum(recordActionValues);
export type AlertRecordAction = z.infer<typeof recordActionSchema>;

const trimmedEmail = z.string().trim().email().max(255);

/**
 * One-or-more recipient list. Accepts either an array of trimmed
 * emails (canonical form) or a comma/semicolon/newline-separated
 * string for ergonomic form input — the latter is split, trimmed,
 * de-duplicated, and re-validated as individual emails.
 */
const recipientEmailsSchema = z
  .union([z.array(trimmedEmail), trimmedEmail, z.string()])
  .transform((raw, ctx) => {
    const parts = Array.isArray(raw)
      ? raw
      : raw.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const p of parts) {
      const v = p.trim();
      if (!v) continue;
      const key = v.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push(v);
    }
    if (cleaned.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one recipient email is required',
      });
      return z.NEVER;
    }
    for (const v of cleaned) {
      const parsed = trimmedEmail.safeParse(v);
      if (!parsed.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${v}" is not a valid email`,
        });
        return z.NEVER;
      }
    }
    return cleaned;
  });

const trimmedName = z
  .string()
  .transform((v) => v.trim())
  .pipe(z.string().min(1, 'Name is required').max(120, 'Name is too long'));

const optionalCompanyId = z.string().uuid().nullable();

// 1 .. 365 days. Matches the upper bound used by the existing
// `MonitoredDomain.alertThresholdDays` UI so the two surfaces feel
// the same — go far enough out for an annual TLS cert, no further.
const triggerDaysSchema = z.number().int().min(1).max(365);

/**
 * Output shape — the full row as the API returns it. `archivedAt` is
 * never returned (archived rows are filtered out by the controller),
 * but we keep `enabled` so the list view can render the toggle.
 */
export const alertConfigSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  type: alertTypeSchema,
  enabled: z.boolean(),
  recipientEmails: z.array(z.string()),
  companyId: z.string().uuid().nullable(),
  triggerDays: z.number().int().nullable(),
  stopAfterTrigger: z.boolean(),
  expirationKinds: z.array(expirationKindSchema),
  recordEntityTypes: z.array(recordEntityTypeSchema),
  recordActions: z.array(recordActionSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AlertConfig = z.infer<typeof alertConfigSchema>;

/**
 * Create/update input. The DB keeps every per-type column nullable /
 * default-empty so the same row shape fits every type — the per-type
 * `superRefine` below is what turns "missing required field" into a
 * 400 with a nice path-scoped error.
 */
export const alertConfigInputSchema = z
  .object({
    name: trimmedName,
    type: alertTypeSchema,
    enabled: z.boolean().default(true),
    recipientEmails: recipientEmailsSchema,
    companyId: optionalCompanyId.default(null),
    triggerDays: triggerDaysSchema.nullable().default(null),
    stopAfterTrigger: z.boolean().default(true),
    expirationKinds: z.array(expirationKindSchema).default([]),
    recordEntityTypes: z.array(recordEntityTypeSchema).default([]),
    recordActions: z.array(recordActionSchema).default([]),
  })
  .superRefine((input, ctx) => {
    const expirationLike =
      input.type === 'SINGLE_EXPIRATION' || input.type === 'EXPIRATION_LIST';
    if (expirationLike) {
      if (input.triggerDays == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['triggerDays'],
          message: 'Trigger days is required for expiration alerts',
        });
      }
      if (input.expirationKinds.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['expirationKinds'],
          message: 'Pick at least one expiration kind',
        });
      }
    }
    if (input.type === 'RECORD_EVENT') {
      if (input.recordEntityTypes.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['recordEntityTypes'],
          message: 'Pick at least one record type',
        });
      }
      if (input.recordActions.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['recordActions'],
          message: 'Pick at least one action',
        });
      }
    }
    if (input.type === 'PASSWORD_EVENT') {
      if (input.recordActions.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['recordActions'],
          message: 'Pick at least one action (created or updated)',
        });
      }
      // Password vault doesn't support hard delete — only archive — so
      // the dialog hides 'deleted' for this type. Belt-and-suspenders
      // server-side: silently drop 'deleted' if it sneaks through.
      const invalid = input.recordActions.find(
        (a) => a !== 'created' && a !== 'updated' && a !== 'all',
      );
      if (invalid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['recordActions'],
          message: 'Password alerts only support created or updated',
        });
      }
    }
  });

export type AlertConfigInput = z.infer<typeof alertConfigInputSchema>;

/**
 * PATCH variant — every field is optional, but if `type` changes the
 * caller is still bound by the per-type required-fields constraint
 * because the API loads-then-merges before validating with
 * `alertConfigInputSchema`.
 */
export const alertConfigPatchSchema = z
  .object({
    name: trimmedName.optional(),
    type: alertTypeSchema.optional(),
    enabled: z.boolean().optional(),
    recipientEmails: recipientEmailsSchema.optional(),
    companyId: optionalCompanyId.optional(),
    triggerDays: triggerDaysSchema.nullable().optional(),
    stopAfterTrigger: z.boolean().optional(),
    expirationKinds: z.array(expirationKindSchema).optional(),
    recordEntityTypes: z.array(recordEntityTypeSchema).optional(),
    recordActions: z.array(recordActionSchema).optional(),
  })
  .refine(
    (v) => Object.keys(v).length > 0,
    'At least one field must be provided',
  );

export type AlertConfigPatch = z.infer<typeof alertConfigPatchSchema>;

/**
 * Test-send payload — uses the saved config's email, but the caller
 * may override the recipient (so an admin can send a real-looking
 * sample to themselves before going live).
 */
export const alertTestSchema = z.object({
  /** Optional override — accepts the same forms as `recipientEmails`. */
  recipients: recipientEmailsSchema.optional(),
});
export type AlertTestInput = z.infer<typeof alertTestSchema>;

/** Human labels used by both the admin dialog and email rendering. */
export const ALERT_TYPE_LABELS: Record<AlertType, string> = {
  SINGLE_EXPIRATION: 'Single expiration',
  EXPIRATION_LIST: 'Expiration list',
  WEBSITE_DOWN: 'Website down',
  RECORD_EVENT: 'Record created/updated/deleted',
  PASSWORD_EVENT: 'Password created/updated',
};

export const ALERT_TYPE_DESCRIPTIONS: Record<AlertType, string> = {
  SINGLE_EXPIRATION:
    'Receive an alert when an expiration hits a trigger number of days.',
  EXPIRATION_LIST:
    'Receive a digest list when expirations hit a trigger number of days.',
  WEBSITE_DOWN: 'Receive a notification when a monitored website appears down.',
  RECORD_EVENT:
    'Receive an alert when a record has been created, updated, or deleted.',
  PASSWORD_EVENT:
    'Receive an alert when a password has been created or updated.',
};
