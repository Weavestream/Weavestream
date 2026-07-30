/**
 * Server-safe Tiptap → GitHub-flavored Markdown projection.
 *
 * The web app already converts Tiptap docs to markdown for editor mode
 * switching (`apps/web/src/lib/article-format.ts`), but that path is
 * browser-bound: it round-trips through `@tiptap/html` + turndown and
 * needs `DOMParser` for its table normalisation. This module is the
 * server-side equivalent for the AI chat's `get_article` tool: a pure
 * JSON walker in the style of `tiptapToPlaintext` — no Tiptap engine,
 * no DOM, no dependencies.
 *
 * Coverage is the article editor's node/mark set (StarterKit + Link +
 * Image + Table + Task list + Code block + the InternalLink mention).
 * Best-effort by design, same bar the web converter documents: any
 * node type we don't recognise degrades to its plaintext content
 * rather than failing closed.
 */

import type { TiptapMark, TiptapNode } from './tiptap.js';
import { tiptapToPlaintext } from './tiptap.js';

/**
 * Convert a Tiptap document (or any node subtree) to GFM markdown.
 * Returns `''` for empty / missing / malformed docs rather than
 * throwing — callers prefer an empty body over a 500.
 */
export function tiptapDocToMarkdown(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const doc = input as TiptapNode;
  const content = Array.isArray(doc.content) ? doc.content : [];
  return renderBlocks(content)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ----------------------------------------------------------------------
// Block-level rendering
// ----------------------------------------------------------------------

function renderBlocks(nodes: TiptapNode[]): string {
  const out: string[] = [];
  for (const node of nodes) {
    const rendered = renderBlock(node);
    if (rendered.length > 0) out.push(rendered);
  }
  return out.join('\n\n');
}

function renderBlock(node: TiptapNode): string {
  if (!node || typeof node !== 'object') return '';
  switch (node.type) {
    case 'paragraph':
      return renderInline(node.content ?? []);
    case 'heading': {
      const level = clampInt(node.attrs?.['level'], 1, 6, 1);
      return `${'#'.repeat(level)} ${renderInline(node.content ?? [])}`;
    }
    case 'bulletList':
      return renderList(node, () => '- ');
    case 'orderedList': {
      const start = clampInt(node.attrs?.['start'], 1, Number.MAX_SAFE_INTEGER, 1);
      return renderList(node, (i) => `${start + i}. `);
    }
    case 'taskList':
      return renderList(node, (_, item) =>
        item.attrs?.['checked'] === true ? '- [x] ' : '- [ ] ',
      );
    case 'blockquote':
      return renderBlocks(node.content ?? [])
        .split('\n')
        .map((line) => (line.length > 0 ? `> ${line}` : '>'))
        .join('\n');
    case 'codeBlock': {
      const language = fenceInfoString(node.attrs?.['language']);
      // Raw text, no inline mark processing inside a code fence.
      const code = (node.content ?? [])
        .map((c) => (typeof c.text === 'string' ? c.text : ''))
        .join('');
      return `\`\`\`${language}\n${code}\n\`\`\``;
    }
    case 'horizontalRule':
      return '---';
    case 'table':
      return renderTable(node);
    case 'image':
      return renderImage(node);
    default: {
      // Unknown block: degrade to plaintext content so unfamiliar
      // extensions never fail closed (mirrors tiptapToPlaintext).
      return tiptapToPlaintext(node);
    }
  }
}

/**
 * A code block's `language` attribute, reduced to something that cannot
 * escape the fence line it is interpolated into.
 *
 * The attribute is author-controlled and was previously written through
 * verbatim, so a language of `"js\n\n# Heading"` injected markdown into
 * the projection — which the company PDF export then parsed as real
 * headings. Backticks are stripped for the same reason in the other
 * direction: CommonMark forbids them in a backtick fence's info string,
 * so leaving one in produces a line that this walker calls a fence and
 * every conformant parser calls a paragraph.
 *
 * Kept conservative rather than clever: a real language identifier is a
 * short run of `[a-z0-9+#._-]`, and anything else is not worth
 * round-tripping.
 */
function fenceInfoString(value: unknown): string {
  if (typeof value !== 'string') return '';
  const first = value.trim().split(/\s/, 1)[0] ?? '';
  const cleaned = first.toLowerCase().replace(/[^a-z0-9+#._-]/g, '');
  // Rejected rather than truncated: a 200-character "language" is not a
  // language, and slicing one would invent a plausible-looking fake.
  return cleaned.length > 0 && cleaned.length <= 24 ? cleaned : '';
}

/**
 * Render a bullet / ordered / task list. The marker callback receives
 * the item index and the item node (task items carry `checked`).
 * Continuation lines (nested lists, extra paragraphs) are indented to
 * the marker width so GFM keeps them inside the item.
 */
function renderList(
  list: TiptapNode,
  markerFor: (index: number, item: TiptapNode) => string,
): string {
  const items = (list.content ?? []).filter(
    (n) => n.type === 'listItem' || n.type === 'taskItem',
  );
  const lines: string[] = [];
  items.forEach((item, index) => {
    const marker = markerFor(index, item);
    const indent = ' '.repeat(marker.length);
    const body = renderBlocks(item.content ?? []);
    const bodyLines = body.split('\n');
    bodyLines.forEach((line, lineIndex) => {
      if (lineIndex === 0) lines.push(`${marker}${line}`);
      else lines.push(line.length > 0 ? `${indent}${line}` : '');
    });
  });
  return lines.join('\n');
}

/**
 * GFM table. A header row is mandatory in GFM, so when no row contains
 * a `tableHeader` cell the first row is promoted — the same
 * normalisation the web converter applies before turndown.
 */
function renderTable(table: TiptapNode): string {
  const rows = (table.content ?? []).filter((n) => n.type === 'tableRow');
  if (rows.length === 0) return '';

  const cellsOf = (row: TiptapNode): string[] =>
    (row.content ?? [])
      .filter((n) => n.type === 'tableHeader' || n.type === 'tableCell')
      .map(renderTableCell);

  const rendered = rows.map(cellsOf);
  const width = Math.max(...rendered.map((cells) => cells.length), 1);
  const pad = (cells: string[]): string[] => {
    while (cells.length < width) cells.push('');
    return cells;
  };
  const line = (cells: string[]): string => `| ${pad(cells).join(' | ')} |`;

  const [header, ...body] = rendered as [string[], ...string[][]];
  const separator = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`;
  return [line(header), separator, ...body.map(line)].join('\n');
}

/**
 * A table cell as a single line: paragraphs joined with `<br>`,
 * backslashes and pipes escaped, embedded newlines flattened — multi-line
 * cells break GFM table grammar.
 */
function renderTableCell(cell: TiptapNode): string {
  const parts = (cell.content ?? [])
    .map((child) =>
      child.type === 'paragraph'
        ? renderInline(child.content ?? [])
        : renderBlock(child),
    )
    .filter((p) => p.length > 0);
  return parts.join('<br>').replace(/\n/g, '<br>').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function renderImage(node: TiptapNode): string {
  const src = typeof node.attrs?.['src'] === 'string' ? (node.attrs['src'] as string) : '';
  const alt = typeof node.attrs?.['alt'] === 'string' ? (node.attrs['alt'] as string) : '';
  if (!src) return alt;
  return `![${alt}](${src})`;
}

// ----------------------------------------------------------------------
// Inline rendering
// ----------------------------------------------------------------------

function renderInline(nodes: TiptapNode[]): string {
  const out: string[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'text' && typeof node.text === 'string') {
      out.push(applyMarks(node.text, node.marks ?? []));
      continue;
    }
    switch (node.type) {
      case 'hardBreak':
        out.push('  \n');
        break;
      case 'image':
        out.push(renderImage(node));
        break;
      case 'mention':
      case 'internalLink': {
        const label = (node.attrs?.['label'] ?? node.attrs?.['title']) as
          | string
          | undefined;
        if (typeof label === 'string' && label.length > 0) out.push(label);
        break;
      }
      default:
        // Unknown inline: plaintext content, never dropped silently.
        out.push(tiptapToPlaintext(node));
    }
  }
  return out.join('');
}

/**
 * Apply text marks. A `code` mark wins outright — GFM code spans don't
 * nest styling. Otherwise styling nests innermost-to-outermost as
 * strike → italic → bold, with a link wrapping everything.
 */
function applyMarks(text: string, marks: TiptapMark[]): string {
  if (text.length === 0) return text;
  const has = (type: string): TiptapMark | undefined =>
    marks.find((m) => m.type === type);

  let out = text;
  if (has('code')) {
    out = `\`${out}\``;
  } else {
    if (has('strike')) out = `~~${out}~~`;
    if (has('italic')) out = `*${out}*`;
    if (has('bold')) out = `**${out}**`;
  }
  const link = has('link');
  const href = typeof link?.attrs?.['href'] === 'string' ? (link.attrs['href'] as string) : '';
  if (href) out = `[${out}](${href})`;
  return out;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
