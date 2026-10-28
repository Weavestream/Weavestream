import type { OpenAiFunctionTool, StrictJsonSchema } from '../ai-tools/zod-openai.js';
import {
  claudeReasoningTier,
  rejectsForcedToolChoice,
  supportsStrictTools,
} from './provider-http.js';
import type { SseEvent } from './sse.js';

/**
 * Native Anthropic Messages API mapping for provider `anthropic`. Pure
 * functions, no Nest and no I/O: the chat stream and
 * `AiCompletionService` own the requests.
 *
 * Weavestream keeps its chat history in the OpenAI Chat Completions
 * shape. This module converts that history to a Messages request and
 * converts the streamed reply back to the same pieces the OpenAI
 * transport produces (text deltas, `tool_calls` deltas, a finish
 * reason), so the tool loop does not know which transport ran.
 *
 * Rules that come from the API, not from preference:
 *   - All system text goes in the top-level `system` field.
 *   - A request whose history holds `tool_use` blocks must send `tools`,
 *     so the forced-final round sends the tools with
 *     `tool_choice: {type: 'none'}` instead of leaving them out.
 *   - Thinking blocks are replayed unchanged with the `tool_use` they
 *     came with (`providerBlocks`). Dropping or editing them breaks
 *     the turn.
 *   - No `temperature` / `top_p` / `top_k`: Claude 4.7+ rejects them,
 *     and API version 2026-10-21 rejects them on every model.
 */

/** A chat message in the OpenAI shape (structurally `UpstreamMessage`). */
export interface ChatShapeMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  /** The assistant turn's native content blocks, replayed unchanged. */
  providerBlocks?: unknown[];
}

export type AnthropicBlock = Record<string, unknown>;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

export type ChatToolChoice =
  | 'none'
  | 'auto'
  | { type: 'function'; function: { name: string } };

const THINKING_TYPES = new Set(['thinking', 'redacted_thinking']);

/**
 * Split the OpenAI-shape history into the top-level `system` blocks and
 * the `messages` array. Tool results become `tool_result` blocks in a
 * `user` message; consecutive messages of one role merge into one
 * message (the API needs strict user/assistant alternation).
 */
export function toAnthropicMessages(messages: ReadonlyArray<ChatShapeMessage>): {
  system: AnthropicBlock[];
  messages: AnthropicMessage[];
} {
  const system: AnthropicBlock[] = [];
  const out: AnthropicMessage[] = [];
  const push = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) system.push({ type: 'text', text: m.content });
      continue;
    }
    if (m.role === 'tool') {
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: m.tool_call_id ?? '',
          content: m.content || '(empty result)',
        },
      ]);
      continue;
    }
    if (m.role === 'assistant') {
      if (m.providerBlocks && m.providerBlocks.length > 0) {
        push('assistant', m.providerBlocks as AnthropicBlock[]);
        continue;
      }
      const blocks: AnthropicBlock[] = [];
      if (m.content && m.content.trim()) blocks.push({ type: 'text', text: m.content });
      for (const call of m.tool_calls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: parseToolInput(call.function.arguments),
        });
      }
      push('assistant', blocks);
      continue;
    }
    // 'user' and anything unknown: plain text from the user side.
    if (m.content && m.content.trim()) push('user', [{ type: 'text', text: m.content }]);
  }

  // Cache the stable prefix (tools + system) so the second and third
  // rounds of a tool turn read it from the cache. Below the model's
  // minimum cacheable length the marker is a no-op, never an error.
  const lastSystem = system[system.length - 1];
  if (lastSystem) lastSystem.cache_control = { type: 'ephemeral' };
  return { system, messages: out };
}

/**
 * Malformed arguments become `{}`: that call already gets
 * `TOOL_MSG_INVALID_ARGS` as its result, and the API needs an object.
 */
function parseToolInput(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // Invalid JSON from the model: replay an empty input (see above).
    return {};
  }
}

/** Remove thinking blocks from replayed assistant turns. */
export function stripThinkingBlocks<T extends ChatShapeMessage>(
  messages: ReadonlyArray<T>,
): T[] {
  return messages.map((m) =>
    m.providerBlocks
      ? {
          ...m,
          providerBlocks: m.providerBlocks.filter(
            (b) => !THINKING_TYPES.has((b as { type?: string }).type ?? ''),
          ),
        }
      : m,
  );
}

/**
 * Strict mode does not support string or numeric bounds or array size
 * limits. The converter already leaves out string and numeric bounds;
 * this removes `maxItems` too. Server-side Zod still enforces all of
 * them when the tool runs.
 */
function forStrictMode(schema: StrictJsonSchema): StrictJsonSchema {
  const out: StrictJsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'maxItems' || key === 'minItems') continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, StrictJsonSchema>).map(([k, v]) => [
          k,
          forStrictMode(v),
        ]),
      );
    } else if (key === 'items' && value && typeof value === 'object') {
      out[key] = forStrictMode(value as StrictJsonSchema);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function toAnthropicTools(
  tools: ReadonlyArray<OpenAiFunctionTool>,
  model: string,
): AnthropicBlock[] {
  const strict = supportsStrictTools(model);
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: strict ? forStrictMode(t.function.parameters) : t.function.parameters,
    ...(strict ? { strict: true } : {}),
  }));
}

/**
 * Whether the request may force a named tool. Forced tool use is not
 * accepted while thinking is on, and some models reject it always.
 * `reasoning` is the `reasoningParams` fragment the request sends.
 */
export function acceptsForcedTool(
  model: string,
  reasoning: Record<string, unknown>,
): boolean {
  if (rejectsForcedToolChoice(model)) return false;
  const tier = claudeReasoningTier(model);
  if (tier === 'always') return false;
  const thinking = reasoning.thinking as { type?: string } | undefined;
  if (thinking) return thinking.type === 'disabled';
  // Thinking is on by default on these models unless disabled.
  return tier !== 'disableable';
}

/**
 * Build a Messages request body. `tools` are the tools to offer this
 * round; `replayTools` are the tools of an earlier round, sent with
 * `tool_choice: none` when this round offers none but the history
 * holds tool calls. `forceTool: false` turns a named `toolChoice` into
 * `auto` (the caller adds the prompt instruction).
 */
export function toAnthropicRequest(opts: {
  model: string;
  messages: ReadonlyArray<ChatShapeMessage>;
  tools: ReadonlyArray<OpenAiFunctionTool> | null;
  toolChoice: ChatToolChoice | null;
  replayTools?: ReadonlyArray<OpenAiFunctionTool> | null;
  forceTool: boolean;
  maxTokens: number;
  reasoning: Record<string, unknown>;
  stream: boolean;
}): Record<string, unknown> {
  const { system, messages } = toAnthropicMessages(opts.messages);
  const historyHasTools = opts.messages.some(
    (m) => m.role === 'tool' || (m.tool_calls?.length ?? 0) > 0,
  );

  let toolFields: Record<string, unknown> = {};
  if (opts.tools && opts.tools.length > 0 && opts.toolChoice && opts.toolChoice !== 'none') {
    const choice =
      typeof opts.toolChoice === 'object'
        ? opts.forceTool
          ? { type: 'tool', name: opts.toolChoice.function.name }
          : { type: 'auto' }
        : { type: 'auto' };
    toolFields = { tools: toAnthropicTools(opts.tools, opts.model), tool_choice: choice };
  } else if (historyHasTools) {
    const tools = opts.tools && opts.tools.length > 0 ? opts.tools : opts.replayTools;
    if (tools && tools.length > 0) {
      toolFields = {
        tools: toAnthropicTools(tools, opts.model),
        tool_choice: { type: 'none' },
      };
    }
  }

  return {
    model: opts.model,
    max_tokens: opts.maxTokens,
    ...(opts.stream ? { stream: true } : {}),
    ...(system.length > 0 ? { system } : {}),
    messages,
    ...toolFields,
    ...opts.reasoning,
  };
}

// ----------------------------------------------------------------------
// Responses
// ----------------------------------------------------------------------

/** The stop reasons the rest of the app understands. */
export function mapStopReason(stop: string | null | undefined): string | null {
  switch (stop) {
    case null:
    case undefined:
      return null;
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'refusal':
      return 'refusal';
    default:
      return 'stop';
  }
}

/** Text of a non-streaming Messages response. */
export function fromAnthropicMessage(json: unknown): {
  text: string;
  finishReason: string | null;
} {
  const msg = (json ?? {}) as {
    content?: Array<{ type?: string; text?: string }>;
    stop_reason?: string | null;
  };
  const text = (msg.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  return { text, finishReason: mapStopReason(msg.stop_reason) };
}

/** The shape `ToolCallAccumulator.ingest` takes. */
export interface ToolCallDeltaShape {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

export type AnthropicStreamItem =
  | { kind: 'text'; text: string }
  | { kind: 'toolCallDelta'; delta: ToolCallDeltaShape }
  | { kind: 'done'; finishReason: string | null; blocks: AnthropicBlock[] };

/**
 * A mid-stream `error` event, or `stream_interrupted` when the stream
 * closes before `message_stop`. `errorType` is a bounded identifier only.
 */
export class AnthropicStreamError extends Error {
  constructor(readonly errorType: string) {
    super(`Anthropic stream error: ${errorType}`);
  }
}

interface BlockState {
  block: AnthropicBlock;
  /** Accumulated `input_json_delta` fragments of a `tool_use` block. */
  json?: string;
}

/**
 * Convert the Messages SSE events into text, tool-call deltas and a
 * final `done` item. `done` comes only after `message_stop`; a stream
 * that ends before it throws `AnthropicStreamError('stream_interrupted')`. `done.blocks` holds the assistant turn's content
 * blocks in order (thinking included), for replay with its tool calls.
 */
export async function* parseAnthropicStream(
  events: AsyncIterable<SseEvent>,
): AsyncGenerator<AnthropicStreamItem> {
  const blocks = new Map<number, BlockState>();
  let stopReason: string | null = null;

  const finish = (): AnthropicStreamItem => ({
    kind: 'done',
    finishReason: mapStopReason(stopReason),
    blocks: [...blocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, s]) => s.block)
      .filter((b) => !(b.type === 'text' && !b.text)),
  });

  for await (const evt of events) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(evt.data) as Record<string, unknown>;
    } catch {
      // A frame that is not JSON (keep-alive noise from a proxy).
      continue;
    }
    const type = evt.event ?? (data.type as string | undefined);
    switch (type) {
      case 'content_block_start': {
        const index = Number(data.index);
        const cb = (data.content_block ?? {}) as AnthropicBlock;
        if (cb.type === 'tool_use') {
          blocks.set(index, {
            block: { type: 'tool_use', id: cb.id, name: cb.name, input: {} },
            json: '',
          });
          yield {
            kind: 'toolCallDelta',
            delta: {
              index,
              id: String(cb.id ?? ''),
              type: 'function',
              function: { name: String(cb.name ?? ''), arguments: '' },
            },
          };
        } else {
          blocks.set(index, { block: { ...cb } });
          if (cb.type === 'text' && typeof cb.text === 'string' && cb.text) {
            yield { kind: 'text', text: cb.text };
          }
        }
        break;
      }
      case 'content_block_delta': {
        const index = Number(data.index);
        const state = blocks.get(index);
        const delta = (data.delta ?? {}) as Record<string, unknown>;
        if (!state) break;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          state.block.text = String(state.block.text ?? '') + delta.text;
          yield { kind: 'text', text: delta.text };
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          state.json = (state.json ?? '') + delta.partial_json;
          if (delta.partial_json) {
            yield {
              kind: 'toolCallDelta',
              delta: { index, function: { arguments: delta.partial_json } },
            };
          }
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          state.block.thinking = String(state.block.thinking ?? '') + delta.thinking;
        } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
          state.block.signature = String(state.block.signature ?? '') + delta.signature;
        }
        break;
      }
      case 'content_block_stop': {
        const index = Number(data.index);
        const state = blocks.get(index);
        if (state?.block.type === 'tool_use') {
          const raw = state.json ?? '';
          // A tool with no parameters streams no JSON at all.
          if (!raw.trim()) {
            yield { kind: 'toolCallDelta', delta: { index, function: { arguments: '{}' } } };
          }
          state.block.input = raw.trim() ? parseToolInput(raw) : {};
        }
        break;
      }
      case 'message_delta': {
        const delta = (data.delta ?? {}) as { stop_reason?: string | null };
        if (delta.stop_reason) stopReason = delta.stop_reason;
        break;
      }
      case 'error': {
        const err = (data.error ?? {}) as { type?: unknown };
        const errorType =
          typeof err.type === 'string' && /^[a-z_]{1,40}$/.test(err.type)
            ? err.type
            : 'unknown_error';
        throw new AnthropicStreamError(errorType);
      }
      case 'message_stop':
        yield finish();
        return;
      default:
        // message_start, ping, and event types added later.
        break;
    }
  }
  // The stream ended without `message_stop` (a dropped connection or a
  // proxy cut). The message, and any tool call in it, is incomplete:
  // never hand it on as a finished reply.
  throw new AnthropicStreamError('stream_interrupted');
}
