import { z } from 'zod';

/**
 * Scheduled Postgres export schemas.
 *
 * Two surfaces ship together:
 *   - `BackupConfig` — admin-managed schedule (cron + timezone + GFS
 *     retention + notification recipients).
 *   - `BackupRun`    — one row per dump attempt; surfaced read-only on
 *     the History tab.
 *
 * Both shapes are isomorphic between client and server so the admin
 * dialog can re-use these schemas for client-side validation without
 * pulling in any Node APIs.
 */

export const backupRunKindValues = ['SCHEDULED', 'MANUAL'] as const;
export const backupRunKindSchema = z.enum(backupRunKindValues);
export type BackupRunKind = z.infer<typeof backupRunKindSchema>;

export const backupRunStatusValues = [
  'queued',
  'running',
  'success',
  'failed',
] as const;
export const backupRunStatusSchema = z.enum(backupRunStatusValues);
export type BackupRunStatus = z.infer<typeof backupRunStatusSchema>;

/**
 * Standard 5-field cron pattern: `minute hour day-of-month month day-of-week`.
 * BullMQ uses cron-parser which is permissive about spacing; we tighten
 * the boundary regex to surface obviously bad input early.
 */
const cronPatternRegex =
  /^[\d\*/,\-?LW#A-Za-z]+(?:\s+[\d\*/,\-?LW#A-Za-z]+){4}$/;
const cronSchema = z
  .string()
  .trim()
  .min(9, 'Cron pattern must have five space-separated fields')
  .max(120, 'Cron pattern too long')
  .refine(
    (v) => cronPatternRegex.test(v),
    'Must be a 5-field cron pattern (e.g. "0 3 * * *")',
  );

/**
 * Subset of IANA timezone names is huge — we just enforce shape and
 * defer the real validation to the runner, which builds a `Date` via
 * the underlying cron-parser library.
 */
const timezoneSchema = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .regex(/^[A-Za-z0-9_+\-/]+$/, 'Must be a valid IANA timezone identifier')
  .nullable()
  .optional();

const retentionSchema = z.object({
  daily: z.number().int().min(0).max(365).default(7),
  weekly: z.number().int().min(0).max(104).default(4),
  monthly: z.number().int().min(0).max(120).default(12),
});
export type BackupRetention = z.infer<typeof retentionSchema>;

const trimmedEmail = z.string().trim().email().max(255);

const notifyEmailsSchema = z
  .union([z.array(trimmedEmail), z.string()])
  .transform((raw) => {
    const parts = Array.isArray(raw)
      ? raw
      : raw.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const p of parts) {
      const result = trimmedEmail.safeParse(p);
      if (!result.success) {
        throw new z.ZodError([
          {
            code: z.ZodIssueCode.custom,
            path: ['notifyEmails'],
            message: `"${p}" is not a valid email address.`,
          },
        ]);
      }
      const key = result.data.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push(result.data);
    }
    return cleaned;
  });

export const backupConfigSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  enabled: z.boolean(),
  cron: z.string(),
  timezone: z.string().nullable(),
  retention: retentionSchema,
  notifyEmails: z.array(z.string()),
  notifyOnSuccess: z.boolean(),
  lastRunAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BackupConfig = z.infer<typeof backupConfigSchema>;

export const backupConfigInputSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  enabled: z.boolean().default(true),
  cron: cronSchema,
  timezone: timezoneSchema,
  retention: retentionSchema.default({ daily: 7, weekly: 4, monthly: 12 }),
  notifyEmails: notifyEmailsSchema.default([]),
  notifyOnSuccess: z.boolean().default(false),
});
export type BackupConfigInput = z.infer<typeof backupConfigInputSchema>;

export const backupConfigPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    enabled: z.boolean().optional(),
    cron: cronSchema.optional(),
    timezone: timezoneSchema,
    retention: retentionSchema.optional(),
    notifyEmails: notifyEmailsSchema.optional(),
    notifyOnSuccess: z.boolean().optional(),
  })
  .refine(
    (v) => Object.keys(v).length > 0,
    'At least one field must be provided',
  );
export type BackupConfigPatch = z.infer<typeof backupConfigPatchSchema>;

export const backupRunDtoSchema = z.object({
  id: z.string().uuid(),
  configId: z.string().uuid().nullable(),
  configName: z.string().nullable(),
  kind: backupRunKindSchema,
  status: backupRunStatusSchema,
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  manifest: z.unknown().nullable(),
  dumpFilename: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
});
export type BackupRunDto = z.infer<typeof backupRunDtoSchema>;
