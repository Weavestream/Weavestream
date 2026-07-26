/**
 * Turn a user-stored URL field into an href that is safe to render, or
 * `null` when it is not.
 *
 * `password.url` (and URL-ish fields generally) are stored as arbitrary
 * strings — the schema caps length but does not validate shape. Three
 * failure modes make a raw `<a href={value}>` wrong (CLAUDE.md §3):
 *
 *  - A scheme-less value (`portal.example.com`) is resolved as a
 *    *relative* path, silently navigating inside the app.
 *  - A scheme is honoured whatever it is — `javascript:` executes,
 *    `data:`/`file:`/`vbscript:` are their own hazards.
 *  - The WHATWG URL parser STRIPS embedded tab/newline characters, so
 *    `example.com\n.evil` would quietly become `example.com.evil` and
 *    `java\tscript:` would reassemble into an executable scheme after
 *    a naive prefix check.
 *
 * Policy: inputs containing control characters are rejected outright;
 * `http:`/`https:` pass through; a scheme-less value — including the
 * `host:port` shape, which a bare scheme regex misreads as a scheme —
 * is promoted to `https://`; everything else returns `null` and the
 * caller renders plain text (typically with a copy action) instead of
 * a link.
 */

/** C0 controls + DEL. The URL parser silently strips \t\n\r — reject
 *  BEFORE parsing or they become host-merging / scheme-smuggling. */
// eslint-disable-next-line no-control-regex -- matching controls is the point
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/** RFC 3986 scheme: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":" */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * The `host:port` shape that SCHEME_RE misreads as a scheme
 * (`example.com:8443`, `localhost:8080`): colon followed by nothing
 * but digits until a path/query/fragment or the end. Classified as a
 * host, so it gets the https promotion instead of a scheme rejection.
 * (A digits-only opaque "scheme" like `javascript:8080` also lands
 * here — the promotion yields a dead-but-https link, never an
 * executable scheme, so the security contract holds.)
 */
const HOST_PORT_RE = /^[a-zA-Z0-9][a-zA-Z0-9+.-]*:\d{1,5}(?:[/?#]|$)/;

export function safeExternalHref(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  if (CONTROL_CHARS_RE.test(value)) return null;

  const schemeMatch = SCHEME_RE.exec(value);
  let candidate: string;
  if (schemeMatch && !HOST_PORT_RE.test(value)) {
    const scheme = schemeMatch[0].slice(0, -1).toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return null;
    candidate = value;
  } else {
    // No scheme (or a host:port). One edge case first: a
    // protocol-relative value (`//evil.example`) parses fine under an
    // https base and would sail through — but the author's intent is
    // ambiguous and the host is attacker-shaped, so treat it like any
    // scheme-less host.
    candidate = `https://${value.replace(/^\/+/, '')}`;
  }

  try {
    const url = new URL(candidate);
    // Belt over braces: URL parsing normalises the scheme, so this
    // holds by construction — but it is the invariant callers rely on.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    // Not parseable as a URL at all (`https://` alone, an out-of-range
    // port, bare `:`, …).
    return null;
  }
}
