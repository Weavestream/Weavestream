import { cache } from 'react';
import type { IntegrationTargetProvenance } from '@weavestream/shared';
import { unwrapApiResponse } from '../api-errors';
import { serverApiFetch } from './core';

// ---------------------------------------------------------------------
// IPAM — company-scoped subnet registry + reservations
// ---------------------------------------------------------------------

export type SubnetOccupant = {
  ip: string;
  assetId: string;
  assetName: string;
  assetLayoutId: string;
  assetLayoutName: string;
  assetLayoutColor: string;
  assetLayoutIcon: string;
  assetFieldId: string;
  fieldName: string;
};

type SubnetUtilization = {
  totalUsable: number;
  claimed: number;
  free: number;
  conflictCount: number;
};

export type SubnetRow = {
  id: string;
  companyId: string;
  name: string;
  cidr: string;
  prefix: number;
  vlanId: number | null;
  gateway: string | null;
  dhcpRangeStart: string | null;
  dhcpRangeEnd: string | null;
  description: string | null;
  archivedAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  utilization: SubnetUtilization;
  conflictCount: number;
};

export type IpReservationRow = {
  id: string;
  companyId: string;
  subnetId: string;
  ipAddress: string;
  label: string;
  notes: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SubnetDetail = {
  subnet: SubnetRow;
  utilization: SubnetUtilization;
  occupants: SubnetOccupant[];
  reservations: IpReservationRow[];
  conflicts: Array<{ ip: string; entries: SubnetOccupant[] }>;
  provenance: IntegrationTargetProvenance[];
};

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
