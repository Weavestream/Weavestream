import type { IntegrationTargetKind } from '@weavestream/shared';

export interface ReconstructionBindingIdentity {
  integrationCompanyMappingId: string;
  resourceId: string;
  externalId: string;
}

interface BindingLookupClient {
  integrationSyncRecord: {
    findUnique(args: unknown): Promise<Record<string, unknown> | null>;
  };
}

const TARGET_ID_FIELD: Record<IntegrationTargetKind, string> = {
  asset: 'assetId',
  subnet: 'subnetId',
  ip_reservation: 'ipReservationId',
  article: 'articleId',
  relation: 'relationId',
};

export async function hasEligibleNativeBinding(
  client: BindingLookupClient,
  input: ReconstructionBindingIdentity & {
    integrationId: string;
    companyId: string;
    targetKind: IntegrationTargetKind;
    targetId: string;
  },
): Promise<boolean> {
  const record = await client.integrationSyncRecord.findUnique({
    where: {
      integrationCompanyMappingId_resourceId_externalId: {
        integrationCompanyMappingId: input.integrationCompanyMappingId,
        resourceId: input.resourceId,
        externalId: input.externalId,
      },
    },
    select: {
      integrationCompanyMappingId: true,
      resourceId: true,
      externalId: true,
      companyId: true,
      targetKind: true,
      assetId: true,
      subnetId: true,
      ipReservationId: true,
      articleId: true,
      relationId: true,
      state: true,
      provenance: true,
    },
  });
  if (!record) return false;
  const provenance = record.provenance;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return false;
  const source = provenance as Record<string, unknown>;
  const eligibleState = record.state === 'active' || record.state === 'stale';
  return eligibleState &&
    source.ownership === 'breeze' &&
    source.state === record.state &&
    source.integrationId === input.integrationId &&
    record.integrationCompanyMappingId === input.integrationCompanyMappingId &&
    record.resourceId === input.resourceId &&
    record.externalId === input.externalId &&
    record.companyId === input.companyId &&
    record.targetKind === input.targetKind &&
    record[TARGET_ID_FIELD[input.targetKind]] === input.targetId;
}
