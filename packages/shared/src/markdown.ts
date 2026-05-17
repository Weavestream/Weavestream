/**
 * Plaintext extraction from Markdown for search indexing and excerpts.
 * Conservative regex-based stripping — no full parser — so this stays
 * dependency-free in `@weavestream/shared`.
 */

export const MAX_MARKDOWN_SOURCE = 500_000;

export interface MarkdownPlaintextOptions {
  /**
   * Drop `![alt](url)` image references entirely instead of preserving
   * the alt text. Editors auto-populate alt with the uploaded filename
   * (e.g. `image.jpg`), which is noise in card previews. Search
   * indexing still benefits from the alt text, so this defaults to
   * `false`; `markdownExcerpt` opts in.
   */
  skipImages?: boolean;
}

/**
 * Strip Markdown syntax to approximate visible text for full-text search
 * and `ts_headline` snippets. Not a perfect renderer — good enough for
 * indexing and matching user queries.
 */
export function markdownToPlaintext(
  src: string,
  options: MarkdownPlaintextOptions = {},
): string {
  if (!src || typeof src !== 'string') return '';
  let s = src.replace(/\r\n?/g, '\n');

  // Fenced code blocks (non-greedy, multiline)
  s = s.replace(/^```[\w-]*\n[\s\S]*?^```/gm, '\n');
  s = s.replace(/```[^`]*```/g, ' ');

  // Footnote / reference link definitions: [^id]: url
  s = s.replace(/^\[[^\]]+\]:\s*.+$/gm, ' ');

  // Link / image: keep visible label, drop URL.
  // Images may be dropped entirely when the caller asked to skip them.
  const imageReplacement = options.skipImages ? ' ' : '$1';
  s = s.replace(/!\[([^\]]*)\]\s*\([^)]+\)/g, imageReplacement);
  s = s.replace(/\[([^\]]+)\]\s*\([^)]+\)/g, '$1');
  s = s.replace(/!\[([^\]]*)\]\s*\[[^\]]*\]/g, imageReplacement);
  s = s.replace(/\[([^\]]+)\]\s*\[[^\]]*\]/g, '$1');

  // Autolinks <https://...>
  s = s.replace(/<https?:\/\/[^>\s]+>/gi, ' ');

  // Setext underlines
  s = s.replace(/^\s*(=+|-+)\s*$/gm, ' ');

  // ATX headings
  s = s.replace(/^#{1,6}\s+/gm, '');

  // Blockquotes
  s = s.replace(/^\s*>\s?/gm, '');

  // Horizontal rules
  s = s.replace(/^\s*(?:\*\s*){3,}|^\s*(?:-\s*){3,}|^_{3,}\s*$/gm, ' ');

  // List markers
  s = s.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, ' ');
  s = s.replace(/^\s*[-*+]\s+/gm, '');
  s = s.replace(/^\s*\d+\.\s+/gm, '');

  // Table separator rows
  s = s.replace(/^\s*\|?[\s:-]+\|[\s|:-]+\|?\s*$/gm, ' ');

  // Remaining table pipes → spaces
  s = s.replace(/^\s*\|/gm, '');
  s = s.replace(/\|\s*$/gm, '');
  s = s.replace(/\|/g, ' ');

  // Emphasis / strikethrough (repeat for nested patterns)
  for (let i = 0; i < 3; i++) {
    s = s.replace(/~~([^~]+)~~/g, '$1');
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
    s = s.replace(/\*([^*]+)\*/g, '$1');
    s = s.replace(/__([^_]+)__/g, '$1');
    s = s.replace(/_([^_]+)_/g, '$1');
  }

  // Inline code
  s = s.replace(/`([^`]+)`/g, '$1');

  // HTML tags
  s = s.replace(/<[^>]+>/g, ' ');

  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n');
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

/** Same semantics as `tiptapExcerpt` but for Markdown source. */
export function markdownExcerpt(src: string, maxChars = 280): string {
  return excerptFromPlaintext(
    markdownToPlaintext(src, { skipImages: true }),
    maxChars,
  );
}

/**
 * Split an LLM markdown response into a `{ title, body }` pair.
 *
 * Models almost always open their response with a single `# Heading`
 * (or any ATX heading) that semantically labels the article. If we
 * persist that as the article body verbatim the renderer ends up
 * showing the title twice — once as the page header, once as the H1
 * at the top of the rendered Markdown.
 *
 * This helper:
 *   - Skips leading blank lines.
 *   - If the first non-blank line is an ATX heading (`#`–`######`,
 *     optionally indented up to 3 spaces, optionally with trailing
 *     `#`s), surfaces its text as the suggested title and removes
 *     the heading line plus any immediately following blank lines
 *     from the body.
 *   - Otherwise, derives a title from the first prose-looking line
 *     and returns the body untouched.
 *
 * Pure / dependency-free so it's safe to reuse on both the client
 * (chat panel save dialog) and the server (chat tool-call apply
 * path).
 */
export function splitMarkdownTitleAndBody(
  src: string,
  fallbackTitle = 'Untitled article',
): { title: string; body: string; hadLeadingHeading: boolean } {
  if (!src) return { title: fallbackTitle, body: '', hadLeadingHeading: false };
  const safeSrc = src.length > MAX_MARKDOWN_SOURCE ? src.slice(0, MAX_MARKDOWN_SOURCE) : src;
  const lines = safeSrc.split(/\r?\n/);

  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') i++;

  // Match the heading prefix only; clean trailing close-`#`s separately so
  // the regex has no overlapping quantifiers (avoids polynomial backtracking).
  const trimmed = i < lines.length ? lines[i]!.replace(/[ \t]+$/, '') : '';
  const heading = i < lines.length ? trimmed.match(/^\s{0,3}#{1,6}\s+(.*)$/) : null;
  if (heading?.[1]) {
    const rawTitle = heading[1].replace(/\s+#+$/, '').trimEnd();
    const title = cleanMarkdownTitle(rawTitle).slice(0, 200) || fallbackTitle;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() === '') j++;
    return { title, body: lines.slice(j).join('\n'), hadLeadingHeading: true };
  }

  return {
    title: titleFromProse(src, fallbackTitle),
    body: src,
    hadLeadingHeading: false,
  };
}

function titleFromProse(src: string, fallback: string): string {
  for (const line of src.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^[`>\-*_=+|]/.test(trimmed)) continue;
    return cleanMarkdownTitle(trimmed).slice(0, 80) || fallback;
  }
  return fallback;
}

function cleanMarkdownTitle(s: string): string {
  // Linear character trim avoids the anchored-alternation regexes flagged
  // as polynomial ReDoS on long runs of `*` / `_`.
  let start = 0;
  let end = s.length;
  while (start < end) {
    const c = s.charCodeAt(start);
    if (c !== 42 /* * */ && c !== 95 /* _ */) break;
    start++;
  }
  while (end > start) {
    const c = s.charCodeAt(end - 1);
    if (c !== 42 && c !== 95) break;
    end--;
  }
  return s.slice(start, end).replace(/`/g, '').trim();
}

/**
 * Truncate already-extracted plaintext at a word boundary with an
 * ellipsis. Shared by `tiptapExcerpt` and `markdownExcerpt` so the two
 * formats produce identical-length card previews.
 */
export function excerptFromPlaintext(plain: string, maxChars = 280): string {
  if (plain.length <= maxChars) return plain;
  const cut = plain.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}
