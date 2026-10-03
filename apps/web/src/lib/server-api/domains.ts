import { cache } from 'react';
import type { DomainCheckDetails, DomainStatusValue } from '@weavestream/shared';
import { serverApiFetch } from './core';

// ---------------------------------------------------------------------
// Phase 8: monitored domains
// ---------------------------------------------------------------------

export type MonitoredDomain = {
  id: string;
  companyId: string;
  hostname: string;
  checkWhois: boolean;
  checkDns: boolean;
  checkTls: boolean;
  alertThresholdDays: number;
  visibleToClients: boolean;
  lastCheckedAt: string | null;
  whoisExpiresAt: string | null;
  tlsExpiresAt: string | null;
  latestStatus: DomainStatusValue;
  /** v2 — latest hygiene score (percentage 0-100). NULL if never scored. */
  latestScore: number | null;
  /** v2 — operator-supplied DKIM selectors (CSV). */
  dkimSelectorOverride: string | null;
  archivedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DomainCheck = {
  id: string;
  monitoredDomainId: string;
  companyId: string;
  checkedAt: string;
  whoisStatus: 'OK' | 'WARN' | 'FAIL' | 'SKIP' | null;
  dnsStatus: 'OK' | 'WARN' | 'FAIL' | 'SKIP' | null;
  tlsStatus: 'OK' | 'WARN' | 'FAIL' | 'SKIP' | null;
  whoisExpiresAt: string | null;
  tlsExpiresAt: string | null;
  details: DomainCheckDetails;
  error: string | null;
  /** v2 — denormalised percent score. NULL for legacy rows. */
  score: number | null;
  /** v2 — rubric version this row was scored under. */
  schemaVersion: number | null;
};

export type DomainAlert = {
  companyId: string;
  companyName: string;
  companySlug: string;
  domainId: string;
  hostname: string;
  status: DomainStatusValue;
  visibleToClients: boolean;
  whoisExpiresAt: string | null;
  tlsExpiresAt: string | null;
  /** v2 — latest hygiene score (percent). NULL when never scored. */
  latestScore: number | null;
};

export async function listDomains(
  companyId: string,
  params: {
    q?: string;
    status?: DomainStatusValue;
    includeArchived?: boolean;
    limit?: number;
    cursor?: string;
  } = {},
): Promise<{ items: MonitoredDomain[]; nextCursor: string | null }> {
  const q = new URLSearchParams();
  if (params.q) q.set('q', params.q);
  if (params.status) q.set('status', params.status);
  if (params.includeArchived) q.set('includeArchived', 'true');
  if (params.limit) q.set('limit', String(params.limit));
  if (params.cursor) q.set('cursor', params.cursor);
  const res = await serverApiFetch<{
    items: MonitoredDomain[];
    nextCursor: string | null;
  }>(
    `/companies/${companyId}/domains${q.toString() ? `?${q.toString()}` : ''}`,
  );
  return res.data ?? { items: [], nextCursor: null };
}

export async function getDomain(
  companyId: string,
  id: string,
): Promise<MonitoredDomain | null> {
  const res = await serverApiFetch<MonitoredDomain>(
    `/companies/${companyId}/domains/${id}`,
  );
  if (!res.ok || !res.data) return null;
  return res.data;
}

export async function listDomainChecks(
  companyId: string,
  id: string,
  limit = 30,
): Promise<DomainCheck[]> {
  const res = await serverApiFetch<DomainCheck[]>(
    `/companies/${companyId}/domains/${id}/checks?limit=${limit}`,
  );
  return res.data ?? [];
}

export async function listDomainAlerts(
  limit = 50,
): Promise<DomainAlert[]> {
  const res = await serverApiFetch<{ items: DomainAlert[] }>(
    `/domains/alerts?limit=${limit}`,
  );
  return res.data?.items ?? [];
}

/**
 * `/companies/:id/domains` — the first 200 active-and-non-active rows.
 * The shared layout pulls this for sidebar counts/alert badges and
 * the company home page renders the same list for its "needs
 * attention" banner. Pages that actually paginate (`domains/page.tsx`)
 * stay on `listDomains` since they set custom filters.
 */
export const getCompanyDomainsBasic = cache(
  async (
    companyId: string,
  ): Promise<{ items: MonitoredDomain[]; nextCursor: string | null }> =>
    listDomains(companyId, { limit: 200 }),
);
