/**
 * Render a search snippet with highlighted terms.
 *
 * The API pre-escapes every character in the snippet and re-emits only
 * `<mark>` / `</mark>` as literal tags (`SearchService.sanitiseSnippet`).
 * We split on those literals and render `<mark>` as a real React
 * element, letting React escape all surrounding text — the same
 * approach as desktop's `HighlightedSnippet`, with one addition: the
 * three entities the server's escaping produces (`&amp;` `&lt;` `&gt;`)
 * are decoded back for display AS TEXT, so a password named "AT&T
 * router" doesn't render as "AT&amp;T router".
 *
 * No `dangerouslySetInnerHTML`, ever — that is the review-blocker line.
 */

const SENTINEL_SPLIT = /(<mark>.*?<\/mark>)/g;
const MARKED = /^<mark>(.*?)<\/mark>$/;

function decodeEntities(text: string): string {
  // `&amp;` last, so a source-literal "&lt;" (escaped to "&amp;lt;")
  // round-trips to "&lt;" instead of collapsing to "<".
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/**
 * Query tokenization for the client-side highlighter, mirroring the
 * operator surface of the server's `websearch_to_tsquery`:
 *
 *  - `"quoted text"` is ONE phrase token (the server turns it into a
 *    `<->` phrase match) — the quotes never reach the highlight;
 *  - a standalone `or` (any case) is the OR operator, not a term —
 *    without this, `fortinet OR cisco` would highlight the "or" inside
 *    "Fortinet";
 *  - a leading `-` marks an EXCLUDED term, which by definition does not
 *    occur in the results — never highlighted.
 *
 * Deliberately best-effort beyond that: the server also stems
 * ("configure" matches "configuration"), which a literal client
 * highlighter cannot reproduce — body-only matches keep the server's
 * own highlighted snippet as the evidence (SearchScreen).
 */
export function queryTokens(query: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(query))) {
    if (match[1] !== undefined) {
      const phrase = match[1].trim();
      if (phrase.length >= 2) tokens.push(phrase);
      continue;
    }
    const raw = match[2]!;
    if (/^or$/i.test(raw)) continue;
    if (raw.startsWith('-')) continue;
    const word = raw.replace(/^"+|"+$/g, '');
    if (word.length >= 2) tokens.push(word);
  }
  // Longest first, so a phrase wins over a word it contains.
  return tokens.sort((a, b) => b.length - a.length);
}

function tokenPattern(tokens: string[]): RegExp {
  return new RegExp(
    `(${tokens
      .map((t) =>
        // Escape, then let phrase-internal whitespace match flexibly.
        t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'),
      )
      .join('|')})`,
    'gi',
  );
}

/** Whether any query token occurs in `text` — drives the body-only
 *  snippet fallback on global rows. */
export function hasQueryMatch(text: string, query: string): boolean {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return false;
  return tokenPattern(tokens).test(text);
}

/**
 * Client-side highlighter for GLOBAL search rows (Phase 5b): wraps
 * case-insensitive occurrences of each query token in the same mark
 * styling the server snippet uses. Works on plain strings the app
 * already holds (titles) — no HTML parsing, no entities, every node a
 * React text node.
 */
export function HighlightMatches({ text, query }: { text: string; query: string }) {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return <>{text}</>;
  // A single capturing group alternates [miss, match, miss, …]: odd
  // indices are matches, by construction.
  const parts = text.split(tokenPattern(tokens));
  return (
    <>
      {parts.map((part, i) =>
        !part ? null : i % 2 === 1 ? (
          <mark
            key={i}
            className="rounded-[3px] bg-accent-soft px-0.5 text-accent-deep"
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

export function Snippet({ snippet }: { snippet: string }) {
  const parts = snippet.split(SENTINEL_SPLIT);
  return (
    <>
      {parts.map((part, i) => {
        if (!part) return null;
        const marked = MARKED.exec(part);
        if (marked) {
          return (
            <mark
              key={i}
              className="rounded-[3px] bg-accent-soft px-0.5 text-accent-deep"
            >
              {decodeEntities(marked[1] ?? '')}
            </mark>
          );
        }
        return <span key={i}>{decodeEntities(part)}</span>;
      })}
    </>
  );
}
