import { cache } from 'react';
import type { AssetPage, AssetSummary } from '@weavestream/shared';
import { unwrapApiResponse } from '../api-errors';
import { serverApiFetch } from './core';

// ───────────────────────────────────────────────────────────────────
// Phase 3: assets
// ───────────────────────────────────────────────────────────────────

export async function listAssets(
  companyId: string,
  params: {
    layoutId?: string;
    q?: string;
    includeArchived?: boolean;
    fieldFilters?: Record<string, string>;
    limit?: number;
    cursor?: string;
  } = {},
): Promise<AssetPage> {
  const q = new URLSearchParams();
  if (params.layoutId) q.set('layout', params.layoutId);
  if (params.q) q.set('q', params.q);
  if (params.includeArchived) q.set('includeArchived', 'true');
  if (params.limit) q.set('limit', String(params.limit));
  if (params.cursor) q.set('cursor', params.cursor);
  for (const [k, v] of Object.entries(params.fieldFilters ?? {})) {
    q.set(`field.${k}`, v);
  }
  const res = await serverApiFetch<AssetPage>(
    `/companies/${companyId}/assets${q.toString() ? `?${q.toString()}` : ''}`,
  );
  // Throws on network failure / 5xx / 429 — an empty page here would
  // render as "no assets" when the backend is actually broken.
  return (
    unwrapApiResponse(res, `/companies/${companyId}/assets`) ?? {
      items: [],
      nextCursor: null,
    }
  );
}

/**
 * `{ assetLayoutId -> count }` map of active assets in this company.
 * Missing ids should be read as zero. Used by the company-scoped
 * sidebar to decorate layout entries with live counts.
 */
export async function getAssetCountsByLayout(
  companyId: string,
): Promise<Record<string, number>> {
  const res = await serverApiFetch<Record<string, number>>(
    `/companies/${companyId}/assets/counts-by-layout`,
  );
  return res.data ?? {};
}

/**
 * `/companies/:companyId/assets/:id` — shared by an asset detail page and
 * its separately streamed `generateMetadata` call. Request-scoped
 * memoization is important here: two independent reads can consume two
 * throttle slots and, if metadata alone is rate-limited, leave the page
 * rendered with the parent company's fallback title until a later refresh.
 * Primitive arguments keep React's identity-keyed cache deterministic.
 */
export const getAsset = cache(
  async (companyId: string, id: string): Promise<AssetSummary | null> => {
    const path = `/companies/${companyId}/assets/${id}`;
    const res = await serverApiFetch<AssetSummary>(path);
    return unwrapApiResponse(res, path);
  },
);

export const getCompanyAssetCounts = cache(
  async (companyId: string): Promise<Record<string, number>> =>
    getAssetCountsByLayout(companyId),
);
