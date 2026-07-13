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

    const second = next.indexOf(edit.old_text, first + edit.old_text.length);
    if (second !== -1) return { ok: false, code: 'ambiguous', editIndex };

    next = `${next.slice(0, first)}${edit.new_text}${next.slice(first + edit.old_text.length)}`;
  }

  return { ok: true, markdown: next };
}

export function articlePatchPayloadChars(edits: readonly ArticleTextEdit[]): number {
  return edits.reduce((total, edit) => total + edit.old_text.length + edit.new_text.length, 0);
}
