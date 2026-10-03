import { cache } from 'react';
import type {
  DomainAlertDto,
  DomainCheckDto,
  DomainStatusValue,
  MonitoredDomainDto,
} from '@weavestream/shared';
import { serverApiFetch } from './core';

// ---------------------------------------------------------------------
// Phase 8: monitored domains
// ---------------------------------------------------------------------

export async function listDomains(
  companyId: string,
  params: {
    q?: string;
    status?: DomainStatusValue;
    includeArchived?: boolean;
    limit?: number;
    cursor?: string;
  } = {},
): Promise<{ items: MonitoredDomainDto[]; nextCursor: string | null }> {
  const q = new URLSearchParams();
  if (params.q) q.set('q', params.q);
  if (params.status) q.set('status', params.status);
  if (params.includeArchived) q.set('includeArchived', 'true');
  if (params.limit) q.set('limit', String(params.limit));
  if (params.cursor) q.set('cursor', params.cursor);
  const res = await serverApiFetch<{
    items: MonitoredDomainDto[];
    nextCursor: string | null;
  }>(
    `/companies/${companyId}/domains${q.toString() ? `?${q.toString()}` : ''}`,
  );
  return res.data ?? { items: [], nextCursor: null };
}

export async function getDomain(
  companyId: string,
  id: string,
): Promise<MonitoredDomainDto | null> {
  const res = await serverApiFetch<MonitoredDomainDto>(
    `/companies/${companyId}/domains/${id}`,
  );
  if (!res.ok || !res.data) return null;
  return res.data;
}

export async function listDomainChecks(
  companyId: string,
  id: string,
  limit = 30,
): Promise<DomainCheckDto[]> {
  const res = await serverApiFetch<DomainCheckDto[]>(
    `/companies/${companyId}/domains/${id}/checks?limit=${limit}`,
  );
  return res.data ?? [];
}

export async function listDomainAlerts(
  limit = 50,
): Promise<DomainAlertDto[]> {
  const res = await serverApiFetch<{ items: DomainAlertDto[] }>(
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
  ): Promise<{ items: MonitoredDomainDto[]; nextCursor: string | null }> =>
    listDomains(companyId, { limit: 200 }),
);
