/**
 * Stacked search terms on the asset lists (discussion #99). Each term is
 * one `q` value in the URL (`?q=dell&q=10.2.4`) and one pill in the UI;
 * the API returns only assets that match every term.
 */

/** The distinct, non-blank terms in a `q` search param, in URL order. */
export function parseSearchTerms(value: string | string[] | undefined): string[] {
  let out: string[] = [];
  for (const raw of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
    out = withSearchTerm(out, raw) ?? out;
  }
  return out;
}

/**
 * `terms` plus `draft`, or null when the draft is blank or is already a
 * term (ignoring letter case), so the caller has nothing to push.
 */
export function withSearchTerm(terms: readonly string[], draft: string): string[] | null {
  const term = draft.trim();
  if (!term) return null;
  const key = term.toLowerCase();
  if (terms.some((t) => t.toLowerCase() === key)) return null;
  return [...terms, term];
}

/**
 * True when a change edits a search that is already active: terms are
 * added to or removed from a non-empty list. The list then replaces the
 * current history entry instead of adding one, so 1 search is 1 history
 * step and Back removes the whole search, not its last term only.
 */
export function editsActiveSearch(
  current: readonly string[],
  next: readonly string[],
): boolean {
  if (current.length === 0) return false;
  return current.length !== next.length || current.some((t, i) => t !== next[i]);
}
