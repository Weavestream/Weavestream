import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { toOrg, useOrgScope, type Org } from '../../lib/org-scope';

/**
 * The org directory — data layer shared by the OrgSheet switcher and
 * the Phase 5b launcher. Extracted verbatim from OrgSheet so both
 * surfaces render the SAME contract:
 *
 *  - **Pinned** — the current org (when one is in context; the launcher
 *    has none by construction) plus the caller's starred companies from
 *    `GET /me/stars`. Fetched separately from the list *because*
 *    `GET /companies` computes `isStarred` only for the page it
 *    returns: a starred org that sorts onto page 3 would silently never
 *    appear under Pinned. `/me/stars` is complete and access-filtered.
 *  - **Rest** — `GET /companies`, alphabetical, cursor-paginated,
 *    deduped against Pinned.
 *
 * Filtering collapses both into one server-filtered list: pins are for
 * browsing, the filter is for finding. Authorization is server-side
 * throughout — this hook only arranges what the API already scoped.
 */

const PAGE_SIZE = 50;
const FILTER_DEBOUNCE_MS = 200;

interface CompanyRow {
  id: string;
  name: string;
  archivedAt: string | null;
  type?: string | null;
  city?: string | null;
  region?: string | null;
}

interface StarredCompany {
  type: 'company';
  companyId: string;
  companyName: string;
  archivedAt: string | null;
}

type StarredItem = { type: string } & Record<string, unknown>;

export function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function useOrgDirectory({
  filter,
  enabled,
}: {
  /** Raw filter input; debounced internally. Pass '' for no filtering. */
  filter: string;
  /** Gate both queries (the sheet passes `open`; the launcher `true`). */
  enabled: boolean;
}) {
  const { currentOrg } = useOrgScope();
  const debouncedFilter = useDebounced(filter.trim(), FILTER_DEBOUNCE_MS);
  const isFiltering = debouncedFilter.length > 0;

  const companies = useInfiniteQuery({
    queryKey: ['companies', { q: debouncedFilter }],
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (debouncedFilter) params.set('q', debouncedFilter);
      if (pageParam) params.set('cursor', pageParam);
      return apiFetch<{ items: CompanyRow[]; nextCursor: string | null }>(
        `/companies?${params.toString()}`,
        { signal },
      );
    },
    getNextPageParam: (last) => last.nextCursor,
  });

  // Only needed for the Pinned block, so it does not run while filtering.
  const stars = useQuery({
    queryKey: ['me-stars'],
    enabled: enabled && !isFiltering,
    queryFn: ({ signal }) =>
      apiFetch<{ items: StarredItem[] }>('/me/stars', { signal }),
  });

  const pinned = useMemo<Org[]>(() => {
    if (isFiltering) return [];
    const seen = new Set<string>();
    const out: Org[] = [];
    if (currentOrg) {
      out.push(currentOrg);
      seen.add(currentOrg.id);
    }
    for (const item of stars.data?.items ?? []) {
      if (item.type !== 'company') continue;
      const co = item as unknown as StarredCompany;
      // An archived company is not somewhere to scope the app to, even
      // if the star is still on it.
      if (co.archivedAt !== null) continue;
      if (seen.has(co.companyId)) continue;
      seen.add(co.companyId);
      // `/me/stars` carries no city/region/type for a company, so these
      // rows honestly have no subtitle rather than a fabricated one.
      out.push({
        id: co.companyId,
        name: co.companyName,
        initials: co.companyName
          .trim()
          .split(/\s+/)
          .slice(0, 2)
          .map((w) => w[0] ?? '')
          .join('')
          .toUpperCase(),
        subtitle: null,
      });
    }
    return out;
  }, [currentOrg, stars.data, isFiltering]);

  const rest = useMemo<Org[]>(() => {
    const pinnedIds = new Set(pinned.map((o) => o.id));
    return (companies.data?.pages ?? [])
      .flatMap((p) => p.items)
      .filter((row) => !pinnedIds.has(row.id))
      .map(toOrg);
  }, [companies.data, pinned]);

  // A disabled query reports `isPending` in v5, so the stars half is only
  // consulted while it is actually enabled.
  const starsPending = !isFiltering && stars.isPending && !stars.isError;
  const loading = (companies.isPending && !companies.isError) || starsPending;

  /**
   * "Nothing to show" is only true when nothing *failed*.
   *
   * Without the error guard a failed request reads as an empty result, and
   * the surface renders an error banner and "No organizations available" at
   * the same time — telling the technician both that something broke and
   * that they have no clients, one of which is a lie.
   */
  const nothingAtAll =
    !loading &&
    !companies.isError &&
    !(stars.isError && !isFiltering) &&
    pinned.length === 0 &&
    rest.length === 0;

  return {
    pinned,
    rest,
    loading,
    nothingAtAll,
    isFiltering,
    debouncedFilter,
    companies,
    stars,
  };
}
