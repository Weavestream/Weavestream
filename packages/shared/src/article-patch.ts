export const MAX_ARTICLE_PATCH_EDITS = 12;
export const MAX_ARTICLE_PATCH_CHARS = 100_000;

export type ArticleTextEdit = {
  old_text: string;
  new_text: string;
};

export type ArticlePatchFailureCode = 'not_found' | 'ambiguous';

export type ArticlePatchResult =
  | { ok: true; markdown: string }
  | {
      ok: false;
      code: ArticlePatchFailureCode;
      /** Zero-based index of the edit that could not be applied. */
      editIndex: number;
    };

/**
 * Apply exact search-and-replace edits in order without fuzzy matching.
 * Every old_text must match exactly once in the document produced by the
 * preceding edit. A failure returns without exposing a partially edited body.
 */
export function applyArticleTextEdits(
  markdown: string,
  edits: readonly ArticleTextEdit[],
): ArticlePatchResult {
  let next = markdown;

  for (let editIndex = 0; editIndex < edits.length; editIndex++) {
    const edit = edits[editIndex]!;
    const first = next.indexOf(edit.old_text);
    if (first === -1) return { ok: false, code: 'not_found', editIndex };

    // Resume at first + 1, not first + old_text.length: occurrences that
    // OVERLAP the first (e.g. `----` inside `------`) must still count as
    // a second match, or the "occurs exactly once" guarantee is defeated
    // and the leftmost run is silently replaced instead of returning
    // `ambiguous`.
    const second = next.indexOf(edit.old_text, first + 1);
    if (second !== -1) return { ok: false, code: 'ambiguous', editIndex };

    next = `${next.slice(0, first)}${edit.new_text}${next.slice(first + edit.old_text.length)}`;
  }

  return { ok: true, markdown: next };
}

export function articlePatchPayloadChars(edits: readonly ArticleTextEdit[]): number {
  return edits.reduce((total, edit) => total + edit.old_text.length + edit.new_text.length, 0);
}

/**
 * Aggregate old_text + new_text length over a RAW, still-untrusted edits
 * value, before field-level Zod validation. Non-array input and
 * non-string fields contribute 0 (the schema parse rejects those on its
 * own). This lets the apply path enforce the {@link MAX_ARTICLE_PATCH_CHARS}
 * aggregate as the FIRST gate: the per-field max is itself
 * `MAX_ARTICLE_PATCH_CHARS`, so up to `MAX_ARTICLE_PATCH_EDITS` edits
 * would otherwise let Zod validate megabytes of field content before the
 * aggregate guard fires — and the strict tool JSON-schema converter
 * cannot express a cross-field sum (`.refine` is unsupported).
 */
export function rawArticlePatchPayloadChars(edits: unknown): number {
  if (!Array.isArray(edits)) return 0;
  let total = 0;
  for (const edit of edits) {
    if (edit && typeof edit === 'object') {
      const { old_text, new_text } = edit as { old_text?: unknown; new_text?: unknown };
      if (typeof old_text === 'string') total += old_text.length;
      if (typeof new_text === 'string') total += new_text.length;
    }
  }
  return total;
}
