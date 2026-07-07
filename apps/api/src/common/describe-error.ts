import { redactSecretsInText } from './redact-secrets.js';

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
 * strips userinfo, query, and fragment, and common secret shapes spliced
 * into free text (Bearer tokens, `sk-…` keys, JSON credential fields) are
 * scrubbed by `redactSecretsInText`. Still best-effort, so the output is
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
  // Redact BEFORE truncating — cutting first could split a secret around
  // the boundary and leave an unmatched (unredacted) prefix behind.
  return redactSecretsInText(joined).slice(0, maxLen);
}
