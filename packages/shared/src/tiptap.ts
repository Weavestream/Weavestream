/**
 * Tiptap document helpers — shared between the API (server-side plaintext
 * extraction, validation) and the web app (editor state round-trip).
 *
 * Tiptap stores content as a ProseMirror-style JSON tree:
 *     { type: 'doc', content: Node[] }
 * Every Node has a `type`, optional `content: Node[]`, `text: string`
 * (for leaf text nodes), and per-type `attrs`. The shapes we care about
 * in Phase 4 are the ones emitted by StarterKit + Link + Image + Table +
 * Task list + Code block + the custom InternalLink mention extension.
 *
 * We deliberately keep the shape permissive: any node type we don't
 * recognise is still walked for `content` / `text` so we never fail
 * closed on unfamiliar extensions. `tiptapToPlaintext` is conservative
 * — each block boundary emits a single `\n`, runs of whitespace are
 * collapsed, and the result is trimmed.
 */

export interface TiptapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface TiptapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  text?: string;
  marks?: TiptapMark[];
}

export interface TiptapDoc {
  type: 'doc';
  content?: TiptapNode[];
}

const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'listItem',
  'bulletList',
  'orderedList',
  'codeBlock',
  'taskList',
  'taskItem',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
  'horizontalRule',
]);

const HARD_BREAK_TYPES = new Set(['hardBreak', 'horizontalRule']);

/**
 * Extract plaintext from a Tiptap document. Returns `''` for empty /
 * missing / malformed docs rather than throwing — callers are happier
 * with an empty excerpt than a 500.
 */
export function tiptapToPlaintext(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const out: string[] = [];
  walk(input as TiptapNode, out);
  return out.join('').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function walk(node: TiptapNode | undefined, out: string[]): void {
  if (!node || typeof node !== 'object') return;

  if (node.type === 'text' && typeof node.text === 'string') {
    out.push(node.text);
    return;
  }

  if (HARD_BREAK_TYPES.has(node.type)) {
    out.push('\n');
    return;
  }

  if (node.type === 'mention' || node.type === 'internalLink') {
    const label = (node.attrs?.['label'] ?? node.attrs?.['title']) as string | undefined;
    if (typeof label === 'string' && label.length > 0) {
      out.push(label);
    }
    return;
  }

  if (node.type === 'image') {
    const alt = node.attrs?.['alt'] as string | undefined;
    if (alt) out.push(alt);
    return;
  }

  const isBlock = BLOCK_TYPES.has(node.type);
  const children = Array.isArray(node.content) ? node.content : [];
  for (const child of children) {
    walk(child, out);
  }
  if (isBlock) out.push('\n');
}

/**
 * Build a minimal Tiptap doc from a plain string. Used when the API
 * receives legacy plain-string writes to a RICH_TEXT field (e.g. from
 * the CLI, or older clients).
 */
export function stringToTiptapDoc(text: string): TiptapDoc {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return {
    type: 'doc',
    content: lines.map(
      (line): TiptapNode => ({
        type: 'paragraph',
        content: line.length > 0 ? [{ type: 'text', text: line }] : [],
      }),
    ),
  };
}

/** Crude character counter for excerpt generation. */
export function tiptapExcerpt(input: unknown, maxChars = 280): string {
  const full = tiptapToPlaintext(input);
  if (full.length <= maxChars) return full;
  const cut = full.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

/**
 * Structural shape check. Does *not* validate every extension — the
 * goal is to reject obviously broken input (non-objects, wrong root
 * type) before it reaches Prisma.
 */
export function isValidTiptapDoc(input: unknown): input is TiptapDoc {
  if (!input || typeof input !== 'object') return false;
  const obj = input as TiptapNode;
  if (obj.type !== 'doc') return false;
  if (obj.content !== undefined && !Array.isArray(obj.content)) return false;
  return true;
}
