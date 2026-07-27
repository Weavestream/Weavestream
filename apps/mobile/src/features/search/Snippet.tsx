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
