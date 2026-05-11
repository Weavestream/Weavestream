import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Response } from 'express';
import { ChatRole as PrismaChatRole } from '@prisma/client';
import type { SendChatMessageInput } from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiSettingsService } from '../ai/ai-settings.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

const STREAM_TIMEOUT_MS = 120_000;
const HISTORY_TURN_CAP = 40;
const TITLE_MAX = 60;
const TITLE_TIMEOUT_MS = 15_000;
const DEFAULT_TITLE = 'New chat';

/**
 * Streams an assistant reply to a chat conversation.
 *
 * Wire format (Server-Sent Events on the response):
 *   - `event: meta`  → { conversationId, userMessageId, assistantMessageId, title }
 *   - `event: delta` → { text }
 *   - `event: done`  → { finishReason }
 *   - `event: error` → { message }
 *
 * The service:
 *   1. Validates ownership of the conversation.
 *   2. Persists the user turn before contacting the LLM (so the
 *      conversation is reflected in history even if the model never
 *      replies).
 *   3. Calls the workspace-configured OpenAI-compatible
 *      `/chat/completions` endpoint with `stream: true` and re-emits
 *      each delta to the caller.
 *   4. On success, persists the full assistant message and bumps
 *      `conversation.updatedAt`. On the first turn, derives the title
 *      from the user message.
 *
 * `safeFetch` (the SSRF guard) wraps responses in a max-bytes counter
 * that fights long streams; the LLM endpoint is admin-configured and
 * already trusted by `AiService.listModels`, so we use the global
 * `fetch` directly for the same trust boundary.
 */
@Injectable()
export class ChatStreamService {
  private readonly logger = new Logger(ChatStreamService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiSettings: AiSettingsService,
  ) {}

  async stream(
    actor: AuthedUser,
    conversationId: string,
    input: SendChatMessageInput,
    res: Response,
  ): Promise<void> {
    initSse(res);

    // The conversation must exist and belong to the caller. We surface
    // these errors through the SSE channel (rather than a 404/403 JSON
    // body) because by the time the browser is reading the response
    // status it already has an open event stream.
    const conversation = await this.prisma.chatConversation.findUnique({
      where: { id: conversationId },
      select: {
        id: true,
        userId: true,
        title: true,
        messages: {
          orderBy: { createdAt: 'asc' },
          select: { role: true, content: true },
        },
      },
    });
    if (!conversation) {
      writeError(res, new NotFoundException('Conversation not found'));
      res.end();
      return;
    }
    if (conversation.userId !== actor.id) {
      writeError(res, new ForbiddenException());
      res.end();
      return;
    }

    // Resolve the LLM config up front. If the workspace hasn't
    // configured an endpoint yet (`enabled === false` or missing
    // `baseUrl`), surface the error before any DB write so we don't
    // leave a dangling user turn with no assistant reply.
    let config: { baseUrl: string; apiKey: string | null; defaultModel: string | null };
    try {
      config = await this.aiSettings.getConfig();
    } catch (err) {
      writeError(res, err);
      res.end();
      return;
    }
    if (!config.defaultModel) {
      writeError(
        res,
        new BadRequestException(
          'No default model is configured. Set one in Settings → AI.',
        ),
      );
      res.end();
      return;
    }

    // Persist the user message in its own write so the conversation
    // history is correct even if the LLM call fails mid-stream.
    const userMessage = await this.prisma.chatMessage.create({
      data: {
        conversationId,
        role: PrismaChatRole.USER,
        content: input.content,
      },
      select: { id: true, content: true, createdAt: true },
    });

    // Pre-allocate the assistant message id so the UI can attach the
    // streaming tokens to a stable id from the very first `meta` frame.
    const assistantMessageId = cryptoRandomUuid();

    // Derive a placeholder title on the first turn from the user
    // message itself — fast, deterministic, and good enough to keep
    // the tab and history popover from showing "New chat". The LLM
    // generates a proper short title in the background after the
    // reply lands, and the UI swaps it in via a `title` SSE frame.
    const isFirstTurn =
      conversation.title === DEFAULT_TITLE && conversation.messages.length === 0;
    const newTitle = isFirstTurn ? deriveTitle(input.content) : conversation.title;

    writeFrame(res, 'meta', {
      conversationId,
      userMessageId: userMessage.id,
      assistantMessageId,
      title: newTitle,
    });

    // Assemble the message list for the upstream call. We cap the
    // history at the most recent `HISTORY_TURN_CAP` turns to keep the
    // request size bounded — long-running conversations will silently
    // drop older messages from the context window rather than fail
    // with a 400 from the LLM.
    const upstreamMessages = [
      ...conversation.messages.slice(-HISTORY_TURN_CAP).map((m) => ({
        role: m.role === PrismaChatRole.USER ? 'user' : 'assistant',
        content: m.content,
      })),
      { role: 'user', content: input.content },
    ];

    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), STREAM_TIMEOUT_MS);
    // If the client disconnects, abort the upstream call so we don't
    // keep streaming tokens into a closed socket.
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    let assistantText = '';
    let finishReason: string | null = null;
    try {
      const upstream = await fetch(`${stripTrailingSlash(config.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.defaultModel,
          stream: true,
          messages: upstreamMessages,
        }),
        signal: abort.signal,
      });

      if (!upstream.ok || !upstream.body) {
        const bodyText = await safeReadText(upstream);
        writeError(
          res,
          new BadRequestException(
            `LLM endpoint returned ${upstream.status}${bodyText ? ` — ${bodyText}` : ''}`,
          ),
        );
        res.end();
        return;
      }

      for await (const event of parseSse(upstream.body)) {
        if (event.event && event.event !== 'message') continue;
        const data = event.data;
        if (!data || data === '[DONE]') continue;
        let parsed: OpenAiStreamChunk | null = null;
        try {
          parsed = JSON.parse(data) as OpenAiStreamChunk;
        } catch {
          continue;
        }
        const choice = parsed?.choices?.[0];
        const delta = choice?.delta?.content ?? '';
        if (delta) {
          assistantText += delta;
          writeFrame(res, 'delta', { text: delta });
        }
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }
    } catch (err) {
      writeError(res, err);
      res.end();
      return;
    } finally {
      clearTimeout(timeout);
    }

    // Strip leading whitespace once before persisting. Many
    // OpenAI-compatible endpoints emit a `\n` or `\n\n` priming
    // newline before the real content; saving it as-is causes
    // historical messages to render with a spurious blank line at the
    // top of the bubble. Trailing whitespace is left intact in case
    // the model intentionally ended on a newline.
    const persistedText = assistantText.replace(/^\s+/, '');
    if (!persistedText) {
      writeError(
        res,
        new BadRequestException(
          'LLM returned an empty response. Check the model configuration.',
        ),
      );
      res.end();
      return;
    }

    // Final write — persist the assistant turn, bump updatedAt, and
    // patch in the auto-derived title on the first message. We commit
    // both writes in a single transaction so a partial state is never
    // visible to a concurrent reader.
    try {
      await this.prisma.$transaction([
        this.prisma.chatMessage.create({
          data: {
            id: assistantMessageId,
            conversationId,
            role: PrismaChatRole.ASSISTANT,
            content: persistedText,
          },
        }),
        this.prisma.chatConversation.update({
          where: { id: conversationId },
          data: {
            title: newTitle,
            model: config.defaultModel,
          },
        }),
      ]);
    } catch (err) {
      this.logger.error('Failed to persist assistant message', err);
      writeError(res, err);
      res.end();
      return;
    }

    writeFrame(res, 'done', { finishReason: finishReason ?? 'stop' });

    // First-turn polish: ask the LLM for a real 3–6 word title. The
    // composer is already unlocked (we sent `done`), so we keep the
    // response open just long enough to push a `title` frame. A
    // failure here is non-fatal — the deterministic prefix title from
    // the `meta` frame stays in place.
    if (isFirstTurn) {
      try {
        const generated = await this.generateTitle(
          config,
          input.content,
          persistedText,
        );
        if (generated && generated !== newTitle) {
          await this.prisma.chatConversation.update({
            where: { id: conversationId },
            data: { title: generated },
          });
          writeFrame(res, 'title', { title: generated });
        }
      } catch (err) {
        this.logger.warn(`Title generation failed: ${messageOf(err)}`);
      }
    }

    res.end();
  }

  /**
   * Asks the LLM for a short title summarising the first turn. We use
   * the same OpenAI-compatible endpoint as the chat stream but with
   * `stream: false` and a tight system prompt. Returns `null` on any
   * failure so the caller can keep the placeholder title rather than
   * surfacing the error in the UI.
   *
   * Reasoning models (Qwen3, DeepSeek-R1, …) wrap their internal
   * scratchpad in `<think>…</think>` before answering. A tight
   * `max_tokens` budget burns inside that block and the actual title
   * never reaches us. We:
   *   - allow a generous budget (`max_tokens: 256`) — title gen is
   *     rare and the extra ceiling is cheap;
   *   - hint `/no_think` in the prompt (Qwen3-family soft-disable);
   *   - strip any `<think>…</think>` that slips through in
   *     `sanitizeTitle`.
   */
  private async generateTitle(
    config: { baseUrl: string; apiKey: string | null; defaultModel: string | null },
    userMessage: string,
    assistantReply: string,
  ): Promise<string | null> {
    if (!config.defaultModel) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TITLE_TIMEOUT_MS);
    try {
      const res = await fetch(`${stripTrailingSlash(config.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.defaultModel,
          stream: false,
          temperature: 0.3,
          // Reasoning models burn most of their budget inside the
          // <think> block before answering. 1024 is plenty for a few
          // words of title and still cheap.
          max_tokens: 1024,
          // vLLM / LM Studio / SGLang convention to disable
          // reasoning-mode emission entirely for this request. Servers
          // that don't recognise the flag will simply ignore it.
          // Some honour the OpenAI-shape `reasoning.effort` instead.
          enable_thinking: false,
          chat_template_kwargs: { enable_thinking: false },
          reasoning: { effort: 'none' },
          messages: [
            {
              role: 'system',
              content:
                'You produce concise chat titles. Reply with ONLY a 3 to 6 word title summarising the conversation. No quotes, no trailing punctuation, no markdown, no prefixes like "Title:". /no_think',
            },
            {
              role: 'user',
              content: `User: ${userMessage}\n\nAssistant: ${assistantReply}\n\nReturn the title only. /no_think`,
            },
          ],
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        this.logger.warn(`Title LLM call returned ${res.status}`);
        return null;
      }
      const json = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            // Servers that split reasoning from the final answer
            // (vLLM, LM Studio, OpenRouter) expose the visible reply
            // here. We treat any of these as title fodder so an empty
            // `content` doesn't sink the whole feature.
            reasoning_content?: string | null;
            reasoning?: string | null;
          };
          // Newer OpenAI shapes nest reasoning at the choice level.
          reasoning?: string | null;
        }>;
      };
      const choice = json?.choices?.[0];
      const msg = choice?.message;
      const raw =
        (msg?.content && msg.content.trim()) ||
        (msg?.reasoning_content && msg.reasoning_content.trim()) ||
        (msg?.reasoning && msg.reasoning.trim()) ||
        (choice?.reasoning && choice.reasoning.trim()) ||
        '';
      if (!raw) {
        this.logger.warn(
          `Title LLM call returned no usable content. choice keys: ${Object.keys(
            choice ?? {},
          ).join(',')}; message keys: ${Object.keys(msg ?? {}).join(',')}`,
        );
        return null;
      }
      const cleaned = sanitizeTitle(raw);
      if (!cleaned) {
        this.logger.warn(
          `Title sanitiser dropped LLM output: ${raw.slice(0, 200)}`,
        );
      }
      return cleaned;
    } catch (err) {
      this.logger.warn(`Title generation aborted: ${messageOf(err)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Unknown error';
}

function sanitizeTitle(raw: string): string | null {
  let t = raw;
  // Strip reasoning-model scratchpads. Qwen3 / DeepSeek-R1 etc. wrap
  // their internal chain-of-thought in <think>…</think> before the
  // answer; we want only what comes after.
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // If the model emitted multiple lines (preamble + title), the title
  // is almost always the last non-empty line.
  const lines = t
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length > 1) t = lines[lines.length - 1] ?? t;
  // Strip surrounding quotes/backticks that small models like to add.
  t = t.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '');
  // Drop a leading "Title:" / "Title -" preamble if the model ignored
  // the instruction.
  t = t.replace(/^title\s*[:\-—–]\s*/i, '');
  // Collapse whitespace and any internal newlines onto a single line.
  t = t.replace(/\s+/g, ' ').trim();
  // Strip terminal punctuation that reads oddly in a tab strip.
  t = t.replace(/[.!?,;:]+$/, '').trim();
  if (!t) return null;
  if (t.length > TITLE_MAX) t = `${t.slice(0, TITLE_MAX - 1).trimEnd()}…`;
  return t;
}

function initSse(res: Response): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Tells nginx (and a few CDNs) to flush each chunk instead of
  // buffering — same hint Vercel's docs recommend for SSE endpoints.
  res.setHeader('X-Accel-Buffering', 'no');
  // Flush headers immediately so the browser opens the EventStream
  // even if the first body chunk is delayed.
  res.flushHeaders?.();
}

function writeFrame(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeError(res: Response, err: unknown): void {
  const message =
    err instanceof Error && err.message ? err.message : 'Unknown error';
  writeFrame(res, 'error', { message });
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function deriveTitle(content: string): string {
  const cleaned = content.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= TITLE_MAX) return cleaned || DEFAULT_TITLE;
  return `${cleaned.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

async function safeReadText(res: Response | globalThis.Response): Promise<string | null> {
  try {
    const text = (await (res as globalThis.Response).text()).trim();
    if (!text) return null;
    return text.length > 240 ? `${text.slice(0, 240)}…` : text;
  } catch {
    return null;
  }
}

type OpenAiStreamChunk = {
  choices?: Array<{
    delta?: { content?: string; role?: string };
    finish_reason?: string | null;
  }>;
};

type SseEvent = { event: string | null; data: string };

/**
 * Async iterator that parses an OpenAI-style SSE response body, line
 * by line. The official OpenAI streaming format emits:
 *
 *   data: {"choices":[...]}
 *   data: {"choices":[...]}
 *   data: [DONE]
 *
 * — possibly with an explicit `event:` header on each frame for other
 * vendors (Ollama, vLLM, …). Frames are separated by a blank line.
 */
async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        const tail = buf.trim();
        if (tail) {
          const evt = parseEventBlock(tail);
          if (evt) yield evt;
        }
        return;
      }
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const evt = parseEventBlock(block);
        if (evt) yield evt;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseEventBlock(block: string): SseEvent | null {
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

function cryptoRandomUuid(): string {
  return globalThis.crypto.randomUUID();
}
