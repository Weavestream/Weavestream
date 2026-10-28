import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  excerptFromPlaintext,
  markdownToPlaintext,
  stripTrailingSlashes,
} from '@weavestream/shared';
import { safeFetch } from '../common/egress/safe-fetch.js';
import { redactSecretsInText } from '../common/redact-secrets.js';
import {
  aiEgressOptions,
  type AiResolvedConfig,
} from './ai-settings.service.js';
import { fromAnthropicMessage } from './anthropic-messages.js';
import {
  outputTokenParam,
  providerAuthHeaders,
  reasoningParams,
  temperatureParam,
} from './provider-http.js';

/**
 * One-shot, non-streaming completions against the configured
 * OpenAI-compatible endpoint (Phase 4). Lifted from
 * `ChatStreamService.generateTitle`, which pioneered every quirk this
 * encodes: reasoning-mode suppression flags, the `<think>` scratchpad
 * strip, and the content/reasoning_content/reasoning response-shape
 * fallbacks across vLLM / LM Studio / SGLang / OpenRouter.
 *
 * Error contract, chosen for BullMQ consumers:
 *   - THROWS on transport failures and non-2xx responses
 *     (`AiCompletionHttpError`) — retryable conditions the queue's
 *     attempt/backoff policy owns.
 *   - RETURNS NULL on a well-formed response with no usable content —
 *     retrying would spend tokens on the same nothing.
 *
 * `ChatStreamService.generateTitle` and `generateToolIntentPrelude`
 * now consume `complete()` as well (they catch and map every failure
 * to null rather than letting BullMQ semantics leak into a chat turn);
 * only the flagship chat *stream* still owns its own fetch.
 */

// Provider rules moved to `provider-http.ts`; re-exported for existing
// importers (the worker reaches them through `public/ai.ts`).
export {
  outputTokenParam,
  rejectsTemperature,
  temperatureParam,
} from './provider-http.js';

/**
 * Drop a reasoning model's `<think>…</think>` scratchpad. Some servers
 * leak it into `content` even with every suppression flag set.
 *
 * Same result as `replace(/<think>[\s\S]*?<\/think>/gi, '')` — each
 * `<think>` pairs with the first `</think>` after it, an unclosed
 * `<think>` is kept — but in one linear pass over the tags. That regex
 * is quadratic on model output holding many `<think>` and no close
 * (CodeQL js/polynomial-redos): every `<think>` start rescans to the end.
 */
export function stripThinkTags(raw: string): string {
  let out = '';
  let kept = 0; // start of the text not yet copied to `out`
  let open = -1; // index of the pending `<think>`, -1 when none
  for (const tag of raw.matchAll(/<(\/?)think>/gi)) {
    if (!tag[1]) {
      if (open < 0) open = tag.index;
    } else if (open >= 0) {
      out += raw.slice(kept, open);
      kept = tag.index + tag[0].length;
      open = -1;
    }
  }
  return (out + raw.slice(kept)).trim();
}

/**
 * The visible answer in a `content` field: closed `<think>` blocks
 * removed, and everything from an unclosed `<think>` on removed too (a
 * reply cut off inside its scratchpad). Empty when nothing is left.
 */
export function visibleText(content: string): string {
  const stripped = stripThinkTags(content);
  const open = stripped.toLowerCase().indexOf('<think>');
  return (open >= 0 ? stripped.slice(0, open) : stripped).trim();
}

/**
 * Model output is untrusted input (CLAUDE.md §7). Reduce a raw
 * completion to a bounded plain-text summary: think-strip → flatten any
 * markdown the model emitted → drop control characters → collapse
 * whitespace → cap at the shared 280-char excerpt budget (word-boundary
 * + ellipsis). Returns null when nothing survives — callers fall back
 * to the derived excerpt.
 */
export function sanitizeAiSummary(raw: string): string | null {
  const noThink = stripThinkTags(raw);
  const flattened = markdownToPlaintext(noThink);
  const clean = flattened
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return null;
  return excerptFromPlaintext(clean, 280);
}

/**
 * The model used its whole output budget without visible text (typically
 * on reasoning). Not retried here: the caller decides whether a larger
 * budget fits its context window.
 */
export class AiCompletionTruncatedError extends Error {
  constructor() {
    super('AI completion ran out of output tokens before any visible text');
  }
}

/** The provider declined the request (refusal / content filter). Not retryable. */
export class AiCompletionRefusedError extends Error {
  constructor() {
    super('AI completion was declined by the provider');
  }
}

/** Non-2xx from the completion endpoint. Retryable via BullMQ unless a caller downgrades it. */
export class AiCompletionHttpError extends Error {
  constructor(
    readonly status: number,
    /**
     * First bytes of the provider's error body, secret-redacted at
     * capture. For programmatic classification (`isContextLengthError`,
     * `describeCompletionHttpError`) — NEVER for log lines: it is
     * arbitrary upstream text that can echo the prompt (and therefore
     * article/chat content) back at us.
     */
    readonly bodySnippet: string,
  ) {
    super(`AI completion endpoint returned ${status}`);
  }
}

/**
 * Best-effort classification of "your prompt exceeded the model
 * context" rejections across providers (OpenAI, vLLM, Ollama, LM
 * Studio phrase it differently, all as 4xx). Used by the summary
 * worker's halve-and-retry-once path.
 */
export function isContextLengthError(err: unknown): boolean {
  if (!(err instanceof AiCompletionHttpError)) return false;
  if (err.status < 400 || err.status >= 500) return false;
  return /context|maximum.{0,20}(length|tokens)|too many tokens|token limit|prompt.{0,20}too long/i.test(
    err.bodySnippet,
  );
}

/**
 * The complete set of top-level request parameters `complete()` can
 * send. `describeCompletionHttpError` only ever echoes a parameter
 * name from THIS set into its output — a rejected-parameter log line
 * is therefore always one of our own hardcoded strings, never a
 * capture from the provider body.
 */
const SENT_REQUEST_PARAMS: ReadonlySet<string> = new Set([
  'model',
  'stream',
  'temperature',
  'enable_thinking',
  'chat_template_kwargs',
  'reasoning',
  'reasoning_effort',
  'messages',
  'max_tokens',
  'max_completion_tokens',
  // Native Anthropic Messages fields.
  'system',
  'thinking',
  'output_config',
]);

/**
 * Bounded, content-free description of a completion HTTP failure for
 * log lines. §6 discipline: the provider's error body is arbitrary
 * upstream text that can echo prompts (and therefore article or chat
 * content) — logs get a classification, never the body. Recognized
 * shapes name the culprit (the parameter naming is what made the
 * strict-endpoint `enable_thinking` rejection diagnosable), and the
 * name is emitted only when it matches `SENT_REQUEST_PARAMS`; anything
 * else logs the status plus a fingerprint that can be correlated with
 * provider-side logs without reproducing a byte of the text.
 */
export function describeCompletionHttpError(err: AiCompletionHttpError): string {
  const body = err.bodySnippet;
  if (isContextLengthError(err)) return `${err.status} context-length`;
  const captured = /(?:unknown|unrecognized|unsupported)\s+(?:request\s+)?(?:argument|parameter|value)[^:'"]*[:'"]\s*'?([A-Za-z0-9_.[\]-]{1,40})/i.exec(
    body,
  )?.[1];
  if (captured) {
    // Providers may complain about a nested path ('reasoning.effort',
    // 'messages[0].role') — classify by the root segment, and emit the
    // allowlisted root, never the capture itself.
    const root = captured.split(/[.[]/, 1)[0]!.toLowerCase();
    if (SENT_REQUEST_PARAMS.has(root)) {
      return `${err.status} rejected-parameter '${root}'`;
    }
  }
  if (err.status === 401 || err.status === 403) return `${err.status} auth`;
  if (err.status === 404) return `${err.status} not-found`;
  if (err.status === 429 || /rate.?limit|quota/i.test(body)) {
    return `${err.status} rate-limit-or-quota`;
  }
  if (/temperature/i.test(body)) return `${err.status} temperature-rejected`;
  if (/model/i.test(body)) return `${err.status} model-rejected`;
  const fp = createHash('sha256').update(body).digest('hex').slice(0, 12);
  return `${err.status} unclassified (${body.length} chars, sha256:${fp})`;
}

/** The config fields a completion needs. */
export type CompletionConfig = Pick<
  AiResolvedConfig,
  'provider' | 'baseUrl' | 'apiKey' | 'anthropicWorkspaceId' | 'allowPrivateNetwork'
>;

/**
 * Every caller is a short background task (title, prelude, summary,
 * connection probe), so reasoning always uses the model's lowest
 * supported setting (`reasoningParams`, purpose 'background').
 */
export interface CompleteOptions {
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  temperature?: number;
  timeoutMs: number;
  /**
   * External cancellation (e.g. the chat turn's client-disconnect
   * signal), chained into each request's own timeout controller. An
   * abort surfaces as the fetch's AbortError, never as an
   * `AiCompletionHttpError` — so it also never triggers the
   * strict-endpoint retry below.
   */
  signal?: AbortSignal;
  /**
   * Accept only `message.content`; never fall back to the
   * reasoning_content/reasoning response shapes. For output rendered
   * to users verbatim (the tool-intent prelude), where salvaging from
   * a reasoning field would surface chain-of-thought as the reply.
   */
  contentOnly?: boolean;
}

@Injectable()
export class AiCompletionService {
  async complete(
    config: CompletionConfig,
    opts: CompleteOptions,
  ): Promise<string | null> {
    // The native Messages API has no local-server flags to strip, so the
    // strict-endpoint retry below does not apply.
    if (config.provider === 'anthropic') return this.requestAnthropic(config, opts);
    try {
      return await this.request(config, opts, 'full');
    } catch (err) {
      // Strict-endpoint fallback. Real OpenAI 400s on request arguments
      // it doesn't recognise (`enable_thinking`, `chat_template_kwargs`,
      // `reasoning` are local-server conventions), and the gpt-5 family
      // additionally rejects any non-default `temperature`. Local
      // servers just ignore extras, which is why the pre-migration
      // `generateTitle` never surfaced this — its failures fell back
      // silently. One retry with
      // a minimal OpenAI-safe body covers every such rejection at the
      // cost of a single extra request on genuinely malformed calls.
      // Context-length 400s are deliberately NOT retried here — the
      // caller owns input halving.
      if (
        err instanceof AiCompletionHttpError &&
        err.status === 400 &&
        !isContextLengthError(err)
      ) {
        return await this.request(config, opts, 'minimal');
      }
      throw err;
    }
  }

  /**
   * One non-streaming call to the native Messages API. Same error
   * contract as `request`: HTTP failures throw `AiCompletionHttpError`,
   * a refusal or a thinking-only cut-off throws its own error, and a
   * well-formed empty reply returns null. No `temperature`: Claude 4.7+
   * rejects it, and the reply needs no sampling control.
   */
  private async requestAnthropic(
    config: CompletionConfig,
    opts: CompleteOptions,
  ): Promise<string | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    const onExternalAbort = () => ctrl.abort();
    if (opts.signal?.aborted) ctrl.abort();
    else opts.signal?.addEventListener('abort', onExternalAbort);
    try {
      const res = await safeFetch(`${stripTrailingSlashes(config.baseUrl)}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...providerAuthHeaders(config),
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: opts.maxOutputTokens,
          system: opts.system,
          messages: [{ role: 'user', content: opts.user }],
          ...reasoningParams({
            provider: 'anthropic',
            model: opts.model,
            setting: 'off',
            purpose: 'background',
            maxTokens: opts.maxOutputTokens,
          }),
        }),
        signal: ctrl.signal,
        timeoutMs: opts.timeoutMs,
        ...aiEgressOptions(config),
      });
      if (!res.ok) {
        const raw = (await res.text().catch(() => '')).slice(0, 2048);
        throw new AiCompletionHttpError(res.status, redactSecretsInText(raw).slice(0, 500));
      }
      const { text, finishReason } = fromAnthropicMessage(await res.json());
      const raw = visibleText(text);
      if (finishReason === 'refusal') throw new AiCompletionRefusedError();
      if (!raw && finishReason === 'length') throw new AiCompletionTruncatedError();
      return raw || null;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private async request(
    config: CompletionConfig,
    opts: CompleteOptions,
    mode: 'full' | 'minimal',
  ): Promise<string | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    const onExternalAbort = () => ctrl.abort();
    if (opts.signal?.aborted) ctrl.abort();
    else opts.signal?.addEventListener('abort', onExternalAbort);
    try {
      const res = await safeFetch(
        `${stripTrailingSlashes(config.baseUrl)}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...providerAuthHeaders(config),
          },
          body: JSON.stringify({
            model: opts.model,
            stream: false,
            ...outputTokenParam(opts.model, opts.maxOutputTokens, config.provider),
            ...(mode === 'full'
              ? {
                  ...temperatureParam(opts.model, opts.temperature ?? 0.3),
                  // Lowest reasoning the model supports. For
                  // openai_compatible these are the local-server
                  // disable flags (ignored where unknown).
                  ...reasoningParams({
                    provider: config.provider,
                    model: opts.model,
                    setting: 'off',
                    purpose: 'background',
                    maxTokens: opts.maxOutputTokens,
                  }),
                }
              : {}),
            messages: [
              { role: 'system', content: opts.system },
              { role: 'user', content: opts.user },
            ],
          }),
          signal: ctrl.signal,
          timeoutMs: opts.timeoutMs,
          ...aiEgressOptions(config),
        },
      );
      if (!res.ok) {
        // Redact before the final truncation so a cut can't split a
        // secret around the boundary (same doctrine as
        // `readUpstreamSnippet`).
        const raw = (await res.text().catch(() => '')).slice(0, 2048);
        throw new AiCompletionHttpError(
          res.status,
          redactSecretsInText(raw).slice(0, 500),
        );
      }
      const json = (await res.json()) as {
        choices?: Array<{
          finish_reason?: string | null;
          message?: {
            content?: string | null;
            refusal?: string | null;
            reasoning_content?: string | null;
            reasoning?: string | null;
          };
          reasoning?: string | null;
        }>;
      };
      const choice = json?.choices?.[0];
      const msg = choice?.message;
      if (msg?.refusal && msg.refusal.trim()) throw new AiCompletionRefusedError();
      // Decide on the VISIBLE answer before any reasoning-field fallback:
      // content that is empty or only a `<think>` scratchpad is no answer.
      // A cut-off or refused reply must throw here, or the fallback below
      // would return unfinished reasoning as a successful result.
      const content = visibleText(msg?.content ?? '');
      if (!content) {
        const finish = choice?.finish_reason;
        if (finish === 'content_filter' || finish === 'refusal') {
          throw new AiCompletionRefusedError();
        }
        if (finish === 'length') throw new AiCompletionTruncatedError();
        // A finished reply with no visible text: some local servers put
        // the whole answer in a reasoning field.
        const fallback = opts.contentOnly
          ? ''
          : (msg?.reasoning_content && msg.reasoning_content.trim()) ||
            (msg?.reasoning && msg.reasoning.trim()) ||
            (choice?.reasoning && choice.reasoning.trim()) ||
            '';
        return fallback || null;
      }
      return content;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}
