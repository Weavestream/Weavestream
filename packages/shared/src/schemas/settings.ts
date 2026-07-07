import { z } from 'zod';
import { articleEditorModeSchema } from './article.js';
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

const nullableTrimmedString = (min: number, max: number, label: string) =>
  z.union([trimmedString(min, max, label), z.null()]);

export const systemSettingsSchema = z.object({
  workspaceName: z.string().min(1).max(60),
  workspaceSubtitle: z.string().min(1).max(60),
  tenantTermSingular: z.string().min(1).max(40),
  tenantTermPlural: z.string().min(1).max(40),
  tenantTermPossessive: z.string().min(1).max(40).nullable(),
  passwordGeneratorDefaults: passwordGeneratorDefaultsSchema,
  articleAutosaveEnabled: z.boolean(),
  articleDefaultEditorMode: articleEditorModeSchema,
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
    articleAutosaveEnabled: z.boolean().optional(),
    articleDefaultEditorMode: articleEditorModeSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');

export type SystemSettings = z.infer<typeof systemSettingsSchema>;
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

export const smtpSecurityModeValues = ['STARTTLS', 'TLS', 'NONE'] as const;
export const smtpSecurityModeSchema = z.enum(smtpSecurityModeValues);

export const emailSettingsSchema = z.object({
  enabled: z.boolean(),
  host: z.string().min(1).max(255).nullable(),
  port: z.number().int().min(1).max(65535).nullable(),
  secureMode: smtpSecurityModeSchema,
  username: z.string().min(1).max(255).nullable(),
  fromName: z.string().min(1).max(120).nullable(),
  fromEmail: z.string().email().max(255).nullable(),
  replyTo: z.string().email().max(255).nullable(),
  passwordConfigured: z.boolean(),
  updatedAt: z.string(),
});

export const updateEmailSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    host: nullableTrimmedString(1, 255, 'SMTP host').optional(),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    secureMode: smtpSecurityModeSchema.optional(),
    username: nullableTrimmedString(1, 255, 'SMTP username').optional(),
    password: z.string().min(1).max(1024, 'SMTP password is too long').optional(),
    clearPassword: z.boolean().optional(),
    fromName: nullableTrimmedString(1, 120, 'From name').optional(),
    fromEmail: z.string().trim().email().max(255).nullable().optional(),
    replyTo: z.string().trim().email().max(255).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided')
  .refine((v) => !(v.password && v.clearPassword), {
    message: 'Cannot set and clear the SMTP password in the same request',
    path: ['password'],
  });

export const testEmailSettingsSchema = z.object({
  recipient: z.string().trim().email().max(255),
  subject: trimmedString(1, 120, 'Subject').optional(),
});

export type SmtpSecurityMode = z.infer<typeof smtpSecurityModeSchema>;
export type EmailSettings = z.infer<typeof emailSettingsSchema>;
export type UpdateEmailSettingsInput = z.infer<typeof updateEmailSettingsSchema>;
export type TestEmailSettingsInput = z.infer<typeof testEmailSettingsSchema>;

/**
 * Workspace-wide OpenAI-compatible LLM endpoint (Ollama, LMStudio, vLLM,
 * OpenAI itself, …). Foundation only — nothing in the app calls the LLM
 * yet. The API key is encrypted server-side and never returned; clients
 * only see the `apiKeyConfigured` boolean.
 */
export const aiSettingsSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z.string().min(1).max(2048).nullable(),
  defaultModel: z.string().min(1).max(120).nullable(),
  apiKeyConfigured: z.boolean(),
  /**
   * Output-token ceiling for chat completions and the budget reserved
   * for the model's reply (e.g. a full article rewrite). `null` falls
   * back to a conservative server default.
   */
  maxOutputTokens: z.number().int().min(256).max(200_000).nullable(),
  /**
   * Total context window of the configured model, used to size the
   * prompt budget so the reply fits. `null` falls back to a
   * conservative server default.
   */
  contextWindowTokens: z.number().int().min(1_024).max(2_000_000).nullable(),
  /**
   * Opt-in for AI endpoints on private/LAN addresses (local Ollama,
   * LM Studio). Off by default; when enabled, only curated private ranges
   * are reachable — cloud-metadata and link-local stay blocked.
   */
  allowPrivateNetwork: z.boolean(),
  updatedAt: z.string(),
});

export const updateAiSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    baseUrl: z
      .union([
        z.string().trim().url('Base URL must be a valid URL').max(2048),
        z.null(),
      ])
      .optional(),
    apiKey: z.string().min(1).max(1024, 'API key is too long').optional(),
    clearApiKey: z.boolean().optional(),
    defaultModel: nullableTrimmedString(1, 120, 'Default model').optional(),
    // Null explicitly resets to the server default; omitted leaves as-is.
    maxOutputTokens: z.number().int().min(256).max(200_000).nullable().optional(),
    contextWindowTokens: z
      .number()
      .int()
      .min(1_024)
      .max(2_000_000)
      .nullable()
      .optional(),
    allowPrivateNetwork: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided')
  .refine((v) => !(v.apiKey && v.clearApiKey), {
    message: 'Cannot set and clear the API key in the same request',
    path: ['apiKey'],
  })
  // When both limits are set explicitly in the same request, the output
  // ceiling must leave room for a prompt. (Partial updates and
  // null→default cases are additionally clamped server-side at resolve
  // time so a stored pair can never collapse the budget.)
  .refine(
    (v) =>
      !(
        v.maxOutputTokens != null &&
        v.contextWindowTokens != null &&
        v.maxOutputTokens >= v.contextWindowTokens
      ),
    {
      message: 'Max output tokens must be less than the context window.',
      path: ['maxOutputTokens'],
    },
  );

export type AiSettings = z.infer<typeof aiSettingsSchema>;
export type UpdateAiSettingsInput = z.infer<typeof updateAiSettingsSchema>;

export const aiTestResultSchema = z.object({
  ok: z.literal(true),
  models: z.array(z.string()),
});
export type AiTestResult = z.infer<typeof aiTestResultSchema>;

/**
 * Optional overrides for `POST /settings/ai/test`. When omitted, the
 * endpoint uses the persisted config; when provided, it tests the
 * in-flight values without requiring a save first.
 */
export const testAiSettingsSchema = z
  .object({
    baseUrl: z.string().trim().url('Base URL must be a valid URL').max(2048).optional(),
    apiKey: z.string().min(1).max(1024).optional(),
    allowPrivateNetwork: z.boolean().optional(),
  })
  .optional();
export type TestAiSettingsInput = z.infer<typeof testAiSettingsSchema>;
