import { redactUrlsInText } from './redact-url.js';

/**
 * Scrub common secret shapes out of free-form text before it reaches an
 * error response, log line, or durable audit record. Complements
 * `redactUrl`/`redactUrlsInText` (which only handle URL components) by
 * catching secrets spliced into arbitrary prose — typically upstream HTTP
 * error bodies that echo an Authorization header or API key back at us.
 *
 * This is pattern-based and therefore best-effort: it targets the shapes
 * that realistically appear in OpenAI-compatible / webhook error bodies
 * (JSON credential fields, Bearer tokens, `sk-…` keys, `?api_key=` params).
 * Output is still intended for admin-facing surfaces and server logs, not
 * untrusted end users.
 */

const JSON_SECRET_FIELDS =
  /"(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|secret|password|token|key)"\s*:\s*"[^"]*"/gi;

const BEARER_CREDENTIAL = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

// Provider-style key prefixes: sk-, sk-proj-, sk-ant-, …
const SK_STYLE_KEY = /\bsk-[A-Za-z0-9_-]{8,}/g;

// `?api_key=…`, `&token=…`, `password=…` in query strings or form bodies.
const PARAM_SECRET =
  /\b(api[_-]?key|apikey|token|secret|password|key)=[^&\s"']+/gi;

export function redactSecretsInText(text: string): string {
  return redactUrlsInText(
    text
      .replace(JSON_SECRET_FIELDS, '"$1":"[redacted]"')
      .replace(BEARER_CREDENTIAL, 'Bearer [redacted]')
      .replace(SK_STYLE_KEY, 'sk-[redacted]')
      .replace(PARAM_SECRET, '$1=[redacted]'),
  );
}

/** Bytes of an upstream error body we are willing to read at all. */
const SNIPPET_MAX_BYTES = 2048;
/** Characters of that body we surface after redaction. */
export const SNIPPET_MAX_CHARS = 200;

/**
 * Read a short, secret-redacted snippet of an upstream response body for
 * diagnostics ("LLM endpoint returned 401 — …").
 *
 * Byte-bounded by streaming: reads at most `SNIPPET_MAX_BYTES` from the
 * body and then cancels the stream, so a hostile or misconfigured origin
 * can't make us buffer an unbounded error body (the chat-stream call site
 * deliberately sets `maxResponseBytes: Infinity` for SSE, so `res.text()`
 * would have no cap there). Redaction runs BEFORE truncation so an
 * unlucky cut can't split a secret around the boundary and leak its
 * prefix.
 *
 * Returns null when the body is missing, empty, or unreadable — callers
 * render the status line alone in that case.
 */
export async function readUpstreamSnippet(res: Response): Promise<string | null> {
  const body = res.body;
  if (!body) return null;
  let raw = '';
  try {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let bytes = 0;
    while (bytes < SNIPPET_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        bytes += value.byteLength;
        raw += decoder.decode(value, { stream: true });
      }
    }
    raw += decoder.decode();
    // Drop the rest of the body — we only ever wanted a diagnostic prefix.
    await reader.cancel().catch(() => {});
  } catch {
    // Snippet is best-effort diagnostics; an unreadable body must never
    // mask the original upstream failure.
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const redacted = redactSecretsInText(trimmed).replace(/\s+/g, ' ');
  return redacted.length > SNIPPET_MAX_CHARS
    ? `${redacted.slice(0, SNIPPET_MAX_CHARS)}…`
    : redacted;
}
