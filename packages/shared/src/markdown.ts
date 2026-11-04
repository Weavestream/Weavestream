/**
 * Plaintext extraction from Markdown for search indexing and excerpts.
 * Conservative regex-based stripping — no full parser — so this stays
 * dependency-free in `@weavestream/shared`.
 */

export const MAX_MARKDOWN_SOURCE = 500_000;

/** Private-use marker around a parked code slot; stripped from input first. */
const CODE_SLOT = '';
const CODE_SLOT_STRIP = //g;
const CODE_SLOT_REF = /(\d+)/g;

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
  let s = src.replace(/\r\n?/g, '\n').replace(CODE_SLOT_STRIP, '');

  // Code is searchable text (commands, paths, error codes), so keep its
  // contents verbatim: park each block or span in a slot the syntax
  // stripping below cannot touch, then restore it at the end.
  const code: string[] = [];
  const park = (text: string) => `${CODE_SLOT}${code.push(text) - 1}${CODE_SLOT}`;
  s = s.replace(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm, (_m, body: string) => `\n${park(body)}\n`);
  s = s.replace(/```([^`]*)```/g, (_m, body: string) => ` ${park(body)} `);
  s = s.replace(/`([^`\n]+)`/g, (_m, body: string) => park(body));

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

  // Emphasis / strikethrough (repeat for nested patterns). Emphasis never
  // spans lines, and `_` never opens or closes inside a word (CommonMark),
  // so `create_article` and `my_file_name` keep their underscores.
  for (let i = 0; i < 3; i++) {
    s = s.replace(/~~([^~\n]+)~~/g, '$1');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1');
    s = s.replace(/\*([^*\n]+)\*/g, '$1');
    s = s.replace(/(^|[^\p{L}\p{N}_])__([^_\n]+)__(?![\p{L}\p{N}_])/gu, '$1$2');
    s = s.replace(/(^|[^\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])/gu, '$1$2');
  }

  // HTML tags
  s = s.replace(/<[^>]+>/g, ' ');

  s = s.replace(CODE_SLOT_REF, (_m, i: string) => code[Number(i)] ?? '');

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

/** Mirrors `articleTitleSchema` / `articleSlugSchema` max lengths. */
const ARTICLE_TITLE_MAX = 200;
const ARTICLE_SLUG_MAX = 80;

export type MarkdownImportResult =
  | { ok: true; title: string; markdownSource: string }
  | { ok: false; reason: string };

/**
 * Turn one imported `.md` file into an article title and Markdown body.
 *
 * Title order: the first `#` heading outside code fences (else the first
 * heading of any level) → a front-matter `title:` line → the file name →
 * `'Untitled article'`. The heading line is removed from the body only
 * when it is the first content line, so the article does not show its
 * title twice; a heading lower down stays where the author put it.
 *
 * Unlike `splitMarkdownTitleAndBody` (which only looks at the leading
 * line), this scans the whole file, because exported docs often open
 * with a badge or an intro paragraph.
 */
export function parseMarkdownImport(src: string, fileName: string): MarkdownImportResult {
  let text = (src ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  let frontMatterTitle: string | null = null;
  const fm = splitFrontMatter(text);
  if (fm) {
    text = fm.rest;
    frontMatterTitle = fm.title;
  }
  if (!text.trim()) return { ok: false, reason: 'File is empty.' };

  const lines = text.split('\n');
  let firstContent = -1;
  let firstAny: { index: number; title: string } | null = null;
  let firstH1: { index: number; title: string } | null = null;
  let fence: { ch: string; len: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (firstContent === -1 && line.trim() !== '') firstContent = i;
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1]![0] === fence.ch &&
        fenceMatch[1]!.length >= fence.len &&
        line.slice(fenceMatch[0].length).trim() === ''
      ) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = { ch: fenceMatch[1]![0]!, len: fenceMatch[1]!.length };
      continue;
    }
    // Prefix-only match; the text after it is cleaned separately so the
    // regex has no overlapping quantifiers.
    const heading = /^ {0,3}(#{1,6})[ \t]/.exec(line);
    if (!heading) continue;
    const raw = line
      .slice(heading[0].length)
      .trim()
      .replace(/\s+#+$/, '')
      .replace(/^#+$/, '');
    const title = cleanMarkdownTitle(raw).slice(0, ARTICLE_TITLE_MAX).trim();
    if (!title) continue;
    if (!firstAny) firstAny = { index: i, title };
    if (heading[1]!.length === 1) {
      firstH1 = { index: i, title };
      break;
    }
  }

  const selected = firstH1 ?? firstAny;
  let body = text;
  if (selected && selected.index === firstContent) {
    let j = selected.index + 1;
    while (j < lines.length && lines[j]!.trim() === '') j++;
    const rest = lines.slice(j).join('\n');
    if (rest.trim()) body = rest;
  }
  if (body.length > MAX_MARKDOWN_SOURCE) {
    return { ok: false, reason: 'File is too large to import.' };
  }

  const title =
    selected?.title ||
    cleanTitleCandidate(frontMatterTitle) ||
    cleanTitleCandidate(titleFromFileName(fileName)) ||
    'Untitled article';
  return { ok: true, title, markdownSource: body };
}

/** A leading `---` … `---` YAML block, read for `title:` only (no YAML parser). */
function splitFrontMatter(text: string): { title: string | null; rest: string } | null {
  const lines = text.split('\n');
  if (lines[0]?.trimEnd() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]!.trimEnd();
    if (l === '---' || l === '...') {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  let title: string | null = null;
  for (const l of lines.slice(1, end)) {
    const m = /^title:(.*)$/.exec(l);
    if (m) {
      title = m[1]!.trim().replace(/^(["'])(.*)\1$/, '$2');
      break;
    }
  }
  return { title, rest: lines.slice(end + 1).join('\n') };
}

function titleFromFileName(fileName: string): string {
  return fileName
    .replace(/\.(md|markdown)$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTitleCandidate(s: string | null): string {
  if (!s) return '';
  return cleanMarkdownTitle(s).slice(0, ARTICLE_TITLE_MAX).trim();
}

/**
 * The slug the API derives from a title when the client sends none.
 * Shared so a client retry can build a free slug the same way.
 */
export function slugifyArticleTitle(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, ARTICLE_SLUG_MAX) || 'untitled'
  );
}

/**
 * Title and slug for the `n`th copy of a title (`n` ≥ 2), used after a
 * `SlugTaken` conflict. Room for the suffix is reserved in both values,
 * so a long title still yields a distinct slug ≤ 80 and a title ≤ 200.
 */
export function suffixedArticleIdentity(title: string, n: number): { title: string; slug: string } {
  const slugSuffix = `-${n}`;
  const base =
    slugifyArticleTitle(title)
      .slice(0, ARTICLE_SLUG_MAX - slugSuffix.length)
      .replace(/-+$/, '') || 'untitled';
  const titleSuffix = ` ${n}`;
  const head = title.slice(0, ARTICLE_TITLE_MAX - titleSuffix.length).trimEnd() || 'Untitled article';
  return { title: `${head}${titleSuffix}`, slug: `${base}${slugSuffix}` };
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
