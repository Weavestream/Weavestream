import { cache } from 'react';
import type { SubnetDetail, SubnetRow } from '@weavestream/shared';
import { unwrapApiResponse } from '../api-errors';
import { serverApiFetch } from './core';

// ---------------------------------------------------------------------
// IPAM — company-scoped subnet registry + reservations
// ---------------------------------------------------------------------

export async function listSubnets(
  companyId: string,
  params: { q?: string; includeArchived?: boolean } = {},
): Promise<SubnetRow[]> {
  const q = new URLSearchParams();
  if (params.q) q.set('q', params.q);
  if (params.includeArchived) q.set('includeArchived', 'true');
  const res = await serverApiFetch<SubnetRow[]>(
    `/companies/${companyId}/ipam/subnets${q.toString() ? `?${q.toString()}` : ''}`,
  );
  return res.data ?? [];
}

export const getCompanySubnetsBasic = cache(
  async (companyId: string): Promise<SubnetRow[]> =>
    listSubnets(companyId),
);

export async function getSubnetDetail(
  companyId: string,
  id: string,
): Promise<SubnetDetail | null> {
  const res = await serverApiFetch<SubnetDetail>(
    `/companies/${companyId}/ipam/subnets/${id}`,
  );
  return unwrapApiResponse(res, `/companies/${companyId}/ipam/subnets/${id}`);
}
