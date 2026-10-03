import { cache } from 'react';
import type { FieldType } from '@weavestream/shared';
import { unwrapApiResponse } from '../api-errors';
import { serverApiFetch } from './core';

// ───────────────────────────────────────────────────────────────────
// Phase 3: asset layouts
// ───────────────────────────────────────────────────────────────────

export type LayoutFieldSummary = {
  id: string;
  name: string;
  slug: string;
  fieldType: FieldType;
  position: number;
  isRequired: boolean;
  isUniquePerCompany: boolean;
  visibleToClients: boolean;
  isPrimary: boolean;
  showInTable: boolean;
  options: Record<string, unknown>;
  archivedAt: string | null;
};

export type LayoutSummary = {
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
  fields: LayoutFieldSummary[];
};

export type LayoutStats = {
  fieldCount: number;
  assetCount: number;
  companyCount: number;
};

export async function listLayouts(params?: {
  q?: string;
  includeArchived?: boolean;
}): Promise<LayoutSummary[]> {
  const q = new URLSearchParams();
  if (params?.q) q.set('q', params.q);
  if (params?.includeArchived) q.set('includeArchived', 'true');
  const res = await serverApiFetch<{ items: LayoutSummary[] }>(
    `/layouts${q.toString() ? `?${q.toString()}` : ''}`,
  );
  // Throws on network failure / 5xx / 429 — an empty list here would
  // cascade into "layout not found" 404s on every layout-driven page.
  return unwrapApiResponse(res, '/layouts')?.items ?? [];
}

export async function getLayout(
  id: string,
  withStats = false,
): Promise<{ layout: LayoutSummary; stats?: LayoutStats } | null> {
  const res = await serverApiFetch<{ layout: LayoutSummary; stats?: LayoutStats }>(
    `/layouts/${id}${withStats ? '?stats=true' : ''}`,
  );
  if (!res.ok || !res.data) return null;
  return res.data;
}

/**
 * `/layouts` — active layouts only. Shared by the company layout
 * (sidebar counts), the assets index page, the layouts detail page,
 * and the "new asset" page. Pages that need archived layouts should
 * still call `listLayouts({ includeArchived: true })` directly.
 */
export const getActiveLayouts = cache(
  async (): Promise<LayoutSummary[]> => listLayouts(),
);
