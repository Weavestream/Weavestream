import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { AiSettings, UpdateAiSettingsInput } from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import { IntegrationSecretEncryptionService } from '../crypto/integration-secret-encryption.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import type { RequestMeta } from '../common/request-meta.js';

const SINGLETON_ID = 'singleton';

/**
 * Conservative fallbacks used when an admin hasn't tuned the limits.
 * `maxOutputTokens` doubles as the reply budget reserved by the chat
 * prompt builder; `contextWindowTokens` sizes the prompt budget so the
 * reply fits. Picked low enough to be safe on small self-hosted models.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_768;

/**
 * Workspace-wide config for an OpenAI-compatible LLM endpoint (Ollama,
 * LMStudio, vLLM, OpenAI itself, …). Foundation only — `getConfig()`
 * exists for the connection-test endpoint and future LLM consumers, but
 * nothing in the app calls an LLM yet.
 *
 * The API key is encrypted with `IntegrationSecretEncryptionService`
 * (AES-GCM under `INTEGRATION_SECRET_KEY`) since an LLM endpoint is
 * conceptually one more integration; rotation piggybacks on the
 * integrations key. The plaintext key is never returned by `get()` —
 * clients only see the `apiKeyConfigured` boolean.
 */
@Injectable()
export class AiSettingsService {
  private static readonly CACHE_TTL_MS = 5_000;
  private cache: { value: AiSettingRow; expiresAt: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly crypto: IntegrationSecretEncryptionService,
  ) {}

  async get(): Promise<AiSettings> {
    return toDto(await this.loadOrSeed());
  }

  async update(
    actor: AuthedUser,
    input: UpdateAiSettingsInput,
    meta: RequestMeta,
  ): Promise<AiSettings> {
    const before = await this.loadOrSeed();
    const data: Record<string, unknown> = { updatedBy: actor.id };

    if (input.enabled !== undefined) data.enabled = input.enabled;
    if (input.baseUrl !== undefined) data.baseUrl = input.baseUrl;
    if (input.defaultModel !== undefined) data.defaultModel = input.defaultModel;
    if (input.clearApiKey) data.apiKeyCiphertext = null;
    if (input.apiKey !== undefined) {
      data.apiKeyCiphertext = this.crypto.encrypt(input.apiKey);
    }
    // `null` explicitly resets to the server default; `undefined` (field
    // omitted) leaves the saved value untouched.
    if (input.maxOutputTokens !== undefined) {
      data.maxOutputTokens = input.maxOutputTokens;
    }
    if (input.contextWindowTokens !== undefined) {
      data.contextWindowTokens = input.contextWindowTokens;
    }

    const after = await this.prisma.aiSetting.update({
      where: { id: SINGLETON_ID },
      data,
    });

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.settings.aiUpdate,
      entityType: 'AiSetting',
      entityId: SINGLETON_ID,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: stripForAudit(before),
      after: stripForAudit(after),
    });

    this.cache = null;
    return toDto(after);
  }

  /**
   * Returns the resolved config used by future LLM consumers. Throws
   * `AiNotConfiguredError` (a `BadRequestException`) if disabled or
   * missing a base URL.
   *
   * For the connection-test path, prefer `getRawConfig()` — it does not
   * enforce `enabled` so the user can verify a config before saving.
   */
  async getConfig(): Promise<AiResolvedConfig> {
    const row = await this.loadOrSeed();
    if (!row.enabled) throw new AiNotConfiguredError('AI integration is disabled.');
    if (!row.baseUrl) {
      throw new AiNotConfiguredError('AI base URL is required before the endpoint can be used.');
    }
    return this.decryptRow(row);
  }

  /**
   * Returns the saved config without enforcing `enabled`. Used by the
   * connection-test endpoint so a user can verify their URL/key before
   * committing them with Save. Throws only if no `baseUrl` is saved
   * (callers must supply an override in that case) or if the saved key
   * cannot be decrypted.
   */
  async getRawConfig(): Promise<AiResolvedConfig> {
    const row = await this.loadOrSeed();
    if (!row.baseUrl) {
      throw new AiNotConfiguredError('No base URL is saved. Enter one in the form to test.');
    }
    return this.decryptRow(row);
  }

  private decryptRow(row: AiSettingRow): AiResolvedConfig {
    let apiKey: string | null = null;
    if (row.apiKeyCiphertext) {
      try {
        apiKey = this.crypto.decrypt(row.apiKeyCiphertext);
      } catch {
        throw new ConflictException(
          'Stored AI API key could not be decrypted. Save the key again.',
        );
      }
    }
    const contextWindowTokens =
      row.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    const requestedOutput = row.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    // Cross-field guard, applied AFTER defaults resolve (per-field schema
    // validation can't see the resolved pair, and one side may be a
    // null→default while the other is an explicit value). The reply may
    // use at most half the context window, guaranteeing a positive prompt
    // budget and that `max_tokens` never exceeds the window — so an admin
    // who saves a tiny window (or an oversized output cap) can't collapse
    // budgeting to zero or trigger upstream rejections.
    const outputCap = Math.max(256, Math.floor(contextWindowTokens / 2));
    const maxOutputTokens = Math.min(requestedOutput, outputCap);
    return {
      baseUrl: row.baseUrl!,
      apiKey,
      defaultModel: row.defaultModel,
      maxOutputTokens,
      contextWindowTokens,
    };
  }

  private async loadOrSeed(): Promise<AiSettingRow> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.value;

    const existing = await this.prisma.aiSetting.findUnique({
      where: { id: SINGLETON_ID },
    });
    const row =
      existing ??
      (await this.prisma.aiSetting.upsert({
        where: { id: SINGLETON_ID },
        create: { id: SINGLETON_ID },
        update: {},
      }));

    this.cache = {
      value: row,
      expiresAt: now + AiSettingsService.CACHE_TTL_MS,
    };
    return row;
  }
}

export class AiNotConfiguredError extends BadRequestException {
  constructor(message: string) {
    super(message);
  }
}

export interface AiResolvedConfig {
  baseUrl: string;
  apiKey: string | null;
  defaultModel: string | null;
  /** Resolved (defaults applied) — never null. */
  maxOutputTokens: number;
  /** Resolved (defaults applied) — never null. */
  contextWindowTokens: number;
}

type AiSettingRow = {
  enabled: boolean;
  baseUrl: string | null;
  apiKeyCiphertext: string | null;
  defaultModel: string | null;
  maxOutputTokens: number | null;
  contextWindowTokens: number | null;
  updatedAt: Date;
};

function toDto(row: AiSettingRow): AiSettings {
  return {
    enabled: row.enabled,
    baseUrl: row.baseUrl,
    defaultModel: row.defaultModel,
    apiKeyConfigured: Boolean(row.apiKeyCiphertext),
    maxOutputTokens: row.maxOutputTokens,
    contextWindowTokens: row.contextWindowTokens,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function stripForAudit(row: AiSettingRow) {
  return {
    enabled: row.enabled,
    baseUrl: row.baseUrl,
    defaultModel: row.defaultModel,
    apiKeyConfigured: Boolean(row.apiKeyCiphertext),
    maxOutputTokens: row.maxOutputTokens,
    contextWindowTokens: row.contextWindowTokens,
  };
}
