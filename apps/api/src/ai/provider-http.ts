import type { AiProvider, AiReasoningEffort } from '@weavestream/shared';
import type { AiResolvedConfig } from './ai-settings.service.js';

/**
 * Provider rules for every AI request, in one place: auth headers,
 * request-parameter names, reasoning settings and output budgets. Used by
 * the chat stream, `AiCompletionService` and the connection test.
 *
 * The model tables are deliberately small and explicit. A model they do
 * not know gets NO reasoning parameter (the provider default), never a
 * guess, and the chat stream's one-time retries cover a newer family that
 * rejects `temperature` or a forced `tool_choice`.
 */

/**
 * `anthropic-version` header for Anthropic's native endpoints.
 * `2023-06-01` is accepted everywhere, gateways included. Requests never
 * send `temperature` / `top_p` / `top_k`, documents in assistant turns
 * or user-side citations, so moving to `2026-10-21` is this one line.
 */
export const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Auth headers. Provider `anthropic` uses the native Messages API for
 * every call (`/models`, `/messages`): `x-api-key` + `anthropic-version`,
 * plus `anthropic-workspace-id` when set. Everything else: Bearer.
 */
export function providerAuthHeaders(
  config: Pick<AiResolvedConfig, 'provider' | 'apiKey' | 'anthropicWorkspaceId'>,
): Record<string, string> {
  const { provider, apiKey } = config;
  if (provider !== 'anthropic') {
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  }
  return {
    ...(apiKey ? { 'x-api-key': apiKey } : {}),
    'anthropic-version': ANTHROPIC_VERSION,
    // Pattern-checked at save time (shared schema + DB CHECK), so it is
    // safe as a header value.
    ...(config.anthropicWorkspaceId
      ? { 'anthropic-workspace-id': config.anthropicWorkspaceId }
      : {}),
  };
}

/** Model id without a router prefix (`openai/gpt-5` → `gpt-5`), lowercased. */
function bareId(model: string): string {
  return model.slice(model.lastIndexOf('/') + 1).toLowerCase();
}

/**
 * Output-token field name. OpenAI's own endpoint accepts
 * `max_completion_tokens` on every model; elsewhere only the gpt-5 family
 * needs it.
 */
export function outputTokenParam(
  model: string | null,
  budget: number,
  provider?: AiProvider,
): { max_completion_tokens: number } | { max_tokens: number } {
  return provider === 'openai' || (model && /^gpt-5/i.test(model))
    ? { max_completion_tokens: budget }
    : { max_tokens: budget };
}

/**
 * Models that reject a caller-supplied `temperature` with a 400, so the
 * field must be left out:
 *   - Claude 4.7 and later, and Claude Mythos Preview, on Anthropic's
 *     OpenAI-compatible endpoint (any value below 1);
 *   - OpenAI's gpt-5 family and o-series reasoning models (any
 *     non-default value).
 * A router prefix (`anthropic/…`, `openai/…`) is ignored. A family this
 * list does not know yet is caught by the chat stream's one retry
 * without `temperature`.
 */
export function rejectsTemperature(model: string): boolean {
  const id = bareId(model);
  if (/^(?:gpt-5|o[134](?:-|$))/.test(id)) return true;
  if (id === 'claude-mythos-preview') return true;
  const v = claudeVersion(id);
  if (!v) return false;
  return v.major > 4 || (v.major === 4 && v.minor >= 7);
}

export function temperatureParam(
  model: string | null,
  temperature: number,
): { temperature: number } | Record<string, never> {
  return model && rejectsTemperature(model) ? {} : { temperature };
}

/**
 * `claude-<family>-<major>[-<minor>]`. A 3+ digit "minor" is a date
 * snapshot (`claude-sonnet-4-20250514` is Sonnet 4.0), not a version.
 */
function claudeVersion(
  id: string,
): { family: string; major: number; minor: number } | null {
  const v = /^claude-([a-z]+)-(\d+)(?:[-.](\d{1,2})(?!\d))?/.exec(id);
  if (!v) return null;
  return { family: v[1]!, major: Number(v[2]), minor: v[3] ? Number(v[3]) : 0 };
}

/**
 * How a Claude model takes reasoning settings on the native Messages API
 * (see the `claude-api` thinking table):
 *   budget      Haiku 4.5, Sonnet 4.5, Opus 4.5 and older 4.x — `thinking:
 *               {type:'enabled', budget_tokens}`; no `effort` (Haiku and
 *               Sonnet 4.5 reject it).
 *   optin       Opus 4.6/4.7/4.8, Sonnet 4.6 — no thinking unless asked;
 *               adaptive + `effort`.
 *   disableable Opus 5, Sonnet 5, Haiku 5.5 — on by default; `disabled`
 *               is accepted at the default effort.
 *   always      Opus 5.5, Sonnet 5.5, Fable 5/5.1, Mythos — thinking can't
 *               be turned off; `effort` is the only control.
 */
export type ClaudeReasoningTier = 'budget' | 'optin' | 'disableable' | 'always';

export function claudeReasoningTier(model: string): ClaudeReasoningTier | null {
  const id = bareId(model);
  if (id === 'claude-mythos-preview') return 'always';
  const v = claudeVersion(id);
  if (!v) return null;
  if (v.family === 'fable' || v.family === 'mythos') return 'always';
  if (v.major === 4) return v.minor >= 6 ? 'optin' : 'budget';
  if (v.major === 5) {
    if (v.family === 'opus' || v.family === 'sonnet') {
      return v.minor >= 5 ? 'always' : 'disableable';
    }
    if (v.family === 'haiku') return 'disableable';
  }
  return null; // unknown family or a future major
}

/**
 * Claude models that reject a forced `tool_choice` (`tool` or `any`) with
 * a 400: Fable 5.1, Mythos 5.1, Opus 5.5 and Sonnet 5.5. Fable 5 and
 * Opus 5 still accept it. A later family is caught by the chat stream's
 * one-time retry with `auto`.
 */
export function rejectsForcedToolChoice(model: string): boolean {
  const v = claudeVersion(bareId(model));
  if (!v || v.major !== 5) return false;
  if (v.family === 'fable' || v.family === 'mythos') return v.minor >= 1;
  if (v.family === 'opus' || v.family === 'sonnet') return v.minor >= 5;
  return false;
}

/**
 * Claude models that accept `strict: true` on a tool definition (the
 * `claude-api` structured-outputs list). Elsewhere the flag is left out.
 */
export function supportsStrictTools(model: string): boolean {
  const id = bareId(model);
  const v = claudeVersion(id);
  if (!v) return false;
  if (v.family === 'fable' || v.family === 'mythos') return v.major === 5;
  if (v.major === 5) return ['opus', 'sonnet', 'haiku'].includes(v.family);
  if (v.major !== 4) return false;
  if (v.family === 'haiku') return v.minor === 5;
  if (v.family === 'opus') return v.minor === 1 || v.minor === 5 || v.minor === 8;
  return false;
}

/** OpenAI families that take `reasoning_effort`, and their "off" value. */
function openAiReasoningOff(model: string): 'minimal' | 'none' | 'low' | null {
  const id = bareId(model);
  if (/-chat/.test(id)) return null; // gpt-5-chat-latest: not a reasoning model
  const gpt5 = /^gpt-5(?:\.(\d+))?(?![\d])/.exec(id);
  if (gpt5) return gpt5[1] && Number(gpt5[1]) >= 1 ? 'none' : 'minimal';
  // o1-mini / o1-preview never took `reasoning_effort`.
  if (/^o1-(?:mini|preview)/.test(id)) return null;
  if (/^o[134](?:-|$)/.test(id)) return 'low';
  return null;
}

/**
 * Body fragment for a reasoning setting. `default` sends nothing (the
 * provider's own default). `purpose: 'background'` (titles, the prelude,
 * summaries, the connection probe) always uses the lowest supported
 * setting. `maxTokens` keeps a Claude thinking budget below the
 * output cap.
 */
export function reasoningParams(opts: {
  provider: AiProvider;
  model: string | null;
  setting: AiReasoningEffort;
  purpose: 'chat' | 'background';
  maxTokens: number;
}): Record<string, unknown> {
  const setting = opts.purpose === 'background' ? 'off' : opts.setting;
  // The provider's own default: no reasoning parameter at all.
  if (setting === 'default') return {};
  const model = opts.model;
  if (opts.provider === 'openai_compatible') {
    // Pre-provider behavior, unchanged: vLLM / LM Studio / SGLang flags
    // to disable reasoning-mode emission; servers that don't recognise
    // a flag ignore it, and OpenRouter honours `reasoning.effort`.
    return setting === 'off'
      ? {
          enable_thinking: false,
          chat_template_kwargs: { enable_thinking: false },
          reasoning: { effort: 'none' },
        }
      : {};
  }
  if (!model) return {};
  if (opts.provider === 'openai') {
    const off = openAiReasoningOff(model);
    if (!off) return {};
    if (setting !== 'off') return { reasoning_effort: setting };
    return { reasoning_effort: off };
  }
  // anthropic — the native Messages API shape.
  const tier = claudeReasoningTier(model);
  if (!tier) return {};
  const effort = (e: Exclude<AiReasoningEffort, 'default'>) => ({
    output_config: { effort: e },
  });
  switch (tier) {
    case 'budget': {
      if (setting === 'off') return {};
      const wanted = { low: 1_024, medium: 4_096, high: 8_192 }[setting];
      const budget = Math.min(wanted, opts.maxTokens - 1);
      return budget >= 1_024
        ? { thinking: { type: 'enabled', budget_tokens: budget } }
        : {};
    }
    case 'optin':
      return setting === 'off'
        ? {}
        : { thinking: { type: 'adaptive' }, ...effort(setting) };
    case 'disableable':
      return setting === 'off'
        ? { thinking: { type: 'disabled' } }
        : { thinking: { type: 'adaptive' }, ...effort(setting) };
    case 'always':
      return effort(setting === 'off' ? 'low' : setting);
  }
}

/**
 * Whether a model still spends output tokens on reasoning at its lowest
 * setting, so a short background call needs headroom before visible text.
 */
export function thinksAtLowest(provider: AiProvider, model: string | null): boolean {
  if (!model || provider === 'openai_compatible') return false;
  if (provider === 'openai') {
    const off = openAiReasoningOff(model);
    if (off === 'minimal' || off === 'low') return true;
    // A future gpt-N gets no reasoning parameter, so assume it reasons.
    return off === null && /^gpt-(?:[6-9]|\d{2,})/.test(bareId(model));
  }
  const tier = claudeReasoningTier(model);
  return tier === 'always' || tier === null;
}

/** Extra output tokens for a background call on a model that always reasons. */
export const BACKGROUND_REASONING_HEADROOM = 2_048;

/**
 * Output budget for a short background call: the visible budget, plus
 * reasoning headroom where the model always thinks, capped at half the
 * context window (the same cap as `maxOutputTokens`).
 */
export function backgroundOutputBudget(opts: {
  provider: AiProvider;
  model: string | null;
  visible: number;
  contextWindowTokens: number;
}): number {
  const headroom = thinksAtLowest(opts.provider, opts.model)
    ? BACKGROUND_REASONING_HEADROOM
    : 0;
  return Math.min(
    opts.visible + headroom,
    Math.floor(opts.contextWindowTokens / 2),
  );
}
