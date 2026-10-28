import { BadRequestException, Injectable } from '@nestjs/common';
import { stripTrailingSlashes } from '@weavestream/shared';
import type {
  AiProbeResult,
  AiProvider,
  AiTestResult,
  TestAiSettingsInput,
} from '@weavestream/shared';
import {
  AiNotConfiguredError,
  AiSettingsService,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  aiEgressOptions,
  type AiResolvedConfig,
} from './ai-settings.service.js';
import {
  AiCompletionHttpError,
  AiCompletionRefusedError,
  AiCompletionService,
  AiCompletionTruncatedError,
  describeCompletionHttpError,
} from './ai-completion.service.js';
import { backgroundOutputBudget, providerAuthHeaders } from './provider-http.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import type { RequestMeta } from '../common/request-meta.js';
import { EgressBlockedError, safeFetch } from '../common/egress/safe-fetch.js';
import { describeError } from '../common/describe-error.js';
import { redactUrl } from '../common/redact-url.js';
import { readUpstreamSnippet } from '../common/redact-secrets.js';

const TEST_TIMEOUT_MS = 8_000;
/** The reply check runs after a successful model list, with its own cap. */
const PROBE_TIMEOUT_MS = 15_000;
/** Visible budget for "OK"; reasoning models get headroom on top. */
const PROBE_VISIBLE_TOKENS = 32;

/**
 * OpenAI's `/models` also lists models that cannot chat. Applied only to
 * the `openai` provider; local servers list exactly what they serve.
 */
const OPENAI_NON_CHAT_MODEL =
  /(embedding|tts|whisper|dall-e|gpt-image|audio|realtime|transcribe|moderation|search|computer-use)/i;

/** The endpoint, key and options one connection test uses. */
interface TestTarget {
  provider: AiProvider;
  baseUrl: string;
  apiKey: string | null;
  anthropicWorkspaceId: string | null;
  allowPrivateNetwork: boolean;
  contextWindowTokens: number;
  /** A saved key exists but was not sent: the test targets another endpoint. */
  savedKeyWithheld: boolean;
}

/**
 * "Test connection" for Settings → AI: lists the endpoint's models and,
 * when a model is selected, checks that it gives a usable reply.
 */
@Injectable()
export class AiService {
  constructor(
    private readonly settings: AiSettingsService,
    private readonly audit: AuditLogService,
    private readonly completion: AiCompletionService,
  ) {}

  /**
   * Resolves what a test sends where. Test path: never enforce
   * `enabled` — the user is verifying a candidate config. Override
   * values win; any field the override doesn't supply falls back to the
   * saved config. Without any override the persisted config is tested
   * as-is, including the `enabled` gate.
   */
  private async resolveTarget(override?: TestAiSettingsInput): Promise<TestTarget> {
    if (
      override?.baseUrl ||
      override?.apiKey ||
      override?.allowPrivateNetwork !== undefined ||
      override?.provider ||
      override?.anthropicWorkspaceId
    ) {
      let saved: AiResolvedConfig | null = null;
      try {
        saved = await this.settings.getRawConfig();
      } catch {
        // No saved baseUrl — fine, the override has to carry it.
      }
      const baseUrl = override.baseUrl ?? saved?.baseUrl ?? '';
      if (!baseUrl) {
        throw new BadRequestException('Enter a base URL to test the connection.');
      }
      // The saved key is bound to the saved endpoint. Pairing it with a
      // caller-supplied base URL would let anyone who can call this route
      // send the decrypted secret to a host of their choice, so a different
      // URL must bring its own key or go without one. This applies to the
      // model list AND the reply check, which share this target.
      const savedApiKey = saved?.apiKey ?? null;
      const sameEndpoint =
        override.baseUrl === undefined ||
        (saved !== null &&
          stripTrailingSlashes(override.baseUrl) === stripTrailingSlashes(saved.baseUrl));
      return {
        provider: override.provider ?? saved?.provider ?? 'openai_compatible',
        baseUrl,
        apiKey: override.apiKey ?? (sameEndpoint ? savedApiKey : null),
        anthropicWorkspaceId:
          override.anthropicWorkspaceId ?? saved?.anthropicWorkspaceId ?? null,
        allowPrivateNetwork:
          override.allowPrivateNetwork ?? saved?.allowPrivateNetwork ?? false,
        contextWindowTokens: saved?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
        savedKeyWithheld: !override.apiKey && !sameEndpoint && savedApiKey !== null,
      };
    }
    const config = await this.settings.getConfig();
    return { ...config, savedKeyWithheld: false };
  }

  async listModels(
    override?: TestAiSettingsInput,
    // Out-param so `runTest` can audit the flag that was actually applied
    // even when the call fails after resolution.
    telemetry?: { privateNetworkAllowed?: boolean },
  ): Promise<AiModelEntry[]> {
    const target = await this.resolveTarget(override);
    if (telemetry) telemetry.privateNetworkAllowed = target.allowPrivateNetwork;
    return this.fetchModels(target);
  }

  private async fetchModels(target: TestTarget): Promise<AiModelEntry[]> {
    const { baseUrl, allowPrivateNetwork, savedKeyWithheld } = target;
    const url = `${stripTrailingSlashes(baseUrl)}/models`;
    // Admin-pasted base URLs can carry userinfo/query secrets; never echo
    // the raw form back in error messages.
    const displayUrl = redactUrl(url);

    let res: Response;
    try {
      res = await safeFetch(url, {
        method: 'GET',
        // Anthropic's `/v1/models` is the native endpoint: `x-api-key` +
        // `anthropic-version`, and it 400s on Bearer alone.
        headers: providerAuthHeaders(target),
        timeoutMs: TEST_TIMEOUT_MS,
        // Private/LAN endpoints (LM Studio, on-prem Ollama, …) require the
        // explicit Settings → AI opt-in, which allows only the curated
        // `ADMIN_PRIVATE_ENDPOINT_CIDRS` — cloud-metadata and link-local
        // stay blocked, and DNS-rebinding pinning stays active (WS-017).
        ...aiEgressOptions({ allowPrivateNetwork }),
      });
    } catch (err) {
      if (err instanceof EgressBlockedError) {
        throw new BadRequestException(
          `The configured AI endpoint is not allowed: ${err.reason}. ` +
            'If your LLM runs on a private network, enable "Allow private-network addresses" in Settings → AI.',
        );
      }
      // undici throws a bare `TypeError: fetch failed` and stashes the
      // real reason (ECONNREFUSED, connect timeout, proxy/TLS errors, …)
      // on `err.cause`. `describeError` walks that chain so the admin
      // sees why, not just "fetch failed". Admin-only surface; secrets in
      // any embedded URL are redacted by the helper.
      throw new BadRequestException(
        `Could not reach ${displayUrl}: ${describeError(err)}`,
      );
    }

    if (!res.ok) {
      const body = await readUpstreamSnippet(res);
      const hint =
        savedKeyWithheld && (res.status === 401 || res.status === 403)
          ? '. The saved API key is only sent to the saved base URL; enter the API key to test a different URL.'
          : '';
      throw new BadRequestException(
        `${displayUrl} returned ${res.status}${body ? ` — ${body}` : ''}${hint}`,
      );
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw new BadRequestException(`Response was not valid JSON: ${messageOf(err)}`);
    }

    const models = extractModels(json, target.provider);
    if (models.length === 0) {
      throw new BadRequestException(
        'Endpoint responded, but no models were listed. Confirm the server has at least one model loaded.',
      );
    }
    return models;
  }

  /**
   * One short prompt through the same transport the chat uses. OK only
   * with non-empty visible text. Every failure maps to a fixed code —
   * nothing from the probe escapes, so a failed check never hides a
   * successful model list.
   */
  private async probe(target: TestTarget, model: string | undefined): Promise<AiProbeResult> {
    if (!model) return { status: 'skipped', reason: 'no-model' };
    try {
      const reply = await this.completion.complete(target, {
        model,
        system: 'You confirm that the connection works.',
        user: 'Reply with the word OK.',
        maxOutputTokens: backgroundOutputBudget({
          provider: target.provider,
          model,
          visible: PROBE_VISIBLE_TOKENS,
          contextWindowTokens: target.contextWindowTokens,
        }),
        timeoutMs: PROBE_TIMEOUT_MS,
        contentOnly: true,
      });
      return reply ? { status: 'ok' } : { status: 'failed', reason: 'empty' };
    } catch (err) {
      return { status: 'failed', reason: probeFailureCode(err) };
    }
  }

  async runTest(
    actor: AuthedUser,
    meta: RequestMeta,
    input?: TestAiSettingsInput,
  ): Promise<AiTestResult> {
    let success = false;
    let error: string | null = null;
    let modelCount = 0;
    let probe: AiProbeResult | null = null;
    let privateNetworkAllowed: boolean | null = null;
    try {
      const target = await this.resolveTarget(input ?? undefined);
      privateNetworkAllowed = target.allowPrivateNetwork;
      const models = await this.fetchModels(target);
      success = true;
      modelCount = models.length;
      probe = await this.probe(target, input?.model);
      return { ok: true, models, probe };
    } catch (err) {
      // Capture the full cause chain in the durable audit record too, so
      // a failed test is diagnosable after the fact.
      error = describeError(err);
      if (err instanceof AiNotConfiguredError) throw err;
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(`AI connection test failed: ${error}`);
    } finally {
      await this.audit.log({
        actorId: actor.id,
        action: AUDIT_ACTIONS.settings.aiTest,
        entityType: 'AiSetting',
        entityId: 'singleton',
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: {
          success,
          modelCount,
          error,
          // Status and fixed code only — never the reply text.
          probe,
          // Null when the test failed before the flag was even resolved
          // (e.g. no base URL saved or supplied).
          privateNetworkAllowed,
          overrideUsed: Boolean(
            input?.baseUrl ||
              input?.apiKey ||
              input?.allowPrivateNetwork !== undefined ||
              input?.provider ||
              input?.anthropicWorkspaceId,
          ),
        },
      });
    }
  }
}

export type AiModelEntry = AiTestResult['models'][number];

/**
 * `{ data: [{ id, display_name? }] }` — the OpenAI shape, which
 * Anthropic's native list shares (plus `display_name`).
 */
function extractModels(payload: unknown, provider: AiProvider): AiModelEntry[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const models: AiModelEntry[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, display_name: label } = entry as { id?: unknown; display_name?: unknown };
    if (typeof id !== 'string' || id.length === 0) continue;
    if (provider === 'openai' && OPENAI_NON_CHAT_MODEL.test(id)) continue;
    models.push(
      provider === 'anthropic' && typeof label === 'string' && label.trim()
        ? { id, label: label.trim().slice(0, 120) }
        : { id },
    );
  }
  return models;
}

/** Fixed code for a failed reply check. Never upstream text. */
function probeFailureCode(err: unknown): string {
  if (err instanceof AiCompletionRefusedError) return 'refused';
  if (err instanceof AiCompletionTruncatedError) return 'truncated';
  if (err instanceof AiCompletionHttpError) {
    return `http:${describeCompletionHttpError(err)}`.slice(0, 80);
  }
  // By name, not `instanceof`: `res.json()` and the abort/timeout
  // DOMExceptions can come from another realm than this module's globals.
  const { name, message } = (err ?? {}) as { name?: unknown; message?: unknown };
  if (name === 'SyntaxError') return 'invalid-response';
  if (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    (typeof message === 'string' && /timeout|timed out/i.test(message))
  ) {
    return 'timeout';
  }
  return 'transport';
}

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Unknown error';
}
