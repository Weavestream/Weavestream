/**
 * Build a `Content-Disposition` header value for a streamed file.
 *
 * The quoted `filename` fallback must be pure printable ASCII: Node's
 * `setHeader` rejects any header value containing a character above
 * U+00FF outright (ERR_INVALID_CHAR — surfaced as an unhandled 500
 * when an emoji-named upload was opened), and legacy clients disagree
 * on how to decode anything non-ASCII inside a quoted-string. Anything
 * outside 0x20–0x7E — plus `"` and `\`, which break the quoting, and
 * CR/LF, which would split the header — becomes `_`.
 *
 * The exact name rides in the RFC 5987 `filename*` parameter, which
 * every current browser prefers over the fallback. Upload filenames
 * are sanitised at init nowadays, but rows saved before that (and any
 * caller passing a server-generated name) still serve correctly here
 * no matter what the string contains.
 */
export function contentDispositionFor(
  filename: string,
  mode: 'inline' | 'attachment',
): string {
  let fallback = '';
  for (const ch of filename) {
    const cp = ch.codePointAt(0) as number;
    fallback += cp < 0x20 || cp > 0x7e || ch === '"' || ch === '\\' ? '_' : ch;
  }
  if (!/[A-Za-z0-9]/.test(fallback)) fallback = 'file';
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `${mode}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
