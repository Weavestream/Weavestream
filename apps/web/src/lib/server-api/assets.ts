import { cache } from 'react';
import { problemMessage, type AssetPage, type AssetSummary } from '@weavestream/shared';
import { unwrapApiResponse } from '../api-errors';
import { collectAllPages, serverApiFetch } from './core';

// ───────────────────────────────────────────────────────────────────
// Phase 3: assets
// ───────────────────────────────────────────────────────────────────

/** Error codes the API returns for a `field.<slug>=` filter it cannot apply. */
const FILTER_ERROR_CODES = new Set([
  'UnknownFilterField',
  'UnfilterableField',
  'InvalidFilterValue',
]);

/**
 * The API refused a `field.<slug>=` filter (HTTP 400). Thrown instead of
 * returning an empty page, so the list can say why it has no rows
 * rather than claim that no asset matches.
 */
export class AssetFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetFilterError';
  }
}

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
  const errorCode = (res.problem as { error?: unknown } | undefined)?.error;
  if (res.status === 400 && typeof errorCode === 'string' && FILTER_ERROR_CODES.has(errorCode)) {
    throw new AssetFilterError(problemMessage(res.problem) ?? 'This filter cannot be applied.');
  }
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
 * Every asset that matches the filters, by following the API's cursor
 * until it runs out (#97).
 *
 * The asset tables filter by tag, sort, and match credentials on the
 * client, which is only correct when they hold the whole list — a single
 * page would silently hide everything past row 200. A 233-asset company
 * makes 2 requests.
 *
 * The ceiling is lower than `listAllArticles` because each list row also
 * carries its layout's field definitions. `truncated` reports that the
 * ceiling stopped the loop, so the page can say so instead of presenting
 * a slice as the total. Errors propagate from `listAssets`.
 */
export async function listAllAssets(
  companyId: string,
  params: {
    layoutId?: string;
    q?: string;
    includeArchived?: boolean;
    fieldFilters?: Record<string, string>;
  } = {},
): Promise<{ items: AssetSummary[]; truncated: boolean }> {
  /** The API's own per-request ceiling; asking for more is clamped. */
  const PAGE_SIZE = 200;
  /** 25 x 200 = 5,000 assets, then `truncated`. */
  const MAX_PAGES = 25;
  return collectAllPages(
    (cursor) => listAssets(companyId, { ...params, limit: PAGE_SIZE, cursor }),
    MAX_PAGES,
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
