import { BadRequestException, Injectable } from '@nestjs/common';
import { stripTrailingSlashes } from '@weavestream/shared';
import type { TestAiSettingsInput } from '@weavestream/shared';
import {
  AiNotConfiguredError,
  AiSettingsService,
  aiEgressOptions,
} from './ai-settings.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import type { RequestMeta } from '../common/request-meta.js';
import { EgressBlockedError, safeFetch } from '../common/egress/safe-fetch.js';
import { describeError } from '../common/describe-error.js';
import { redactUrl } from '../common/redact-url.js';
import { readUpstreamSnippet } from '../common/redact-secrets.js';

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

  async listModels(
    override?: {
      baseUrl?: string;
      apiKey?: string;
      allowPrivateNetwork?: boolean;
    },
    // Out-param so `runTest` can audit the flag that was actually applied
    // even when the call fails after resolution.
    telemetry?: { privateNetworkAllowed?: boolean },
  ): Promise<string[]> {
    let baseUrl: string;
    let apiKey: string | null = null;
    let allowPrivateNetwork: boolean;
    // Set when a saved key exists but was not sent because the test
    // targets a different endpoint; drives the 401/403 hint below.
    let savedKeyWithheld = false;

    // Test path: never enforce `enabled` — the user is verifying a
    // candidate config. Prefer override values; for any field the
    // override doesn't supply, fall back to whatever is currently saved.
    // An unsaved private-network checkbox alone must also enter this
    // branch, or Test Connection would silently ignore it.
    if (
      override?.baseUrl ||
      override?.apiKey ||
      override?.allowPrivateNetwork !== undefined
    ) {
      let savedBaseUrl: string | null = null;
      let savedApiKey: string | null = null;
      let savedAllowPrivate = false;
      try {
        const saved = await this.settings.getRawConfig();
        savedBaseUrl = saved.baseUrl;
        savedApiKey = saved.apiKey;
        savedAllowPrivate = saved.allowPrivateNetwork;
      } catch {
        // No saved baseUrl — fine, override has to carry it.
      }
      baseUrl = override.baseUrl ?? savedBaseUrl ?? '';
      // The saved key is bound to the saved endpoint. Pairing it with a
      // caller-supplied base URL would let anyone who can call this route
      // send the decrypted secret to a host of their choice, so a different
      // URL must bring its own key or go without one.
      const sameEndpoint =
        override.baseUrl === undefined ||
        (savedBaseUrl !== null &&
          stripTrailingSlashes(override.baseUrl) === stripTrailingSlashes(savedBaseUrl));
      apiKey = override.apiKey ?? (sameEndpoint ? savedApiKey : null);
      savedKeyWithheld = !override.apiKey && !sameEndpoint && savedApiKey !== null;
      allowPrivateNetwork = override.allowPrivateNetwork ?? savedAllowPrivate;
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
      allowPrivateNetwork = config.allowPrivateNetwork;
    }

    if (telemetry) telemetry.privateNetworkAllowed = allowPrivateNetwork;

    const url = `${stripTrailingSlashes(baseUrl)}/models`;
    // Admin-pasted base URLs can carry userinfo/query secrets; never echo
    // the raw form back in error messages.
    const displayUrl = redactUrl(url);

    let res: Response;
    try {
      res = await safeFetch(url, {
        method: 'GET',
        headers: modelListHeaders(baseUrl, apiKey),
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
    const telemetry: { privateNetworkAllowed?: boolean } = {};
    try {
      const models = await this.listModels(input ?? undefined, telemetry);
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
          // Null when the test failed before the flag was even resolved
          // (e.g. no base URL saved or supplied).
          privateNetworkAllowed: telemetry.privateNetworkAllowed ?? null,
          overrideUsed: Boolean(
            input?.baseUrl ||
              input?.apiKey ||
              input?.allowPrivateNetwork !== undefined,
          ),
        },
      });
    }
  }

}

/**
 * Auth headers for `GET {baseUrl}/models`. Anthropic's OpenAI-compatible
 * surface accepts `Authorization: Bearer` for chat completions, but its
 * `/v1/models` is the native endpoint: it requires `x-api-key` plus an
 * `anthropic-version` header and 400s without them. Its response already
 * has the OpenAI `{ data: [{ id }] }` shape, so only the headers differ.
 */
export function modelListHeaders(
  baseUrl: string,
  apiKey: string | null | undefined,
): Record<string, string> | undefined {
  if (!apiKey) return undefined;
  let host = '';
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    // Fall through to the OpenAI default; safeFetch reports the bad URL.
  }
  if (host === 'api.anthropic.com') {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  }
  return { Authorization: `Bearer ${apiKey}` };
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

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Unknown error';
}
