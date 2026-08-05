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
// entity type the audit log emits a CRUD row for. This list is also the
// UI picker — reserved security selectors (below) must never appear in
// it, or they would render as checkboxes in the record-type CheckGroup.
export const recordEntityTypeValues = [
  'asset',
  'article',
  'password',
  'domain',
  'all',
] as const;

/**
 * Reserved selectors for the three security alert kinds. `AlertType` is
 * a Postgres enum, so a sixth type would need a migration; instead a
 * security alert is stored as a `RECORD_EVENT` config whose
 * `recordEntityTypes` holds exactly one of these values (with
 * `recordActions: ['all']` and `companyId: null` — enforced by the
 * `superRefine` branch below). The namespaced `security:` prefix can
 * never collide with a real entity type, and `AlertEmitterService`
 * matches these configs on a fully separate path, so existing
 * `recordEntityTypes: ['all']` configs never auto-subscribe to
 * security events.
 */
export const securityAlertSelectorValues = [
  'security:sign-in-failures',
  'security:ip-blocked',
  'security:suspicious-activity',
] as const;
export type SecurityAlertSelector = (typeof securityAlertSelectorValues)[number];

export function isSecurityAlertSelector(
  value: unknown,
): value is SecurityAlertSelector {
  return (
    typeof value === 'string' &&
    (securityAlertSelectorValues as readonly string[]).includes(value)
  );
}

// The schema (unlike the picker list) accepts both real entity types and
// reserved selectors — it feeds the input, patch, and output schemas plus
// the `AlertRecordEntityType` type used by the emitter cache.
const allRecordEntityTypeValues = [
  ...recordEntityTypeValues,
  ...securityAlertSelectorValues,
] as const;
export const recordEntityTypeSchema = z.enum(allRecordEntityTypeValues);
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
 * Max distinct recipients a single alert may fan out to. Enforced here
 * at validation, again at the send path (`EmailService.send`), and by
 * the `0054_cap_alert_recipients` remediation migration for pre-existing
 * rows — all three reference this constant. Without a cap, a holder of
 * the delegable `alert.manage` capability can turn a routine alert into
 * an outbound-email amplifier (WS-031).
 */
export const MAX_ALERT_RECIPIENTS = 100;

// Hard ceiling on raw items/tokens before de-dup. Rejects the request
// before the (more expensive) de-duplication + per-email `safeParse`
// loops run over an oversized list. Deliberately above
// `MAX_ALERT_RECIPIENTS` so a paste with some duplicates that dedupe
// under the cap is still accepted.
const MAX_RAW_RECIPIENT_PARTS = 500;

// Hard ceiling on the raw string length — checked before the split so a
// pathological multi-megabyte body can't allocate a huge parts array.
const MAX_RECIPIENT_INPUT_LENGTH = 50_000;

/**
 * One-or-more recipient list. Accepts either an array of strings
 * (canonical form) or a comma/semicolon/newline-separated string for
 * ergonomic form input — the latter is split, trimmed, de-duplicated,
 * and re-validated as individual emails.
 *
 * Work bounds (what each guard actually caps):
 *   - String branch: `MAX_RECIPIENT_INPUT_LENGTH` is checked before the
 *     split, so a multi-megabyte string never allocates a huge parts
 *     array — genuinely the first thing that runs.
 *   - Array branch: Zod's `z.array(z.string())` has already traversed
 *     the whole array (string-typing every element) before this
 *     transform runs, so the initial array size is bounded by the API's
 *     2 MB request-body limit, NOT by our guards. `MAX_RAW_RECIPIENT_PARTS`
 *     then caps the de-duplication and per-email `safeParse` work that
 *     follows, and `z.array(z.string())` (not `z.array(trimmedEmail)`)
 *     keeps that pre-traversal to a cheap typeof-string check rather than
 *     a full email parse per element.
 *   - `MAX_ALERT_RECIPIENTS` is the security limit (distinct recipients);
 *     the per-email `safeParse` loop below it runs ≤ the cap times.
 */
const recipientEmailsSchema = z
  .union([z.array(z.string()), z.string()])
  .transform((raw, ctx) => {
    if (typeof raw === 'string' && raw.length > MAX_RECIPIENT_INPUT_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Recipient list is too long',
      });
      return z.NEVER;
    }
    const parts = Array.isArray(raw)
      ? raw
      : raw.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length > MAX_RAW_RECIPIENT_PARTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Too many recipients (max ${MAX_ALERT_RECIPIENTS})`,
      });
      return z.NEVER;
    }
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
    if (cleaned.length > MAX_ALERT_RECIPIENTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Too many recipients (max ${MAX_ALERT_RECIPIENTS})`,
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
 * Lightweight company ref bundled with `AlertConfig.company`. Keeps
 * the admin edit dialog and the list summary from having to resolve
 * UUIDs on the client just to render a name. Shape mirrors the
 * `CompanyParentRef` used elsewhere in the web app so the picker
 * value can be hydrated directly.
 */
export const alertConfigCompanyRefSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  archivedAt: z.string().nullable(),
});
export type AlertConfigCompanyRef = z.infer<typeof alertConfigCompanyRefSchema>;

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
  // Resolved company display fields — populated server-side when
  // `companyId` is set. `null` when the alert is unscoped (or, very
  // rarely, when the referenced company has been hard-deleted).
  company: alertConfigCompanyRefSchema.nullable(),
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
    // Reserved security selectors — deliberately NOT conditioned on
    // `type`: a client flipping a security config to another type may
    // still send the selector (the UI strips it, but old clients might
    // not), and `sanitiseForPersist` clears the arrays for every
    // non-RECORD_EVENT type, so enforcing the invariant whenever a
    // selector is present keeps hybrid shapes out of the database
    // regardless of the declared type.
    const reservedSelectors = input.recordEntityTypes.filter(
      isSecurityAlertSelector,
    );
    if (reservedSelectors.length > 0) {
      if (input.recordEntityTypes.length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['recordEntityTypes'],
          message: 'Security alerts cannot be combined with record types',
        });
      }
      if (input.companyId !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['companyId'],
          message: 'Security alerts are global and cannot be scoped to a company',
        });
      }
      if (input.recordActions.length !== 1 || input.recordActions[0] !== 'all') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['recordActions'],
          message: 'Security alerts do not use record actions',
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

/** Labels for the three security alert kinds (wizard cards, list, emails). */
export const SECURITY_ALERT_LABELS: Record<SecurityAlertSelector, string> = {
  'security:sign-in-failures': 'Repeated failed sign-ins',
  'security:ip-blocked': 'IP blocked or rate limited',
  'security:suspicious-activity': 'Suspicious account behavior',
};

export const SECURITY_ALERT_DESCRIPTIONS: Record<SecurityAlertSelector, string> =
  {
    'security:sign-in-failures':
      'Receive an alert when failed sign-in attempts reach the lockout threshold.',
    'security:ip-blocked':
      'Receive an alert when a request is denied by an IP rule or rate limited.',
    'security:suspicious-activity':
      'Receive an alert on refresh-token reuse, step-up anomalies, and repeated MFA, step-up, or password-change failures.',
  };
