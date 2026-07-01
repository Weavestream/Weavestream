import { redactUrl } from './redact-url.js';

/**
 * Render an error for logs, admin-facing messages, and durable audit /
 * sync-conflict records — INCLUDING its `cause` chain.
 *
 * Node's global `fetch` / undici throw a bare `TypeError: fetch failed`
 * and stash the real reason (`ECONNREFUSED`, `ETIMEDOUT`,
 * `UND_ERR_CONNECT_TIMEOUT`, TLS/DNS errors, dispatcher mismatches, …) on
 * `error.cause`. Recording only `err.message` discards it, leaving an
 * unactionable "fetch failed" in the runs UI and logs. This walks the
 * `cause` chain (and the first member of an `AggregateError`) so the true
 * failure is visible, tagging each layer with its error `code`.
 *
 * Redaction: driver error messages routinely interpolate the request URL,
 * whose query string / userinfo can carry API keys or signed-URL tokens.
 * Every embedded `http(s)://` URL is passed through `redactUrl`, which
 * strips userinfo, query, and fragment. This does NOT attempt to scrub
 * secrets a driver might splice elsewhere into free text, so the output is
 * intended for server logs and SUPER_ADMIN-only integration surfaces — not
 * for untrusted end users, who should get a generic message + correlation id.
 */
export function describeError(e: unknown, maxLen = 500): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = e;
  let depth = 0;
  while (cur != null && depth < 6 && !seen.has(cur)) {
    seen.add(cur);
    if (cur instanceof Error) {
      const code = (cur as { code?: unknown }).code;
      const label =
        code !== undefined && code !== null
          ? `${cur.message} [${String(code)}]`
          : cur.message;
      if (label) parts.push(label);
      const errs = (cur as { errors?: unknown }).errors;
      if (Array.isArray(errs) && errs.length > 0) {
        // AggregateError (e.g. "all addresses failed") — surface the first.
        cur = errs[0];
      } else {
        cur = (cur as { cause?: unknown }).cause;
      }
    } else {
      parts.push(String(cur));
      cur = undefined;
    }
    depth += 1;
  }
  const joined = parts.filter(Boolean).join(' ← ') || 'unknown error';
  return redactUrlsInText(joined).slice(0, maxLen);
}

// Redact secret-bearing components (userinfo / query / fragment) of any
// URL embedded in a free-form error string. URLs never contain
// whitespace, so match up to the next space/quote, then trim trailing
// punctuation that belongs to the surrounding prose rather than the URL.
const URL_IN_TEXT = /https?:\/\/[^\s'"]+/gi;

function redactUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => {
    const core = match.replace(/[).,;:!?\]}]+$/, '');
    const trailing = match.slice(core.length);
    return redactUrl(core) + trailing;
  });
}
