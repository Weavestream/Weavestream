import { useEffect, useState } from 'react';
import { OrgRow } from '../features/orgs/OrgRow';
import { useOrgDirectory } from '../features/orgs/use-org-directory';
import { useOrgScope, type Org } from '../lib/org-scope';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { SectionLabel } from './primitives';
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
 *
 * The data layer (queries, pinned/rest assembly, load/empty flags) lives
 * in `features/orgs/use-org-directory` since Phase 5b, shared verbatim
 * with the launcher; this component keeps the sheet chrome + filter.
 */
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

  // Reset the filter each time the sheet opens — a stale query from last
  // time reads as "these are all my orgs".
  useEffect(() => {
    if (open) setFilter('');
  }, [open]);

  const {
    pinned,
    rest,
    loading,
    nothingAtAll,
    isFiltering,
    debouncedFilter,
    companies,
    stars,
  } = useOrgDirectory({ filter, enabled: open });

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
