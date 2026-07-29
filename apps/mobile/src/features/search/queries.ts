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
   * free (lib/org-scope.tsx). Global (cross-org) results key on
   * `companyId: null`, distinct from every UUID key by construction.
   */
  results: (companyId: string | null, q: string) =>
    ['search', companyId, q] as const,
};

/**
 * Search, scoped by surface:
 *
 *  - **In an org** `companyId` is ALWAYS sent — inside a client there is
 *    still no scope toggle, by decision (a technician onsite must not
 *    copy a credential out of the wrong client's record because a
 *    toggle was left on "all").
 *  - **On the launcher** (Phase 5b) `companyId` is null and the param is
 *    omitted: the server derives the actor's accessible organizations
 *    at the query layer (`allowedCompanyIds` / global access) — the
 *    deliberate, launcher-scoped reversal of the current-org-only cut.
 *
 * Either way the client-supplied scope is a convenience; the server
 * re-derives authorization from the session.
 */
export function useSearchResults(
  companyId: string | null,
  q: string,
  opts?: {
    /**
     * Scope settledness, supplied by the screen. In org mode this is
     * "scope ready AND an org selected" — without it, a null id during
     * boot resolution would fire a GLOBAL query from the in-org screen
     * and flash cross-org rows. Global mode passes true (null scope IS
     * the settled scope there).
     */
    ready?: boolean;
  },
) {
  const ready = opts?.ready ?? true;
  return useQuery({
    queryKey: searchKeys.results(companyId, q),
    queryFn: ({ signal }) =>
      apiFetch<SearchResponse>(
        `/search?q=${encodeURIComponent(q)}` +
          (companyId ? `&companyId=${encodeURIComponent(companyId)}` : '') +
          `&types=${SEARCH_TYPES}&limit=${SEARCH_LIMIT}`,
        { signal },
      ),
    enabled: ready && q.length > 0,
    // Old results hold while the debounced query changes — the list
    // swaps when fresh data lands instead of flashing a skeleton per
    // keystroke.
    placeholderData: keepPreviousData,
  });
}
