import { useEffect } from 'react';
import { formatDate } from '@weavestream/shared';
import { Icon } from '../../components/Icon';
import { ScreenHeader } from '../../components/ScreenHeader';
import { ListRow, Screen } from '../../components/primitives';
import {
  EmptyState,
  ErrorBanner,
  OfflineBanner,
  SkeletonList,
} from '../../components/states';
import { useOnline } from '../../lib/use-online';
import { useOrgScope } from '../../lib/org-scope';
import { useScopedNavigate } from '../../lib/scoped-nav';
import { deviceTimeZone } from '../../lib/timezone';
import { useOpenOrgSheet } from '../../screens/TabShell';
import { ArticleFilterChips, type ArticleListFilter } from './ArticleFilterChips';
import { rememberListFilter } from './list-filter-memory';
import { useArticleFolders, useArticlesInfinite } from './queries';

/**
 * The articles tab: read-only card list over the cursor-paginated list
 * endpoint. No New button for anyone — articles are read-only on
 * mobile. Filter state lives in the route search (`?folder=`) so
 * back-from-detail lands on the same filtered view; chip taps `replace`
 * so cycling filters doesn't grow history.
 *
 * Three error states, deliberately distinct: a FIRST-load failure gets
 * the full-screen banner; a failed REFETCH of already-loaded pages
 * keeps every row on screen under a "couldn't refresh" banner (TanStack
 * retains the last good pages on a refetch error — hiding them would
 * throw away what the technician already has); a page-2+ failure keeps
 * the rows and swaps the "Show more" footer for an inline retry.
 */
export function ArticlesListScreen({ filter }: { filter: ArticleListFilter }) {
  const { currentOrg, scopeStatus, retry } = useOrgScope();
  const openOrgSheet = useOpenOrgSheet();
  const online = useOnline();
  const navigate = useScopedNavigate();

  const orgId = currentOrg?.id ?? null;
  const listQuery = useArticlesInfinite(orgId, filter.folder);
  const foldersQuery = useArticleFolders(orgId);

  // Feed the detail screen's structural "up" navigation, so returning
  // to the list re-applies the current filter even when history can't
  // be popped (see use-back.ts).
  useEffect(() => {
    if (orgId) rememberListFilter(orgId, filter);
  }, [orgId, filter]);

  const rows = listQuery.data?.pages.flatMap((p) => p.items) ?? [];
  // Three mutually exclusive flags (verified against
  // @tanstack/query-core 5.101.4, infiniteQueryObserver.createResult):
  //  - isLoadingError:      error with NO cached pages → only the full
  //                         banner can stand in for content.
  //  - isRefetchError:      a refetch of already-loaded pages failed;
  //                         TanStack kept the last good data, so keep
  //                         the rows and banner the staleness. Retry is
  //                         refetch(). Excludes page-fetch failures.
  //  - isFetchNextPageError: a genuine next-page failure → the inline
  //                         footer retry; retry is fetchNextPage().
  const pageError = listQuery.isFetchNextPageError;
  const staleError = listQuery.isRefetchError;
  const loadError = listQuery.isLoadingError;

  const emptyMessage = filter.folder
    ? 'No articles in this folder.'
    : 'No articles in this organization yet.';

  const setFilter = (next: ArticleListFilter) =>
    navigate({ to: '/articles', replace: true, search: { ...next } });

  const tz = deviceTimeZone();

  return (
    <>
      <ScreenHeader
        org={currentOrg}
        onOpenOrgSheet={openOrgSheet}
        title="Articles"
        filters={
          scopeStatus === 'ready' && currentOrg && foldersQuery.data ? (
            <ArticleFilterChips
              folders={foldersQuery.data}
              filter={filter}
              onChange={setFilter}
            />
          ) : undefined
        }
      />

      <Screen>
        {!online && <OfflineBanner />}

        {scopeStatus === 'resolving' && <SkeletonList rows={5} />}

        {scopeStatus === 'error' && (
          <ErrorBanner
            title="Couldn’t load your organizations."
            detail="Check your connection and try again."
            onRetry={retry}
          />
        )}

        {scopeStatus === 'ready' && !currentOrg && (
          <EmptyState message="No organizations available. Ask an administrator to give you access to a client." />
        )}

        {scopeStatus === 'ready' && currentOrg && (
          <>
            {listQuery.isPending && <SkeletonList rows={6} />}

            {loadError && (
              <ErrorBanner
                title="Couldn’t load articles."
                detail="Check your connection and try again."
                onRetry={() => void listQuery.refetch()}
              />
            )}

            {staleError && (
              <ErrorBanner
                title="Couldn’t refresh."
                detail="Showing the articles loaded earlier."
                onRetry={() => void listQuery.refetch()}
              />
            )}

            {!listQuery.isPending && !loadError && rows.length === 0 && (
              <EmptyState message={emptyMessage} />
            )}

            {rows.length > 0 && (
              <div className="flex flex-col gap-2">
                {rows.map((a) => (
                  <ListRow
                    key={a.id}
                    title={a.title}
                    metaFont="sans"
                    meta={
                      `Updated ${formatDate(a.updatedAt, tz)}` +
                      (a.updatedByUser ? ` · ${a.updatedByUser.name}` : '')
                    }
                    trailing={
                      <Icon
                        name="chevron_right"
                        size={22}
                        className="shrink-0 text-faint"
                      />
                    }
                    // `upIsBack`: pushed straight from the list, so the
                    // detail's "‹ Articles" may pop history (which also
                    // preserves this exact filtered view).
                    onClick={() => navigate({ to: `/articles/${a.id}`, upIsBack: true })}
                  />
                ))}
              </div>
            )}

            {/* Pagination footer: Show more, or the inline page-error
                retry that keeps loaded rows on screen. */}
            {pageError && (
              <div className="flex items-center justify-center gap-3 py-1">
                <span className="text-body text-muted">Couldn’t load more.</span>
                <button
                  type="button"
                  onClick={() => void listQuery.fetchNextPage()}
                  className="h-tap text-body font-semibold text-accent-text"
                >
                  Retry
                </button>
              </div>
            )}
            {!pageError && listQuery.hasNextPage && (
              <button
                type="button"
                onClick={() => void listQuery.fetchNextPage()}
                disabled={listQuery.isFetchingNextPage}
                className="h-tap text-body font-semibold text-accent-text disabled:text-dim"
              >
                {listQuery.isFetchingNextPage ? 'Loading…' : 'Show more'}
              </button>
            )}
          </>
        )}
      </Screen>
    </>
  );
}
