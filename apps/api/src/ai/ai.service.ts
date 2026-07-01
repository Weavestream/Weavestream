import { BadRequestException, Injectable } from '@nestjs/common';
import type { TestAiSettingsInput } from '@weavestream/shared';
import { AiNotConfiguredError, AiSettingsService } from './ai-settings.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import type { RequestMeta } from '../common/request-meta.js';
import { EgressBlockedError, safeFetch } from '../common/egress/safe-fetch.js';
import { describeError } from '../common/describe-error.js';

const TEST_TIMEOUT_MS = 8_000;

/**
 * Thin client for OpenAI-compatible endpoints. Foundation phase only
 * exposes `listModels()` — used by the settings page's "Test connection"
 * button to verify the saved base URL + API key and surface the
 * server's model list. The full chat/completion/embedding surface lands
 * in a follow-up phase.
 */
@Injectable()
export class AiService {
  constructor(
    private readonly settings: AiSettingsService,
    private readonly audit: AuditLogService,
  ) {}

  async listModels(override?: { baseUrl?: string; apiKey?: string }): Promise<string[]> {
    let baseUrl: string;
    let apiKey: string | null = null;

    // Test path: never enforce `enabled` — the user is verifying a
    // candidate config. Prefer override values; for any field the
    // override doesn't supply, fall back to whatever is currently saved.
    if (override?.baseUrl || override?.apiKey) {
      let savedBaseUrl: string | null = null;
      let savedApiKey: string | null = null;
      try {
        const saved = await this.settings.getRawConfig();
        savedBaseUrl = saved.baseUrl;
        savedApiKey = saved.apiKey;
      } catch {
        // No saved baseUrl — fine, override has to carry it.
      }
      baseUrl = override.baseUrl ?? savedBaseUrl ?? '';
      apiKey = override.apiKey ?? savedApiKey;
      if (!baseUrl) {
        throw new BadRequestException('Enter a base URL to test the connection.');
      }
    } else {
      // No override at all: tester wants to verify the persisted config
      // as-is, including the `enabled` gate (treat it as a "would this
      // be usable right now?" check).
      const config = await this.settings.getConfig();
      baseUrl = config.baseUrl;
      apiKey = config.apiKey;
    }

    const url = `${stripTrailingSlash(baseUrl)}/models`;

    let res: Response;
    try {
      res = await safeFetch(url, {
        method: 'GET',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
        timeoutMs: TEST_TIMEOUT_MS,
        // The baseUrl is admin-pasted in Settings → AI, so we treat it
        // as authorised even when it points at a private/LAN address
        // (LM Studio, on-prem Ollama, etc.). The SSRF guard still
        // applies its timeout, body cap, and protocol/URL validation.
        allowPrivateNetworks: true,
      });
    } catch (err) {
      if (err instanceof EgressBlockedError) {
        throw new BadRequestException(
          `The configured AI endpoint is not allowed: ${err.reason}.`,
        );
      }
      // undici throws a bare `TypeError: fetch failed` and stashes the
      // real reason (ECONNREFUSED, connect timeout, proxy/TLS errors, …)
      // on `err.cause`. `describeError` walks that chain so the admin
      // sees why, not just "fetch failed". Admin-only surface; secrets in
      // any embedded URL are redacted by the helper.
      throw new BadRequestException(
        `Could not reach ${url}: ${describeError(err)}`,
      );
    }

    if (!res.ok) {
      const body = await safeText(res);
      throw new BadRequestException(
        `${url} returned ${res.status}${body ? ` — ${body}` : ''}`,
      );
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw new BadRequestException(`Response was not valid JSON: ${messageOf(err)}`);
    }

    const models = extractModelIds(json);
    if (models.length === 0) {
      throw new BadRequestException(
        'Endpoint responded, but no models were listed. Confirm the server has at least one model loaded.',
      );
    }
    return models;
  }

  async runTest(
    actor: AuthedUser,
    meta: RequestMeta,
    input?: TestAiSettingsInput,
  ): Promise<{ ok: true; models: string[] }> {
    let success = false;
    let error: string | null = null;
    let modelCount = 0;
    try {
      const models = await this.listModels(input ?? undefined);
      success = true;
      modelCount = models.length;
      return { ok: true, models };
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
          overrideUsed: Boolean(input?.baseUrl),
        },
      });
    }
  }

}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function extractModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const entry of data) {
    if (entry && typeof entry === 'object') {
      const id = (entry as { id?: unknown }).id;
      if (typeof id === 'string' && id.length > 0) ids.push(id);
    }
  }
  return ids;
}

async function safeText(res: Response): Promise<string | null> {
  try {
    const text = (await res.text()).trim();
    if (!text) return null;
    return text.length > 240 ? `${text.slice(0, 240)}…` : text;
  } catch {
    return null;
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Unknown error';
}
