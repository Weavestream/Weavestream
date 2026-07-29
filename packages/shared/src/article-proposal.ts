import { applyArticleTextEdits, type ArticleTextEdit } from './article-patch.js';
import { tiptapDocToMarkdown } from './tiptap-markdown.js';

/**
 * Pure helpers for AI article-write proposal cards, shared by the
 * desktop chat panel and the mobile Ask overlay (Phase 5b). Everything
 * here is DOM-free presentation LOGIC — the diff/preview rendering
 * itself stays per-app. Promoted from
 * `apps/web/src/components/chat-panel/` so both clients run one
 * lifecycle ladder instead of drifting copies (CLAUDE.md: never copy a
 * helper across app boundaries).
 */

// ---------------------------------------------------------------------
// Line diff
// ---------------------------------------------------------------------

export type DiffOp =
  | { kind: 'same'; text: string }
  | { kind: 'add'; text: string }
  | { kind: 'del'; text: string };

/**
 * Budget for the LCS table, in cells ((a+1)·(b+1)). The table is
 * O(rows·cols) time AND memory; stored article bodies reach 500 KB
 * (`MAX_MARKDOWN_SOURCE`), and a newline-heavy body at that size would
 * allocate hundreds of billions of cells — a guaranteed freeze/OOM on a
 * phone and a bad time on desktop too. 2048² cells comfortably covers
 * the ~2 000-line bodies the original desktop implementation's comment
 * already called fine; anything larger falls back to a full-body
 * preview (`computeLineDiff` returns null).
 */
export const DIFF_MAX_CELLS = 2048 * 2048;

/**
 * Line-based LCS diff, bounded: returns `null` when the input exceeds
 * `DIFF_MAX_CELLS` — callers render a full-body preview with an
 * explicit "too large to diff" note instead of hanging the tab.
 */
export function computeLineDiff(a: string[], b: string[]): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > DIFF_MAX_CELLS) return null;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i]![j] = (dp[i + 1]![j + 1] ?? 0) + 1;
      else dp[i]![j] = Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      ops.push({ kind: 'del', text: a[i]! });
      i++;
    } else {
      ops.push({ kind: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ kind: 'del', text: a[i++]! });
  while (j < m) ops.push({ kind: 'add', text: b[j++]! });
  return ops;
}

// ---------------------------------------------------------------------
// Patch preview ladder
// ---------------------------------------------------------------------

export type PatchSource =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; markdown: string; revision: number; isRichText: boolean }
  | { status: 'error'; message: string };

export type PatchPreview =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; before: string; markdown: string };

/**
 * The client-side lifecycle ladder for a `patch_article` (or
 * revision-guarded `update_article`) proposal: every rung either
 * produces a previewable before/after pair or a message explaining why
 * Apply must stay disabled. "Never apply a proposal the user cannot
 * preview" is enforced by gating Apply on `status === 'ready'`.
 */
export function buildPatchPreview(
  source: PatchSource,
  baseRevision: number | null | undefined,
  proposedTitle: string | undefined,
  rawEdits: ArticleTextEdit[] | undefined,
): PatchPreview {
  if (source.status === 'loading') return { status: 'loading' };
  if (source.status === 'idle') {
    return {
      status: 'error',
      message: 'The target article is unavailable for preview.',
    };
  }
  if (source.status === 'error') return source;
  if (typeof baseRevision !== 'number') {
    return {
      status: 'error',
      message: 'This proposal was not based on a confirmed article revision.',
    };
  }
  if (source.revision !== baseRevision) {
    return {
      status: 'error',
      message:
        'The article changed after this proposal was drafted. Ask the assistant to redo the edit.',
    };
  }
  if (rawEdits === undefined) {
    if (proposedTitle === undefined) {
      return { status: 'error', message: 'The proposed edit does not contain any changes.' };
    }
    return {
      status: 'ready',
      before: source.markdown,
      markdown: source.markdown,
    };
  }
  if (
    !Array.isArray(rawEdits) ||
    rawEdits.length === 0 ||
    rawEdits.some(
      (edit) =>
        !edit ||
        typeof edit.old_text !== 'string' ||
        !edit.old_text ||
        typeof edit.new_text !== 'string',
    )
  ) {
    return { status: 'error', message: 'The proposed edit is malformed.' };
  }
  const patched = applyArticleTextEdits(source.markdown, rawEdits);
  if (!patched.ok) {
    return {
      status: 'error',
      message:
        patched.code === 'not_found'
          ? `Edit ${patched.editIndex + 1} no longer matches the article text.`
          : `Edit ${patched.editIndex + 1} matches more than one passage. Ask the assistant to include more surrounding text.`,
    };
  }
  return {
    status: 'ready',
    before: source.markdown,
    markdown: patched.markdown,
  };
}

// ---------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------

/**
 * Whether an `update_article` (rewrite) proposal targets an article id the
 * model could not legitimately have known this turn — in which case the
 * card routes it through the Save-as-article (create) flow instead of an
 * inline edit.
 *
 * A rewrite is "hallucinated" only when its target is BOTH:
 *   - not the current page and not an @-mentioned article
 *     (absent from `knownArticleIds`), AND
 *   - carrying no server-captured basis (`baseRevision` is not a number).
 *
 * The basis check is load-bearing (F2): an article read via `get_article`
 * in a freeform tab is neither the current page nor an @-mention, yet the
 * server DID capture its revision — so it is a real, resolvable edit
 * target. Treating it as a create there proposed a brand-new article
 * instead of editing the one the user asked about.
 */
export function isRewriteTargetHallucinated(input: {
  isRewrite: boolean;
  targetArticleId: string | null;
  knownArticleIds: ReadonlySet<string>;
  baseRevision: number | null | undefined;
}): boolean {
  return (
    input.isRewrite &&
    !!input.targetArticleId &&
    !input.knownArticleIds.has(input.targetArticleId) &&
    typeof input.baseRevision !== 'number'
  );
}

// ---------------------------------------------------------------------
// Article → preview source
// ---------------------------------------------------------------------

/**
 * The one branch both clients need when a fetched article becomes a
 * diff base: markdown from whichever column the editor mode populates
 * (mirroring the server-side apply path exactly, so the previewed text
 * IS the text edits run against), plus the rich-text flag that drives
 * the "applying converts this article to Markdown" warning.
 */
export function proposalBaseFromArticle(article: {
  editorMode: string;
  markdownSource: string | null;
  content?: unknown;
  revision: number;
}): { markdown: string; revision: number; isRichText: boolean } {
  return {
    markdown:
      article.editorMode === 'markdown'
        ? (article.markdownSource ?? '')
        : tiptapDocToMarkdown(article.content),
    revision: article.revision,
    isRichText: article.editorMode !== 'markdown',
  };
}

// ---------------------------------------------------------------------
// Folder tree flattening
// ---------------------------------------------------------------------

export interface FolderTreeNode {
  id: string;
  name: string;
  children: FolderTreeNode[];
}

export type FlatFolder = { id: string; name: string; depth: number };

/**
 * Depth-first flatten of a folder tree for a single-level select —
 * indentation is the caller's presentation choice, driven by `depth`.
 */
export function flattenFolderTree(nodes: FolderTreeNode[], depth = 0): FlatFolder[] {
  const out: FlatFolder[] = [];
  for (const n of nodes) {
    out.push({ id: n.id, name: n.name, depth });
    if (n.children.length > 0) {
      out.push(...flattenFolderTree(n.children, depth + 1));
    }
  }
  return out;
}
