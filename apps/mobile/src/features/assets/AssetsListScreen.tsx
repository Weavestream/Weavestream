import { useEffect, useMemo } from 'react';
import { Icon } from '../../components/Icon';
import { ScreenHeader } from '../../components/ScreenHeader';
import { Screen } from '../../components/primitives';
import {
  EmptyState,
  ErrorBanner,
  OfflineBanner,
  SkeletonList,
} from '../../components/states';
import { useOnline } from '../../lib/use-online';
import { useOrgScope } from '../../lib/org-scope';
import { useScopedNavigate } from '../../lib/scoped-nav';
import { useCompanyAccess } from '../../lib/use-company-access';
import { deviceTimeZone } from '../../lib/timezone';
import { useOpenOrgSheet } from '../../screens/TabShell';
import { AssetFilterChips, type AssetListFilter } from './AssetFilterChips';
import { AssetRow } from './AssetRow';
import { rememberListFilter } from './list-filter-memory';
import { useAssetCounts, useAssetsInfinite, useLayouts } from './queries';
import type { LayoutRecord } from './api';

/**
 * The assets tab: card list over the cursor-paginated list endpoint,
 * active assets only (the archived list view was cut — archived assets
 * stay reachable by direct link and render with the detail banner).
 * Filter state (`?layout=`) rides the route search so back-from-detail
 * restores the filtered view; chip taps `replace` so cycling doesn't
 * grow history.
 *
 * The card meta line needs the layouts join (`showInTable`/`position`
 * live only on GET /layouts). Layouts/counts query failures must never
 * blank the list: chips simply don't render (layouts missing) or render
 * uncounted (counts missing), and rows degrade to primary-field meta.
 *
 * Error states mirror the articles list exactly — see its comment for
 * the three mutually exclusive flags.
 */
export function AssetsListScreen({ filter }: { filter: AssetListFilter }) {
  const { currentOrg, scopeStatus, retry } = useOrgScope();
  const openOrgSheet = useOpenOrgSheet();
  const online = useOnline();
  const navigate = useScopedNavigate();
  const { canWrite, isClientUser } = useCompanyAccess();
  const canManage = canWrite && !isClientUser;

  const orgId = currentOrg?.id ?? null;
  const listQuery = useAssetsInfinite(orgId, filter.layout);
  const layoutsQuery = useLayouts();
  const countsQuery = useAssetCounts(orgId);

  useEffect(() => {
    if (orgId) rememberListFilter(orgId, filter);
  }, [orgId, filter]);

  const rows = listQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const pageError = listQuery.isFetchNextPageError;
  const staleError = listQuery.isRefetchError;
  const loadError = listQuery.isLoadingError;

  const layoutById = useMemo(() => {
    const map = new Map<string, LayoutRecord>();
    for (const l of layoutsQuery.data ?? []) map.set(l.id, l);
    return map;
  }, [layoutsQuery.data]);

  const emptyMessage = filter.layout
    ? 'No assets in this layout.'
    : 'No assets in this organization yet.';

  const setFilter = (next: AssetListFilter) =>
    navigate({ to: '/assets', replace: true, search: { ...next } });

  const tz = deviceTimeZone();

  return (
    <>
      <ScreenHeader
        org={currentOrg}
        onOpenOrgSheet={openOrgSheet}
        title="Assets"
        onSearch={() => navigate({ to: '/search', upIsBack: true })}
        action={
          scopeStatus === 'ready' && currentOrg && canManage ? (
            <button
              type="button"
              onClick={() => navigate({ to: '/assets/new', upIsBack: true })}
              className={
                'flex h-[42px] shrink-0 items-center gap-1.75 rounded-pill ' +
                'bg-accent-fill px-[15px] text-[15px] font-semibold text-accent-fill-ink ' +
                'active:bg-accent-pressed'
              }
            >
              <Icon name="add" size={20} />
              New
            </button>
          ) : undefined
        }
        filters={
          scopeStatus === 'ready' && currentOrg && layoutsQuery.data ? (
            <AssetFilterChips
              layouts={layoutsQuery.data}
              counts={countsQuery.data}
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
                title="Couldn’t load assets."
                detail="Check your connection and try again."
                onRetry={() => void listQuery.refetch()}
              />
            )}

            {staleError && (
              <ErrorBanner
                title="Couldn’t refresh."
                detail="Showing the assets loaded earlier."
                onRetry={() => void listQuery.refetch()}
              />
            )}

            {!listQuery.isPending && !loadError && rows.length === 0 && (
              <EmptyState message={emptyMessage} />
            )}

            {rows.length > 0 && (
              <div className="flex flex-col gap-2">
                {rows.map((a) => (
                  <AssetRow
                    key={a.id}
                    asset={a}
                    layout={layoutById.get(a.assetLayoutId)}
                    tz={tz}
                    onOpen={() => navigate({ to: `/assets/${a.id}`, upIsBack: true })}
                  />
                ))}
              </div>
            )}

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
