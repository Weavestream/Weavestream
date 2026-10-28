/**
 * Server-sent events (SSE) parser shared by the chat stream's two
 * transports: OpenAI Chat Completions and the native Anthropic
 * Messages API.
 *
 * OpenAI-style servers send unnamed `data:` frames (ending in
 * `data: [DONE]`); some vendors (Ollama, vLLM) add an `event:` line.
 * Anthropic names every frame (`event: content_block_delta`, …). A
 * blank line ends a frame. Both `\n` and `\r\n` line endings are
 * accepted: the SSE spec allows either, and some proxies rewrite them.
 */

export type SseEvent = { event: string | null; data: string };

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
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
      // Normalize CRLF (and a lone CR) to LF before looking for the
      // blank line. A `\r` at the very end of the buffer may be the
      // first half of a CRLF split across chunks, so it waits for the
      // next chunk.
      buf += decoder.decode(value, { stream: true });
      const pendingCr = buf.endsWith('\r');
      if (pendingCr) buf = buf.slice(0, -1);
      buf = buf.replace(/\r\n?/g, '\n');
      if (pendingCr) buf += '\r';
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
