import type {
  ChatRequestContext,
  ChatToolCallDto,
  ChatTurnIntent,
} from '../schemas/chat.js';
import { ensureCsrf } from './csrf.js';

/**
 * Streams an assistant reply for the given conversation. The server
 * emits Server-Sent Events with these `event:` types:
 *   - `meta`  → { conversationId, userMessageId, assistantMessageId, title }
 *   - `delta` → { text }
 *   - `done`  → { finishReason }
 *   - `error` → { message }
 *
 * The returned promise resolves once the stream completes (after the
 * final `done` or `error` event). Pass an `AbortSignal` to cancel
 * mid-stream (e.g. when the user closes the tab or navigates away);
 * cancellation aborts the underlying fetch — and the CSRF acquisition
 * before it — and stops emitting events.
 *
 * Promoted from `apps/web/src/lib/chat-stream.ts` for the mobile Ask
 * anything panel (Phase 3); the web module re-exports from here.
 */
export type ChatStreamHandlers = {
  onMeta?: (meta: ChatStreamMeta) => void;
  onDelta?: (text: string) => void;
  /**
   * Fires when the server upgrades the placeholder (user-message) title
   * to an LLM-generated one. Currently emitted after the assistant
   * reply on the first turn only.
   */
  onTitle?: (title: string) => void;
  /**
   * Fires when the assistant turn finished WITH one or more agentic
   * tool calls attached. The DTOs are already in `pending` status and
   * persisted server-side; the UI renders Apply / Reject cards.
   */
  onToolCalls?: (messageId: string, toolCalls: ChatToolCallDto[]) => void;
  onDone?: (finishReason: string | null) => void;
  /**
   * `origin` says WHO reported the failure, which callers need for
   * rollback decisions:
   *   - `'preflight'` — the request never left this client (CSRF
   *     acquisition failed, before the message POST was dispatched).
   *     Provably nothing reached the server.
   *   - `'frame'`     — a server-sent `error` event. The chat service
   *     emits every pre-persist failure (not-found, forbidden, AI
   *     disabled) as an error frame BEFORE writing the user turn, so a
   *     pre-`meta` frame is provably unpersisted.
   *   - `'transport'` — a fetch/read failure or an unexpected clean
   *     EOF. The turn may or may not have been persisted; treat it as
   *     ambiguous.
   * Omitted on the HTTP-rejection fallback path (see `onHttpError`).
   */
  onError?: (message: string, origin?: ChatStreamErrorOrigin) => void;
  /**
   * Fires once, immediately before the message POST is dispatched
   * (after CSRF acquisition succeeded). Until this fires, NOTHING has
   * reached the server — callers tracking a persistence boundary can
   * treat a cancellation before it as a clean local rollback.
   */
  onRequestStarted?: () => void;
  /**
   * Fires INSTEAD of `onError` when the response is a non-2xx HTTP
   * rejection (problem+json from Zod/CSRF/throttle — the server only
   * switches to SSE after those pass, so nothing was persisted).
   *
   * When provided it REPLACES `onError` for HTTP-level failures, so the
   * caller must terminally settle its UI for EVERY status it receives —
   * not just 401. Leaving a status unhandled leaves the caller's
   * "streaming" state stuck forever.
   */
  onHttpError?: (status: number, message: string) => void;
  /** Non-fatal server notice (e.g. attached context was trimmed to fit
   *  the model's limit). The stream continues normally. */
  onNotice?: (message: string) => void;
  /**
   * Fires as read tools execute server-side during the streaming loop
   * (WS-030): `started` when a lookup begins, then `succeeded` or
   * `failed`. Carries names/ids only — never arguments or results —
   * so the panel can show a transient "Searching…" line.
   */
  onToolActivity?: (activity: ChatToolActivity) => void;
};

export type ChatStreamErrorOrigin = 'frame' | 'transport' | 'preflight';

export type ChatToolActivity = {
  messageId: string;
  toolCallId: string;
  name: string;
  status: 'started' | 'succeeded' | 'failed';
};

export type ChatStreamMeta = {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  title: string;
};

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export async function streamChatMessage(
  conversationId: string,
  content: string,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
  context?: ChatRequestContext,
  intent?: ChatTurnIntent,
): Promise<void> {
  let token: string;
  try {
    token = await ensureCsrf(signal);
  } catch (err) {
    // A cancelled acquisition is the caller's own abort, not a failure.
    if (isAbortError(err)) return;
    // 'preflight', not 'transport': the message POST was never
    // dispatched, so the server provably holds nothing to reconcile.
    handlers.onError?.(
      'Could not obtain CSRF token. Refresh and try again.',
      'preflight',
    );
    return;
  }

  handlers.onRequestStarted?.();

  let res: Response;
  try {
    res = await fetch(`/api/v1/chat/conversations/${conversationId}/messages`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-CSRF-Token': token,
      },
      body: JSON.stringify({
        content,
        ...(context ? { context } : {}),
        ...(intent ? { intent } : {}),
      }),
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) return;
    handlers.onError?.(
      err instanceof Error ? err.message : 'Network error',
      'transport',
    );
    return;
  }

  if (!res.ok || !res.body) {
    // The server only switches to SSE after auth/zod/ownership checks
    // pass. Anything else lands here as a regular problem+json body.
    let problem: { message?: string } | null = null;
    try {
      problem = (await res.json()) as { message?: string };
    } catch {
      // ignore
    }
    const message = problem?.message ?? `Request failed (${res.status})`;
    if (handlers.onHttpError) handlers.onHttpError(res.status, message);
    else handlers.onError?.(message);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  // The stream must end WITH a terminal frame. A proxy or API process
  // closing the connection cleanly mid-answer would otherwise look like
  // a normal return and leave the caller streaming forever.
  let sawTerminal = false;

  const dispatch = (block: string) => {
    const event = dispatchEvent(block, handlers);
    if (event === 'done' || event === 'error') sawTerminal = true;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        // Flush a trailing event without the blank-line terminator
        // (rare, but plays nicely with proxies that buffer).
        const tail = buf.trim();
        if (tail) dispatch(tail);
        if (!sawTerminal) {
          handlers.onError?.('Connection ended unexpectedly.', 'transport');
        }
        return;
      }
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        dispatch(block);
      }
    }
  } catch (err) {
    if (isAbortError(err)) return;
    handlers.onError?.(
      err instanceof Error ? err.message : 'Stream error',
      'transport',
    );
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // releaseLock throws if the reader is already closed — safe to ignore.
    }
  }
}

/** Returns the dispatched event's name so the loop can track terminals. */
function dispatchEvent(
  block: string,
  handlers: ChatStreamHandlers,
): string | null {
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
  const raw = dataLines.join('\n');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  switch (event) {
    case 'meta':
      handlers.onMeta?.(parsed as ChatStreamMeta);
      return event;
    case 'delta': {
      const text = (parsed as { text?: string })?.text;
      if (typeof text === 'string' && text.length > 0) handlers.onDelta?.(text);
      return event;
    }
    case 'title': {
      const title = (parsed as { title?: string })?.title;
      if (typeof title === 'string' && title.length > 0) handlers.onTitle?.(title);
      return event;
    }
    case 'tool_call': {
      const payload = parsed as {
        messageId?: string;
        toolCalls?: ChatToolCallDto[];
      };
      if (
        payload &&
        typeof payload.messageId === 'string' &&
        Array.isArray(payload.toolCalls) &&
        payload.toolCalls.length > 0
      ) {
        handlers.onToolCalls?.(payload.messageId, payload.toolCalls);
      }
      return event;
    }
    case 'done': {
      const finishReason =
        (parsed as { finishReason?: string | null })?.finishReason ?? null;
      handlers.onDone?.(finishReason);
      return event;
    }
    case 'error': {
      const message =
        (parsed as { message?: string })?.message ?? 'Unknown error';
      handlers.onError?.(message, 'frame');
      return event;
    }
    case 'notice': {
      const message = (parsed as { message?: string })?.message;
      if (typeof message === 'string' && message.length > 0) {
        handlers.onNotice?.(message);
      }
      return event;
    }
    case 'tool_activity': {
      const activity = parsed as Partial<ChatToolActivity>;
      if (
        typeof activity.messageId === 'string' &&
        typeof activity.toolCallId === 'string' &&
        typeof activity.name === 'string' &&
        (activity.status === 'started' ||
          activity.status === 'succeeded' ||
          activity.status === 'failed')
      ) {
        handlers.onToolActivity?.(activity as ChatToolActivity);
      }
      return event;
    }
    default:
      return event;
  }
}
