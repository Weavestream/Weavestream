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

/**
 * Which AI apps may connect to the remote MCP endpoint. `claude_chatgpt`
 * accepts only claude.ai and ChatGPT; `any` accepts any app that supports
 * MCP sign-in (client metadata documents from any host, dynamic client
 * registration, loopback redirects). Every other gate is the same in both.
 */
export const mcpClientPolicyValues = ['claude_chatgpt', 'any'] as const;
export const mcpClientPolicySchema = z.enum(mcpClientPolicyValues);
export type McpClientPolicy = z.infer<typeof mcpClientPolicySchema>;

/** UI labels for {@link McpClientPolicy}. */
export const MCP_CLIENT_POLICY_LABELS: Record<McpClientPolicy, string> = {
  claude_chatgpt: 'Claude and ChatGPT only',
  any: 'Any MCP app',
};

export const systemSettingsSchema = z.object({
  workspaceName: z.string().min(1).max(60),
  workspaceSubtitle: z.string().min(1).max(60),
  tenantTermSingular: z.string().min(1).max(40),
  tenantTermPlural: z.string().min(1).max(40),
  tenantTermPossessive: z.string().min(1).max(40).nullable(),
  passwordGeneratorDefaults: passwordGeneratorDefaultsSchema,
  articleAutosaveEnabled: z.boolean(),
  articleDefaultEditorMode: articleEditorModeSchema,
  apiKeysEnabled: z.boolean(),
  mcpRemoteEnabled: z.boolean(),
  mcpClientPolicy: mcpClientPolicySchema,
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

/**
 * The API key switch has its own route (`PUT /settings/api-keys`) rather than
 * riding on the general settings PATCH: turning programmatic access on is a
 * security decision, so that route requires step-up and refuses API keys.
 */
export const updateApiKeysSettingSchema = z.object({ enabled: z.boolean() }).strict();
export type UpdateApiKeysSettingInput = z.infer<typeof updateApiKeysSettingSchema>;

/**
 * Same shape for the remote MCP switch (`PUT /settings/mcp-remote`): turning
 * on remote AI connections is a security decision with the same rules.
 */
export const updateMcpRemoteSettingSchema = updateApiKeysSettingSchema;
export type UpdateMcpRemoteSettingInput = UpdateApiKeysSettingInput;

/**
 * Which AI apps may connect (`PUT /settings/mcp-client-policy`). Same rules
 * as the switches above: step-up, and never reachable by a key or connection.
 */
export const updateMcpClientPolicySchema = z.object({ policy: mcpClientPolicySchema }).strict();
export type UpdateMcpClientPolicyInput = z.infer<typeof updateMcpClientPolicySchema>;

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
 * Which wire format, auth headers and request shaping the AI endpoint
 * uses. `openai_compatible` covers local servers (Ollama, LM Studio,
 * vLLM) and routers, and keeps their pre-provider behavior exactly.
 */
export const aiProviderSchema = z.enum(['openai', 'anthropic', 'openai_compatible']);
export type AiProvider = z.infer<typeof aiProviderSchema>;

/**
 * Reasoning target for chat. The server maps it per model family and
 * leaves it out where a model does not support it; background calls
 * (titles, summaries) always use the lowest supported setting.
 */
/**
 * Chat reasoning target. `default` sends no reasoning parameter at all
 * (the provider's own default, and the pre-0088 chat request shape);
 * `off` asks for the lowest setting the model supports.
 */
export const aiReasoningEffortSchema = z.enum(['default', 'off', 'low', 'medium', 'high']);
export type AiReasoningEffort = z.infer<typeof aiReasoningEffortSchema>;

/**
 * Server fallbacks used when an admin leaves the AI token limits blank.
 * The reply budget (16,384) leaves room for reasoning models to think
 * before they answer. Models with a smaller output limit (older GPT-4
 * Turbo and Claude 3.x models, some local servers) reject a larger
 * `max_tokens`, so admins set an explicit value for them.
 */
export const AI_DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
export const AI_DEFAULT_CONTEXT_WINDOW_TOKENS = 32_768;
export const AI_MAX_OUTPUT_TOKENS_RANGE = { min: 256, max: 200_000 } as const;
export const AI_CONTEXT_WINDOW_TOKENS_RANGE = { min: 1_024, max: 2_000_000 } as const;

/**
 * Highest reply budget the server allows for a context window: half the
 * window, so the prompt always keeps a positive budget and `max_tokens`
 * never exceeds the window.
 */
export function aiOutputTokenCap(contextWindowTokens: number): number {
  return Math.max(AI_MAX_OUTPUT_TOKENS_RANGE.min, Math.floor(contextWindowTokens / 2));
}

const maxOutputTokensSchema = z
  .number()
  .int()
  .min(AI_MAX_OUTPUT_TOKENS_RANGE.min)
  .max(AI_MAX_OUTPUT_TOKENS_RANGE.max);
const contextWindowTokensSchema = z
  .number()
  .int()
  .min(AI_CONTEXT_WINDOW_TOKENS_RANGE.min)
  .max(AI_CONTEXT_WINDOW_TOKENS_RANGE.max);

/** Sent as a request header, so the pattern is strict. */
const anthropicWorkspaceIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,128}$/, 'Workspace ID may contain only letters, digits, "_" and "-".');

/**
 * Workspace-wide LLM endpoint: OpenAI, Anthropic, or any
 * OpenAI-compatible server (Ollama, LM Studio, vLLM, …). The API key is
 * encrypted server-side and never returned; clients only see the
 * `apiKeyConfigured` boolean.
 */
export const aiSettingsSchema = z.object({
  enabled: z.boolean(),
  provider: aiProviderSchema,
  baseUrl: z.string().min(1).max(2048).nullable(),
  defaultModel: z.string().min(1).max(120).nullable(),
  /** Titles, the tool-intent prelude and summaries; null → `defaultModel`. */
  backgroundModel: z.string().min(1).max(120).nullable(),
  reasoningEffort: aiReasoningEffortSchema,
  /** Not a secret; only used with the `anthropic` provider. */
  anthropicWorkspaceId: z.string().min(1).max(128).nullable(),
  apiKeyConfigured: z.boolean(),
  /**
   * Output-token ceiling for chat completions and the budget reserved
   * for the model's reply (e.g. a full article rewrite). `null` falls
   * back to a conservative server default.
   */
  maxOutputTokens: maxOutputTokensSchema.nullable(),
  /**
   * Total context window of the configured model, used to size the
   * prompt budget so the reply fits. `null` falls back to a
   * conservative server default.
   */
  contextWindowTokens: contextWindowTokensSchema.nullable(),
  /**
   * Opt-in for AI endpoints on private/LAN addresses (local Ollama,
   * LM Studio). Off by default; when enabled, only curated private ranges
   * are reachable — cloud-metadata and link-local stay blocked.
   */
  allowPrivateNetwork: z.boolean(),
  /**
   * "Use AI to create auto summaries" (Phase 4). Separate explicit
   * opt-in from `enabled`, default false: when on, article titles and
   * content are sent to the configured endpoint whenever articles are
   * created or edited (a new data-class egress — the settings UI
   * carries this disclosure verbatim).
   */
  autoSummaries: z.boolean(),
  updatedAt: z.string(),
});

export const updateAiSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    provider: aiProviderSchema.optional(),
    baseUrl: z
      .union([
        z.string().trim().url('Base URL must be a valid URL').max(2048),
        z.null(),
      ])
      .optional(),
    apiKey: z.string().min(1).max(1024, 'API key is too long').optional(),
    clearApiKey: z.boolean().optional(),
    defaultModel: nullableTrimmedString(1, 120, 'Default model').optional(),
    backgroundModel: nullableTrimmedString(1, 120, 'Background model').optional(),
    reasoningEffort: aiReasoningEffortSchema.optional(),
    anthropicWorkspaceId: z
      .union([anthropicWorkspaceIdSchema, z.literal('').transform(() => null), z.null()])
      .optional(),
    // Null explicitly resets to the server default; omitted leaves as-is.
    maxOutputTokens: maxOutputTokensSchema.nullable().optional(),
    contextWindowTokens: contextWindowTokensSchema.nullable().optional(),
    allowPrivateNetwork: z.boolean().optional(),
    autoSummaries: z.boolean().optional(),
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

/**
 * Fixed codes for a failed or skipped reply check — never upstream text.
 * `http:*` carries `describeCompletionHttpError`'s bounded class.
 */
export const aiProbeResultSchema = z.object({
  status: z.enum(['ok', 'failed', 'skipped']),
  reason: z.string().max(80).optional(),
});
export type AiProbeResult = z.infer<typeof aiProbeResultSchema>;

export const aiTestResultSchema = z.object({
  ok: z.literal(true),
  /** `label` is a provider display name when one is reported. */
  models: z.array(z.object({ id: z.string(), label: z.string().optional() })),
  /** The one-prompt reply check; reported beside a successful model list. */
  probe: aiProbeResultSchema,
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
    provider: aiProviderSchema.optional(),
    anthropicWorkspaceId: anthropicWorkspaceIdSchema.optional(),
    /** Model for the reply check; without one the check is skipped. */
    model: z.string().trim().min(1).max(120).optional(),
  })
  .optional();
export type TestAiSettingsInput = z.infer<typeof testAiSettingsSchema>;
