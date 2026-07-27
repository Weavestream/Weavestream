import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../lib/api';
import { toOrg, useOrgScope, type Org } from '../lib/org-scope';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { Avatar, ListRow, SectionLabel } from './primitives';
import { EmptyState, ErrorBanner, SkeletonList } from './states';

/**
 * Organization switcher.
 *
 * Two sections, each with an honest contract:
 *
 *  - **Pinned** — the current org plus the caller's starred companies,
 *    from `GET /me/stars`. Fetched separately from the list *because*
 *    `GET /companies` computes `isStarred` only for the page it returns:
 *    a starred org that sorts onto page 3 would silently never appear
 *    under Pinned. `/me/stars` is complete and access-filtered.
 *  - **All** — `GET /companies`, alphabetical, cursor-paginated, deduped
 *    against Pinned.
 *
 * Filtering collapses both into one server-filtered list: pins are for
 * browsing, the filter is for finding.
 *
 * The mock's "Recent" section is **cut**. There is no per-user org
 * recency anywhere server-side (desktop's "Recent companies" widget is
 * global `updatedAt desc`, identical for every operator), and inventing
 * client-side recency would be new state for a section nobody asked for.
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

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function OrgSheet({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  /**
   * Owned by the shell, not this component: switching scope also has to
   * navigate to the current tab's root with the NEW org id stamped, and
   * only the shell knows which tab is showing.
   */
  onSelect: (org: Org) => void;
}) {
  const { currentOrg } = useOrgScope();
  const [filter, setFilter] = useState('');
  const debouncedFilter = useDebounced(filter.trim(), FILTER_DEBOUNCE_MS);
  const isFiltering = debouncedFilter.length > 0;

  // Reset the filter each time the sheet opens — a stale query from last
  // time reads as "these are all my orgs".
  useEffect(() => {
    if (open) setFilter('');
  }, [open]);

  const companies = useInfiniteQuery({
    queryKey: ['companies', { q: debouncedFilter }],
    enabled: open,
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
    enabled: open && !isFiltering,
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
   * the sheet renders an error banner and "No organizations available" at
   * the same time — telling the technician both that something broke and
   * that they have no clients, one of which is a lie.
   */
  const nothingAtAll =
    !loading &&
    !companies.isError &&
    !(stars.isError && !isFiltering) &&
    pinned.length === 0 &&
    rest.length === 0;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Organizations"
    >
      <div className="flex h-[50px] shrink-0 items-center gap-2.5 rounded-field border border-line bg-surface px-3.5 focus-within:border-2 focus-within:border-accent">
        <Icon name="search" size={21} className="text-dim" />
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          // The mock's "Filter 214 organizations" needs a total the
          // endpoint does not return, so the count is dropped.
          placeholder="Filter organizations"
          aria-label="Filter organizations"
          autoCapitalize="none"
          autoCorrect="off"
          className="min-w-0 flex-1 bg-transparent text-body text-text outline-none placeholder:text-dim"
        />
        {filter && (
          <button
            type="button"
            onClick={() => setFilter('')}
            aria-label="Clear filter"
            className="text-dim"
          >
            <Icon name="cancel" size={20} />
          </button>
        )}
      </div>

      {companies.isError && (
        <ErrorBanner
          title="Couldn’t load organizations."
          onRetry={() => {
            void companies.refetch();
            // When both halves failed the cause is almost always the same
            // connection, so one Retry has to fix both — otherwise the
            // pinned block stays broken behind a banner that just vanished.
            if (stars.isError) void stars.refetch();
          }}
        />
      )}

      {/* Surfaced separately, and only when the list itself is fine.
          A silent stars failure makes a technician's pinned clients simply
          vanish, which reads as "my pins are gone" rather than "that request
          failed" — and the rest of the list still works, so this must not
          look like a whole-sheet error.

          Suppressed when the list failed too: the banner above already says
          nothing loaded, and "the full list below is unaffected" would be a
          plain falsehood when there is no list below. */}
      {stars.isError && !companies.isError && !isFiltering && (
        <ErrorBanner
          title="Couldn’t load your pinned organizations."
          detail="The full list below is unaffected."
          onRetry={() => void stars.refetch()}
        />
      )}

      {loading && <SkeletonList rows={5} variant="row" />}

      {nothingAtAll && (
        <EmptyState
          message={
            isFiltering
              ? `No organizations match “${debouncedFilter}”.`
              : 'No organizations available.'
          }
        />
      )}

      {pinned.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <SectionLabel>Pinned</SectionLabel>
          <div className="flex flex-col gap-2">
            {pinned.map((org) => (
              <OrgRow
                key={org.id}
                org={org}
                current={org.id === currentOrg?.id}
                onSelect={onSelect}
              />
            ))}
          </div>
        </section>
      )}

      {rest.length > 0 && (
        <section className="flex flex-col gap-2.5">
          {!isFiltering && pinned.length > 0 && (
            <SectionLabel>All organizations</SectionLabel>
          )}
          <div className="flex flex-col gap-2">
            {rest.map((org) => (
              <OrgRow
                key={org.id}
                org={org}
                current={org.id === currentOrg?.id}
                onSelect={onSelect}
              />
            ))}
          </div>
          {companies.hasNextPage && (
            <button
              type="button"
              onClick={() => void companies.fetchNextPage()}
              disabled={companies.isFetchingNextPage}
              className="h-tap text-body font-semibold text-accent-text disabled:text-dim"
            >
              {companies.isFetchingNextPage ? 'Loading…' : 'Show more'}
            </button>
          )}
        </section>
      )}
    </Sheet>
  );
}

function OrgRow({
  org,
  current,
  onSelect,
}: {
  org: Org;
  current: boolean;
  onSelect: (org: Org) => void;
}) {
  return (
    <ListRow
      minHeight="row"
      metaFont="sans"
      selected={current}
      title={org.name}
      meta={current ? 'Current organization' : org.subtitle}
      leading={
        <Avatar
          initials={org.initials}
          size={44}
          tone={current ? 'accent' : 'neutral'}
        />
      }
      trailing={
        current ? (
          <Icon
            name="check_circle"
            size={24}
            className="text-accent"
            label="Current organization"
          />
        ) : (
          <Icon name="chevron_right" size={22} className="text-faint" />
        )
      }
      onClick={current ? undefined : () => onSelect(org)}
    />
  );
}
