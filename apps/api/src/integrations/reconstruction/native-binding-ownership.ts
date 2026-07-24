import type { IntegrationTargetKind } from '@weavestream/shared';

export interface ReconstructionBindingIdentity {
  integrationCompanyMappingId: string;
  resourceId: string;
  externalId: string;
}

interface BindingLookupClient {
  integrationSyncRecord: {
    findUnique(args: unknown): Promise<Record<string, unknown> | null>;
    findFirst?(args: unknown): Promise<Record<string, unknown> | null>;
    findMany?(args: unknown): Promise<Record<string, unknown>[]>;
  };
}

const SIBLING_BINDING_SCAN_LIMIT = 256;

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
      companyMapping: { select: { integrationId: true, externalOrgId: true } },
      resource: { select: { integrationId: true, resourceKey: true } },
    },
  });
  return isEligibleNativeBinding(record, input, true);
}

export async function hasEligibleNativeTargetBinding(
  client: BindingLookupClient,
  input: Omit<Parameters<typeof hasEligibleNativeBinding>[1], 'externalId'>,
): Promise<boolean> {
  if (!client.integrationSyncRecord.findFirst) return false;
  const targetIdField = TARGET_ID_FIELD[input.targetKind];
  const record = await client.integrationSyncRecord.findFirst({
    where: {
      integrationCompanyMappingId: input.integrationCompanyMappingId,
      resourceId: input.resourceId,
      companyId: input.companyId,
      targetKind: input.targetKind,
      [targetIdField]: input.targetId,
      state: { in: ['active', 'stale'] },
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
      companyMapping: { select: { integrationId: true, externalOrgId: true } },
      resource: { select: { integrationId: true, resourceKey: true } },
    },
  });
  return record
    ? isEligibleNativeBinding(record, { ...input, externalId: String(record.externalId) }, false)
    : false;
}

/**
 * Returns whether another eligible source binding shares the native target.
 *
 * Shared native targets need a stable field-conflict policy: once two source
 * records converge on one canonical row, neither may silently replace facts
 * asserted by the other. The bounded scan validates persisted provenance
 * rather than trusting target ids alone. Hitting the bound fails closed so a
 * pathological number of malformed sibling rows cannot re-enable overwrites.
 */
export async function hasEligibleNativeSiblingBinding(
  client: BindingLookupClient,
  input: Parameters<typeof hasEligibleNativeBinding>[1],
): Promise<boolean> {
  if (!client.integrationSyncRecord.findMany) return false;
  const targetIdField = TARGET_ID_FIELD[input.targetKind];
  const records = await client.integrationSyncRecord.findMany({
    where: {
      integrationCompanyMappingId: input.integrationCompanyMappingId,
      resourceId: input.resourceId,
      companyId: input.companyId,
      targetKind: input.targetKind,
      [targetIdField]: input.targetId,
      externalId: { not: input.externalId },
      state: { in: ['active', 'stale'] },
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
      companyMapping: { select: { integrationId: true, externalOrgId: true } },
      resource: { select: { integrationId: true, resourceKey: true } },
    },
    orderBy: { id: 'asc' },
    take: SIBLING_BINDING_SCAN_LIMIT,
  });
  return records.length === SIBLING_BINDING_SCAN_LIMIT || records.some((record) =>
    isEligibleNativeBinding(
      record,
      { ...input, externalId: String(record.externalId) },
      false,
    ),
  );
}

function isEligibleNativeBinding(
  record: Record<string, unknown> | null,
  input: Parameters<typeof hasEligibleNativeBinding>[1],
  allowBlocked: boolean,
): boolean {
  if (!record) return false;
  const provenance = record.provenance;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return false;
  const companyMapping = record.companyMapping;
  const resource = record.resource;
  if (!companyMapping || typeof companyMapping !== 'object' || Array.isArray(companyMapping)) return false;
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return false;
  const source = provenance as Record<string, unknown>;
  const mappingIdentity = companyMapping as Record<string, unknown>;
  const resourceIdentity = resource as Record<string, unknown>;
  const eligibleState = record.state === 'active' || record.state === 'stale' ||
    (allowBlocked && record.state === 'blocked');
  return eligibleState &&
    source.ownership === 'breeze' &&
    source.state === record.state &&
    source.integrationId === input.integrationId &&
    source.integrationId === mappingIdentity.integrationId &&
    source.integrationId === resourceIdentity.integrationId &&
    source.externalOrgId === mappingIdentity.externalOrgId &&
    source.resourceKey === resourceIdentity.resourceKey &&
    source.externalId === record.externalId &&
    record.integrationCompanyMappingId === input.integrationCompanyMappingId &&
    record.resourceId === input.resourceId &&
    record.externalId === input.externalId &&
    record.companyId === input.companyId &&
    record.targetKind === input.targetKind &&
    record[TARGET_ID_FIELD[input.targetKind]] === input.targetId;
}
