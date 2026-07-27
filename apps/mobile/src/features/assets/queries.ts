import { useMutation, useQuery, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import type { CreateAssetInput, UpdateAssetInput } from '@weavestream/shared';
import { UUID_RE } from '../../lib/uuid';
import {
  archiveAsset,
  createAsset,
  fetchAssetCountsByLayout,
  fetchAssetCredentials,
  fetchAssetDetail,
  fetchAssetsPage,
  fetchLayout,
  fetchLayouts,
  restoreAsset,
  updateAsset,
  type AssetRecord,
  type AssetsPage,
} from './api';

/**
 * Query wiring for the assets feature (Phase 2c).
 *
 * Key discipline matches passwords/articles: everything asset-shaped
 * lives under the `['assets', companyId]` prefix — one invalidation
 * covers list, detail, counts, and credentials, and the org switcher's
 * predicate invalidation evicts it all on a switch.
 *
 * Layouts are global (org-independent) and keyed top-level, but they
 * are deliberately NOT exempted from org-switch eviction — the
 * predicate in org-scope.tsx exists so new features never have to
 * register themselves, and the `['settings']` precedent accepts the
 * same one-refetch waste. `staleTime` caps it.
 */

export const assetKeys = {
  all: (companyId: string | null) => ['assets', companyId] as const,
  list: (companyId: string | null, layoutId?: string) =>
    ['assets', companyId, 'list', layoutId ?? null] as const,
  detail: (companyId: string | null, assetId: string) =>
    ['assets', companyId, 'detail', assetId] as const,
  counts: (companyId: string | null) => ['assets', companyId, 'counts'] as const,
  credentials: (companyId: string | null, assetId: string) =>
    ['assets', companyId, 'credentials', assetId] as const,
};

export const layoutKeys = {
  list: ['layouts', 'list'] as const,
  detail: (layoutId: string) => ['layouts', 'detail', layoutId] as const,
};

const LAYOUT_STALE_MS = 5 * 60_000;

export function useAssetsInfinite(companyId: string | null, layoutId?: string) {
  return useInfiniteQuery({
    queryKey: assetKeys.list(companyId, layoutId),
    queryFn: ({ pageParam, signal }) =>
      fetchAssetsPage(companyId!, { layoutId, cursor: pageParam, signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: AssetsPage) => last.nextCursor,
    enabled: companyId !== null,
  });
}

export function useAssetDetail(companyId: string | null, assetId: string) {
  return useQuery({
    queryKey: assetKeys.detail(companyId, assetId),
    queryFn: () => fetchAssetDetail(companyId!, assetId),
    // The UUID guard belongs to the screen's wrapper; `enabled` re-states
    // it so a future caller can't fire a guaranteed-400 request.
    enabled: companyId !== null && UUID_RE.test(assetId),
  });
}

export function useAssetCounts(companyId: string | null) {
  return useQuery({
    queryKey: assetKeys.counts(companyId),
    queryFn: () => fetchAssetCountsByLayout(companyId!),
    enabled: companyId !== null,
  });
}

/**
 * The asset's linked credentials (`Password.assetId`), active slice
 * only — the endpoint includes archived rows because the archive
 * cascade flips them, and the detail screen's Related section must not
 * offer an archived credential.
 */
export function useAssetCredentials(companyId: string | null, assetId: string) {
  return useQuery({
    queryKey: assetKeys.credentials(companyId, assetId),
    queryFn: () => fetchAssetCredentials(companyId!, assetId),
    select: (rows) => rows.filter((p) => p.archivedAt === null),
    enabled: companyId !== null && UUID_RE.test(assetId),
  });
}

export function useLayouts() {
  return useQuery({
    queryKey: layoutKeys.list,
    queryFn: fetchLayouts,
    staleTime: LAYOUT_STALE_MS,
  });
}

/** Serves archived layouts too — assets on retired layouts stay editable. */
export function useLayout(layoutId: string | null) {
  return useQuery({
    queryKey: layoutKeys.detail(layoutId ?? ''),
    queryFn: () => fetchLayout(layoutId!),
    staleTime: LAYOUT_STALE_MS,
    enabled: layoutId !== null && UUID_RE.test(layoutId),
  });
}

// ─── Mutations ─────────────────────────────────────────────────────

// Mutation hooks accept `string | null` because they mount before the
// org scope resolves; the non-null assertions hold because every
// trigger only renders under a resolved org.
//
// Every mutation returns the COMPLETE detail shape (all four service
// methods end with `return this.get(...)`, provenance included), so
// seeding the detail key is safe — unlike passwords, whose archive
// returns a summary. Cross-feature invalidations use raw key literals:
// importing passwordKeys/relation keys would break feature isolation.
//
//  - `['relations', companyId]`: an ASSET_REFERENCE write syncs
//    Relation rows inside the asset-write transaction, and
//    archive/restore change which counterparts other entities' Related
//    sections may show (archived counterparts are filtered
//    server-side). Whole-prefix, so counterpart screens heal too.
//  - `['passwords', companyId]` (archive/restore only): the archive
//    cascade flips linked credentials' archivedAt server-side.

function invalidateAfterWrite(
  queryClient: ReturnType<typeof useQueryClient>,
  companyId: string | null,
) {
  void queryClient.invalidateQueries({ queryKey: assetKeys.all(companyId) });
  void queryClient.invalidateQueries({ queryKey: ['relations', companyId] });
}

export function useCreateAsset(companyId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAssetInput) => createAsset(companyId!, input),
    onSuccess: (detail: AssetRecord) => {
      queryClient.setQueryData(assetKeys.detail(companyId, detail.id), detail);
      invalidateAfterWrite(queryClient, companyId);
    },
  });
}

export function useUpdateAsset(companyId: string | null, assetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAssetInput) =>
      updateAsset(companyId!, assetId, input),
    onSuccess: (detail: AssetRecord) => {
      queryClient.setQueryData(assetKeys.detail(companyId, assetId), detail);
      invalidateAfterWrite(queryClient, companyId);
    },
  });
}

export function useArchiveAsset(companyId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (assetId: string) => archiveAsset(companyId!, assetId),
    onSuccess: (detail: AssetRecord) => {
      queryClient.setQueryData(assetKeys.detail(companyId, detail.id), detail);
      invalidateAfterWrite(queryClient, companyId);
      void queryClient.invalidateQueries({ queryKey: ['passwords', companyId] });
    },
  });
}

export function useRestoreAsset(companyId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (assetId: string) => restoreAsset(companyId!, assetId),
    onSuccess: (detail: AssetRecord) => {
      queryClient.setQueryData(assetKeys.detail(companyId, detail.id), detail);
      invalidateAfterWrite(queryClient, companyId);
      void queryClient.invalidateQueries({ queryKey: ['passwords', companyId] });
    },
  });
}
