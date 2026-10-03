import { cache } from 'react';
import type {
  FieldType,
  IntegrationTargetProvenance,
} from '@weavestream/shared';
import { unwrapApiResponse } from '../api-errors';
import { serverApiFetch } from './core';

type ActorRef = { id: string; name: string };

export type AssetSummary = {
  id: string;
  companyId: string;
  assetLayoutId: string;
  layoutName: string;
  layoutSlug: string;
  layoutIcon: string;
  layoutColor: string;
  name: string;
  externalId: string | null;
  externalSource: string | null;
  /**
   * Phase 11 — last time an integration successfully wrote to this
   * asset. Null for manually-created or untouched assets. Populated by
   * the API's `hydrateSyncMetadata` helper based on the matching
   * `IntegrationSyncRecord` row.
   */
  lastSyncedAt: string | null;
  /**
   * Layout-field ids that were last touched by the integration sync.
   * Used by the edit form to render a subtle "synced" indicator next
   * to fields the operator may want to leave alone (or knowingly
   * override). Empty for manual assets.
   */
  syncedFieldIds: string[];
  /**
   * Phase 11.2 — every IntegrationSyncRecord linked to this asset.
   * One asset can be claimed by several integrations at once (e.g.
   * Action1 endpoint + UniFi client representing the same machine);
   * the UI surfaces all of them rather than just the "primary" one
   * stored on `externalSource`. Empty array for manual assets.
   */
  syncSources: Array<{
    integrationId: string;
    integrationName: string;
    driver: string;
    resourceKey: string;
    lastSyncedAt: string;
  }>;
  provenance: IntegrationTargetProvenance[];
  archivedAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdByUser: ActorRef | null;
  updatedByUser: ActorRef | null;
  createdAt: string;
  updatedAt: string;
  fieldValues: Record<string, unknown>;
  fields: Array<{
    id: string;
    slug: string;
    name: string;
    fieldType: FieldType;
    isPrimary: boolean;
    visibleToClients: boolean;
    options: Record<string, unknown>;
  }>;
  /**
   * Server-resolved labels for ASSET_REFERENCE values, keyed by the
   * referenced asset id. The list + detail endpoints populate this with
   * a single batched lookup so tables and detail views can render the
   * target asset's name instead of a bare uuid. Missing entries = the
   * referent was hard-deleted or is out of scope.
   */
  references: Record<
    string,
    { id: string; name: string; archivedAt: string | null }
  >;
  /**
   * True if the signed-in user has starred this asset (detail only).
   */
  isStarred: boolean;
};

export type AssetPage = { items: AssetSummary[]; nextCursor: string | null };

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
