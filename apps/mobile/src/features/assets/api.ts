import type {
  CreateAssetInput,
  IntegrationTargetProvenance,
  PasswordSummary,
  UpdateAssetInput,
} from '@weavestream/shared';
import { ApiError, apiFetch } from '../../lib/api';

/**
 * Wire types, fetchers, and error classifiers for the assets feature
 * (Phase 2c).
 *
 * Responses are consumed via TypeScript types, not runtime Zod parses —
 * same stance as passwords/articles. `SerializedAsset` and
 * `SerializedLayout` exist only inside the API services, so the shapes
 * are mirrored here with string dates (the `CompanyRow`/`RelatedItem`
 * local-slice precedent).
 *
 * Two-source join, by design: the asset response embeds `fields[]`
 * (position-sorted) but WITHOUT `position`/`showInTable`/`isRequired` —
 * those ride only on `GET /layouts`. The detail screen renders straight
 * off `asset.fields`; the list card projection and the edit form join
 * the layout in.
 *
 * Since Phase 4 the list endpoint projects `fieldValues` to what list
 * consumers render — `isPrimary || showInTable` (exactly this app's
 * card contract in card-fields.ts) plus TAGS for the desktop table's
 * tag filter. Detail (`GET /assets/:id`) still carries every value.
 * Cursor pagination at PAGE_LIMIT stays.
 */

export const PAGE_LIMIT = 50;

/** `SerializedAsset.fields[]` entry — thinner than the layout's field. */
export interface AssetFieldMeta {
  id: string;
  slug: string;
  name: string;
  /** `string`, not `FieldType` — the enum grows; unknown must not crash. */
  fieldType: string;
  isPrimary: boolean;
  visibleToClients: boolean;
  options: Record<string, unknown>;
}

export interface AssetSyncSource {
  integrationId: string;
  integrationName: string;
  driver: string;
  resourceKey: string;
  lastSyncedAt: string;
}

export interface AssetReferenceEntry {
  id: string;
  name: string;
  archivedAt: string | null;
}

/** Mirror of the API's `SerializedAsset` (dates as ISO strings). */
export interface AssetRecord {
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
  archivedAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdByUser: { id: string; name: string } | null;
  updatedByUser: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  lastSyncedAt: string | null;
  syncedFieldIds: string[];
  syncSources: AssetSyncSource[];
  /** Always `[]` on list rows; populated on detail. */
  provenance: IntegrationTargetProvenance[];
  /** Keyed by field slug; visibility-filtered per role server-side. */
  fieldValues: Record<string, unknown>;
  fields: AssetFieldMeta[];
  /** ASSET_REFERENCE name sidecar, keyed by referenced asset id. */
  references: Record<string, AssetReferenceEntry>;
  isStarred: boolean;
}

/** Mirror of the API's `SerializedLayoutField` (has the join-only bits). */
export interface LayoutFieldRecord {
  id: string;
  name: string;
  slug: string;
  fieldType: string;
  position: number;
  isRequired: boolean;
  isUniquePerCompany: boolean;
  visibleToClients: boolean;
  isPrimary: boolean;
  showInTable: boolean;
  options: Record<string, unknown>;
  archivedAt: string | null;
}

export interface LayoutRecord {
  id: string;
  name: string;
  slug: string;
  icon: string;
  color: string;
  isActive: boolean;
  version: number;
  position: number;
  archivedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  fields: LayoutFieldRecord[];
}

export interface AssetsPage {
  items: AssetRecord[];
  nextCursor: string | null;
}

// ─── Fetchers ──────────────────────────────────────────────────────

export function fetchAssetsPage(
  companyId: string,
  opts: {
    layoutId?: string;
    /** Name-contains search — used by the ASSET_REFERENCE picker. */
    q?: string;
    cursor?: string | null;
    signal?: AbortSignal;
  } = {},
): Promise<AssetsPage> {
  const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  if (opts.layoutId) params.set('layout', opts.layoutId);
  if (opts.q) params.set('q', opts.q);
  if (opts.cursor) params.set('cursor', opts.cursor);
  return apiFetch<AssetsPage>(`/companies/${companyId}/assets?${params}`, {
    signal: opts.signal,
  });
}

export function fetchAssetDetail(
  companyId: string,
  assetId: string,
): Promise<AssetRecord> {
  return apiFetch<AssetRecord>(`/companies/${companyId}/assets/${assetId}`);
}

/** Active-asset counts per layout id — drives the list's filter chips. */
export function fetchAssetCountsByLayout(
  companyId: string,
): Promise<Record<string, number>> {
  return apiFetch<Record<string, number>>(
    `/companies/${companyId}/assets/counts-by-layout`,
  );
}

/** Global (org-independent) layout list; `@AuthedOnly` server-side. */
export async function fetchLayouts(): Promise<LayoutRecord[]> {
  const res = await apiFetch<{ items: LayoutRecord[] }>('/layouts');
  return res.items;
}

/** Single layout — returns archived layouts too (edit needs them). */
export async function fetchLayout(layoutId: string): Promise<LayoutRecord> {
  const res = await apiFetch<{ layout: LayoutRecord }>(`/layouts/${layoutId}`);
  return res.layout;
}

/**
 * Passwords linked to this asset via `Password.assetId` — the embedded
 * credentials the archive cascade follows. Endpoint reuse by URL only;
 * importing from `features/passwords` would break feature isolation.
 * Includes archived rows (the cascade sets `archivedAt` on them);
 * callers project the active slice.
 */
export async function fetchAssetCredentials(
  companyId: string,
  assetId: string,
): Promise<PasswordSummary[]> {
  const res = await apiFetch<{ items: PasswordSummary[] }>(
    `/companies/${companyId}/passwords?assetId=${assetId}`,
  );
  return res.items;
}

export function createAsset(
  companyId: string,
  input: CreateAssetInput,
): Promise<AssetRecord> {
  return apiFetch<AssetRecord>(`/companies/${companyId}/assets`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateAsset(
  companyId: string,
  assetId: string,
  input: UpdateAssetInput,
): Promise<AssetRecord> {
  return apiFetch<AssetRecord>(`/companies/${companyId}/assets/${assetId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function archiveAsset(
  companyId: string,
  assetId: string,
): Promise<AssetRecord> {
  return apiFetch<AssetRecord>(`/companies/${companyId}/assets/${assetId}`, {
    method: 'DELETE',
  });
}

export function restoreAsset(
  companyId: string,
  assetId: string,
): Promise<AssetRecord> {
  return apiFetch<AssetRecord>(
    `/companies/${companyId}/assets/${assetId}/restore`,
    { method: 'POST' },
  );
}

// ─── Error classifiers ─────────────────────────────────────────────

interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * `{error: 'ValidationError', issues: [{path, message}]}` → messages
 * keyed by field slug. Issue paths are dot-joined Zod paths, so an
 * array-element error arrives as `slug.0` — the head segment is the
 * slug. First message per slug wins.
 */
export function extractFieldIssues(err: unknown): Record<string, string> | null {
  if (!(err instanceof ApiError) || err.status !== 400) return null;
  const problem = err.problem as
    | { error?: unknown; issues?: unknown }
    | undefined;
  if (problem?.error !== 'ValidationError' || !Array.isArray(problem.issues)) {
    return null;
  }
  const bySlug: Record<string, string> = {};
  for (const raw of problem.issues as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const issue = raw as Partial<ValidationIssue>;
    if (typeof issue.path !== 'string' || typeof issue.message !== 'string') {
      continue;
    }
    const slug = issue.path.split('.')[0] ?? issue.path;
    if (!(slug in bySlug)) bySlug[slug] = issue.message;
  }
  return bySlug;
}

export function extractUniqueViolation(
  err: unknown,
): { slug: string; conflictingAssetName: string | null; message: string | null } | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const problem = err.problem as
    | { error?: unknown; slug?: unknown; conflictingAssetName?: unknown; message?: unknown }
    | undefined;
  if (problem?.error !== 'UniqueFieldViolation' || typeof problem.slug !== 'string') {
    return null;
  }
  return {
    slug: problem.slug,
    conflictingAssetName:
      typeof problem.conflictingAssetName === 'string'
        ? problem.conflictingAssetName
        : null,
    message: typeof problem.message === 'string' ? problem.message : null,
  };
}

/** The server's own copy for edit-blocked-because-archived, verbatim. */
export const ARCHIVED_ASSET_EDIT_MESSAGE =
  'Cannot edit an archived asset — restore it first.';

export function isArchivedAssetEditError(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 400) return false;
  const problem = err.problem as { detail?: unknown; message?: unknown } | undefined;
  return (
    problem?.detail === ARCHIVED_ASSET_EDIT_MESSAGE ||
    problem?.message === ARCHIVED_ASSET_EDIT_MESSAGE
  );
}
