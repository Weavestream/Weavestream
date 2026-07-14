/**
 * Pure classification helpers for AI article-write proposals, extracted
 * from `ToolCallCard` so the create-vs-edit decision can be unit-tested.
 */

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
