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
/**
 * The query's OR-separated groups: `a b OR c` parses as `(a AND b) OR
 * (c)`, mirroring `websearch_to_tsquery`'s precedence. Terms within a
 * group are conjuncts; the groups are alternatives. Excluded terms
 * (`-term`, `-"phrase"`) never appear — by definition they do not
 * occur in results.
 */
export function queryGroups(query: string): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  // The optional `-` is INSIDE the quoted alternative: without it,
  // `-"serial number"` falls through to the bare-token branch and
  // splits on the space, excluding `-"serial` but resurrecting
  // `number"` as a positive term — highlighting text that belongs to
  // an excluded phrase.
  const re = /(-?)"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(query))) {
    if (match[2] !== undefined) {
      if (match[1] === '-') continue; // excluded phrase
      const phrase = match[2].trim();
      if (phrase.length >= 2) current.push(phrase);
      continue;
    }
    const raw = match[3]!;
    if (/^or$/i.test(raw)) {
      if (current.length > 0) groups.push(current);
      current = [];
      continue;
    }
    if (raw.startsWith('-')) continue;
    // An unbalanced quote (`"serial` with no closer) lands here; strip
    // the stray quotes and treat it as an ordinary word, which is the
    // lenient reading `websearch_to_tsquery` also takes.
    const word = raw.replace(/^"+|"+$/g, '');
    if (word.length >= 2) current.push(word);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Every positive term, any group — the highlight set. All branches of
 * an OR are highlight-worthy: any of them could be the one the row
 * matched on.
 */
export function queryTokens(query: string): string[] {
  // Longest first, so a phrase wins over a word it contains.
  return queryGroups(query)
    .flat()
    .sort((a, b) => b.length - a.length);
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

/**
 * Whether the title alone accounts for the whole query — some OR group
 * is fully present in it. Drives the body-only snippet fallback on
 * global rows.
 *
 * Coverage is per-GROUP because the grammar is: `fortinet vpn` needs
 * both (a title reading "Fortinet router" explains only half the match
 * and still owes the body evidence for "vpn"), while `fortinet OR
 * cisco` needs either — one satisfied branch fully explains the row.
 *
 * Two cases deliberately answer "no" (⇒ show the snippet), because a
 * visible explanation beats a confident-looking bare row: a query with
 * no positive terms at all (pure exclusions), and any match the server
 * found by STEMMING ("configure" matching "configuration"), which a
 * literal client matcher cannot reproduce.
 */
export function titleCoversQuery(title: string, query: string): boolean {
  const groups = queryGroups(query);
  if (groups.length === 0) return false;
  return groups.some((group) =>
    group.every((token) => tokenPattern([token]).test(title)),
  );
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
