import { cache } from 'react';
import type { PasswordSummary } from '@weavestream/shared';
import { serverApiFetch } from './core';

// ---------------------------------------------------------------------
// Passwords (Phase 10 — vault)
// ---------------------------------------------------------------------

export type PasswordDetail = PasswordSummary & {
  notes: unknown | null;
  totpAlgorithm: 'SHA1' | 'SHA256' | 'SHA512';
  totpDigits: number;
  totpPeriod: number;
  /**
   * True if the signed-in user has starred this password.
   */
  isStarred: boolean;
};

export type PasswordFolderRow = {
  id: string;
  companyId: string;
  parentId: string | null;
  name: string;
  icon: string | null;
  color: string | null;
  position: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PasswordVersionRow = {
  version: number;
  changedFields: string[];
  changedBy: string;
  changedByName: string | null;
  changeReason: string | null;
  createdAt: string;
};

export type PasswordAccessUser = {
  id: string;
  name: string;
  email: string;
  role: 'SUPER_ADMIN' | 'OPERATOR' | 'CONTRACTOR';
  accessSource: 'super_admin' | 'membership' | 'global';
  alwaysIncluded: boolean;
};

export async function listPasswords(
  companyId: string,
  params: {
    q?: string;
    folderId?: string;
    assetId?: string;
    tag?: string;
    archived?: boolean;
    stale?: boolean;
  } = {},
): Promise<PasswordSummary[]> {
  const q = new URLSearchParams();
  if (params.q) q.set('q', params.q);
  if (params.folderId) q.set('folderId', params.folderId);
  if (params.assetId) q.set('assetId', params.assetId);
  if (params.tag) q.set('tag', params.tag);
  if (params.archived) q.set('archived', 'true');
  if (params.stale) q.set('stale', 'true');
  const res = await serverApiFetch<{ items: PasswordSummary[] }>(
    `/companies/${companyId}/passwords${q.toString() ? `?${q.toString()}` : ''}`,
  );
  return res.data?.items ?? [];
}

/**
 * Status-aware password-detail fetch. `getPasswordDetail` collapses
 * every failure to `null`, which forces a page into `notFound()` even
 * when the API said 403 ("restricted to specific internal users"). The
 * admin detail page needs to tell 403 apart from a genuine 404 so it can
 * render a "you don't have access" state instead of a bare not-found.
 *
 * Only the HTTP status is surfaced here — callers should branch **only**
 * on `403`. Every other non-OK status (404, 429, 503, network failure)
 * yields `data: null`, matching `getPasswordDetail`'s existing fallback
 * so 429/503 keep rendering as the 404 page rather than a misleading
 * "no access" screen. (Intentionally not routed through
 * `throwUnlessFound`, which has bespoke 429/network semantics.)
 */
export async function getPasswordDetailResult(
  companyId: string,
  id: string,
): Promise<{ status: number; data: PasswordDetail | null }> {
  const res = await serverApiFetch<PasswordDetail>(
    `/companies/${companyId}/passwords/${id}`,
  );
  return { status: res.status, data: res.ok ? res.data : null };
}

export async function getPasswordDetail(
  companyId: string,
  id: string,
): Promise<PasswordDetail | null> {
  const { data } = await getPasswordDetailResult(companyId, id);
  return data;
}

export async function listPasswordFolders(
  companyId: string,
): Promise<PasswordFolderRow[]> {
  const res = await serverApiFetch<{ items: PasswordFolderRow[] }>(
    `/companies/${companyId}/password-folders`,
  );
  return res.data?.items ?? [];
}

export async function listPasswordVersions(
  companyId: string,
  id: string,
): Promise<PasswordVersionRow[]> {
  const res = await serverApiFetch<{ items: PasswordVersionRow[] }>(
    `/companies/${companyId}/passwords/${id}/versions`,
  );
  return res.data?.items ?? [];
}

/**
 * `/companies/:id/passwords` — active only, no filters. The layout
 * uses the full row set for count + stale-badge math and the
 * passwords index page uses the same shape when it's showing the
 * default "active" view. Callers that need archived rows keep
 * `listPasswords(..., { archived: true })`.
 */
export const getCompanyActivePasswords = cache(
  async (companyId: string): Promise<PasswordSummary[]> =>
    listPasswords(companyId),
);

export const getCompanyPasswordFolders = cache(
  async (companyId: string): Promise<PasswordFolderRow[]> =>
    listPasswordFolders(companyId),
);
