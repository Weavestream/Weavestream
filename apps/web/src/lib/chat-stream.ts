'use client';

import { ensureCsrf } from './csrf';

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
 * cancellation aborts the underlying fetch and stops emitting events.
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
  onDone?: (finishReason: string | null) => void;
  onError?: (message: string) => void;
};

export type ChatStreamMeta = {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  title: string;
};

export async function streamChatMessage(
  conversationId: string,
  content: string,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let token: string;
  try {
    token = await ensureCsrf();
  } catch {
    handlers.onError?.('Could not obtain CSRF token. Refresh and try again.');
    return;
  }

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
      body: JSON.stringify({ content }),
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    handlers.onError?.(err instanceof Error ? err.message : 'Network error');
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
    handlers.onError?.(problem?.message ?? `Request failed (${res.status})`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        // Flush a trailing event without the blank-line terminator
        // (rare, but plays nicely with proxies that buffer).
        const tail = buf.trim();
        if (tail) dispatchEvent(tail, handlers);
        return;
      }
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        dispatchEvent(block, handlers);
      }
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    handlers.onError?.(err instanceof Error ? err.message : 'Stream error');
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // releaseLock throws if the reader is already closed — safe to ignore.
    }
  }
}

function dispatchEvent(block: string, handlers: ChatStreamHandlers): void {
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
  if (dataLines.length === 0) return;
  const raw = dataLines.join('\n');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  switch (event) {
    case 'meta':
      handlers.onMeta?.(parsed as ChatStreamMeta);
      return;
    case 'delta': {
      const text = (parsed as { text?: string })?.text;
      if (typeof text === 'string' && text.length > 0) handlers.onDelta?.(text);
      return;
    }
    case 'title': {
      const title = (parsed as { title?: string })?.title;
      if (typeof title === 'string' && title.length > 0) handlers.onTitle?.(title);
      return;
    }
    case 'done': {
      const finishReason =
        (parsed as { finishReason?: string | null })?.finishReason ?? null;
      handlers.onDone?.(finishReason);
      return;
    }
    case 'error': {
      const message =
        (parsed as { message?: string })?.message ?? 'Unknown error';
      handlers.onError?.(message);
      return;
    }
    default:
      return;
  }
}
