import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { SearchResponse } from '@weavestream/shared';
import { apiFetch } from '../../lib/api';

/** Design-handoff debounce for the search field (desktop uses 180ms). */
export const SEARCH_DEBOUNCE_MS = 200;

/** Desktop-palette parity: one page of 20, no pagination (`total` is
 *  always null with hits, so there is nothing to paginate against). */
const SEARCH_LIMIT = 20;

/**
 * Only the kinds mobile can open. `upload` and `domain` have no mobile
 * screen, so excluding them server-side beats rendering dead-end rows.
 */
const SEARCH_TYPES = 'password,asset,article';

export const searchKeys = {
  /**
   * First segment `'search'` — never `'org-scope'`/`'me'` — so the org
   * switcher's predicate invalidation evicts results on a switch for
   * free (lib/org-scope.tsx).
   */
  results: (companyId: string | null, q: string) =>
    ['search', companyId, q] as const,
};

/**
 * Current-org search. `companyId` is ALWAYS sent — mobile has no scope
 * toggle by decision (a technician onsite must not copy a credential
 * out of the wrong client's record because a toggle was left on "all").
 * The client-supplied org is a convenience; the server re-derives scope
 * from the session either way.
 */
export function useSearchResults(companyId: string | null, q: string) {
  return useQuery({
    queryKey: searchKeys.results(companyId, q),
    queryFn: ({ signal }) =>
      apiFetch<SearchResponse>(
        `/search?q=${encodeURIComponent(q)}` +
          `&companyId=${encodeURIComponent(companyId!)}` +
          `&types=${SEARCH_TYPES}&limit=${SEARCH_LIMIT}`,
        { signal },
      ),
    enabled: companyId !== null && q.length > 0,
    // Old results hold while the debounced query changes — the list
    // swaps when fresh data lands instead of flashing a skeleton per
    // keystroke.
    placeholderData: keepPreviousData,
  });
}
