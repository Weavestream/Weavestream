import { z } from 'zod';
import { passwordGeneratorDefaultsSchema } from './password-generator.js';

/**
 * Workspace + tenant-term schema for the instance-wide singleton settings
 * row (see packages/db/prisma/schema.prisma `SystemSetting`). UI labels
 * only — URL routes, Prisma column names, and audit action keys continue
 * to say "company" under the hood.
 */

const trimmedString = (min: number, max: number, label: string) =>
  z
    .string()
    .transform((v) => v.trim())
    .pipe(
      z
        .string()
        .min(min, `${label} must be at least ${min} character${min === 1 ? '' : 's'}`)
        .max(max, `${label} must be at most ${max} characters`),
    );

export const systemSettingsSchema = z.object({
  workspaceName: z.string().min(1).max(60),
  workspaceSubtitle: z.string().min(1).max(60),
  tenantTermSingular: z.string().min(1).max(40),
  tenantTermPlural: z.string().min(1).max(40),
  tenantTermPossessive: z.string().min(1).max(40).nullable(),
  passwordGeneratorDefaults: passwordGeneratorDefaultsSchema,
  updatedAt: z.string(),
});

export const updateSettingsSchema = z
  .object({
    workspaceName: trimmedString(1, 60, 'Workspace name').optional(),
    workspaceSubtitle: trimmedString(1, 60, 'Workspace subtitle').optional(),
    tenantTermSingular: trimmedString(1, 40, 'Singular term').optional(),
    tenantTermPlural: trimmedString(1, 40, 'Plural term').optional(),
    // Possessive is optional and can be explicitly cleared via null so the
    // UI can "fall back to `${singular}'s`" without a magic empty string.
    tenantTermPossessive: z
      .union([trimmedString(1, 40, 'Possessive term'), z.null()])
      .optional(),
    passwordGeneratorDefaults: passwordGeneratorDefaultsSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');

export type SystemSettings = z.infer<typeof systemSettingsSchema>;
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
