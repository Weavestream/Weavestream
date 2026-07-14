import type { DriverRecord, LegacyDriverRecord, TypedDriverRecord } from '../integration-driver.js';
import type {
  ArticleReconstructionInput,
  IpReservationReconstructionInput,
  RelationReconstructionInput,
  SubnetReconstructionInput,
} from '../../reconstruction/reconstruction-target.js';
import {
  BREEZE_ENDPOINT_BY_RESOURCE,
  breezeRecordSchemaByEndpoint,
  breezeResourceKeySchema,
  sanitizeBreezeText,
  type BreezeRecordBase,
  type BreezeResourceKey,
} from './breeze.schemas.js';

export function transformBreezeRecord(
  rawResource: BreezeResourceKey,
  rawRecord: unknown,
): DriverRecord[] {
  const resource = breezeResourceKeySchema.safeParse(rawResource);
  if (!resource.success) throw new Error('Unknown Breeze resource.');
  const endpoint = BREEZE_ENDPOINT_BY_RESOURCE[resource.data];
  const schema = breezeRecordSchemaByEndpoint[endpoint];
  const validated = schema.parse(rawRecord);
  const record = schema.parse(sanitizeBreezeText(validated)) as BreezeRecordBase &
    Record<string, any>;

  switch (resource.data) {
    case 'sites':
      return [
        legacy(record, record.name, {
          breezeId: record.id,
          name: record.name,
          timezone: record.timezone,
          addressLine1: record.address?.line1 ?? null,
          addressLine2: record.address?.line2 ?? null,
          city: record.address?.city ?? null,
          region: record.address?.region ?? null,
          postalCode: record.address?.postalCode ?? null,
          country: record.address?.country ?? null,
          contactName: record.contact?.name ?? null,
          contactEmail: record.contact?.email ?? null,
          contactPhone: record.contact?.phone ?? null,
          sourceRevision: record.revision,
          sourceFingerprint: record.revision,
        }),
      ];
    case 'devices':
      return [
        legacy(record, record.displayName || record.hostname, {
          breezeId: record.id,
          hostname: record.hostname,
          displayName: record.displayName,
          deviceType: record.type.os,
          deviceRole: record.type.role,
          siteId: record.siteId,
          vendor: record.hardwareIdentity.manufacturer,
          model: record.hardwareIdentity.model,
          serialNumber: record.hardwareIdentity.serialNumber,
          osEdition: record.operatingSystem.edition,
          osBuild: record.operatingSystem.build,
          osArchitecture: record.operatingSystem.architecture,
          enrolledAt: record.installation.enrolledAt,
          assetTag: record.stableIdentifiers.assetTag,
          inventoryId: record.stableIdentifiers.inventoryId,
          upstreamExternalId: record.stableIdentifiers.externalId,
          virtualizationRole: record.type.virtual
            ? record.type.virtualizationPlatform || 'virtual'
            : 'physical',
          tags: [...record.tags],
          sourceRevision: record.revision,
          sourceFingerprint: record.revision,
        }),
      ];
    case 'device-inventory':
      return [
        legacy(
          record,
          `Inventory ${record.deviceId}`,
          {
            breezeId: record.deviceId,
            cpu: asStructuredText(record.cpu),
            memoryBytes: record.memoryBytes,
            firmware: asStructuredText(record.firmware),
            disks: asStructuredText(record.disks),
            interfaces: asStructuredText(record.interfaces),
            warrantyExpiry: record.warrantyExpiry,
            supportExpiry: record.supportExpiry,
            sourceRevision: record.revision,
            sourceFingerprint: record.revision,
          },
          record.deviceId,
        ),
      ];
    case 'device-software':
      return [
        legacy(
          record,
          `Software ${record.deviceId}`,
          {
            breezeId: record.deviceId,
            installedSoftware: asStructuredText(record.software),
            sourceRevision: record.revision,
            sourceFingerprint: record.revision,
          },
          record.deviceId,
        ),
      ];
    case 'custom-fields':
      return [
        legacy(
          record,
          `Custom fields ${record.deviceId}`,
          {
            breezeId: record.deviceId,
            selectedCustomFields: asStructuredText(record.fields),
            sourceRevision: record.revision,
            sourceFingerprint: record.revision,
          },
          record.deviceId,
        ),
      ];
    case 'subnets':
      return record.subnets.map((subnet: Record<string, any>) => typedSubnet(record, subnet));
    case 'ip-reservations':
      return record.reservations.map((reservation: Record<string, any>) =>
        typedReservation(record, reservation),
      );
    case 'configuration-policies':
    case 'scripts':
    case 'automations':
    case 'backup-configurations':
      return [typedArticle(resource.data, record)];
    case 'device-relationships':
      return record.relationships.map((relationship: Record<string, any>) =>
        typedRelation(record, relationship),
      );
  }
}

function legacy(
  record: BreezeRecordBase,
  displayName: string,
  fields: Record<string, unknown>,
  externalId = record.id,
): LegacyDriverRecord {
  return { externalId, displayName, fields, updatedAt: record.sourceUpdatedAt };
}

function source(record: BreezeRecordBase, resourceKey: BreezeResourceKey, sourceId: string) {
  return {
    externalOrgId: record.orgId,
    resourceKey,
    sourceId,
    revision: record.revision,
    fingerprint: record.revision,
    updatedAt: record.sourceUpdatedAt,
  };
}

function namespaced(orgId: string, resourceKey: string, sourceId: string): string {
  return `${orgId}:${resourceKey}:${sourceId}`;
}

function typedSubnet(record: BreezeRecordBase, subnet: Record<string, any>): TypedDriverRecord {
  const sourceId = `${record.id}:${subnet.id}`;
  const input: SubnetReconstructionInput = {
    targetKind: 'subnet',
    externalId: namespaced(record.orgId, 'subnets', sourceId),
    source: source(record, 'subnets', sourceId),
    name: subnet.name,
    cidr: subnet.cidr,
    vlanId: subnet.vlanId,
    gateway: subnet.gateway,
    dhcpRangeStart: subnet.dhcpRangeStart,
    dhcpRangeEnd: subnet.dhcpRangeEnd,
    description: subnet.description,
  };
  return { reconstructionInput: input };
}

function typedReservation(
  record: BreezeRecordBase,
  reservation: Record<string, any>,
): TypedDriverRecord {
  const sourceId = `${record.id}:${reservation.id}`;
  const subnetSourceId = `${record.id}:${reservation.subnetId}`;
  const input: IpReservationReconstructionInput = {
    targetKind: 'ip_reservation',
    externalId: namespaced(record.orgId, 'ip-reservations', sourceId),
    source: source(record, 'ip-reservations', sourceId),
    subnetRef: {
      resourceKey: 'subnets',
      externalId: namespaced(record.orgId, 'subnets', subnetSourceId),
    },
    ipAddress: reservation.ipAddress,
    label: reservation.label,
    notes: reservation.notes,
  };
  return { reconstructionInput: input };
}

function typedArticle(
  resource: 'configuration-policies' | 'scripts' | 'automations' | 'backup-configurations',
  record: BreezeRecordBase & Record<string, any>,
): TypedDriverRecord {
  const markdown = [
    `# ${record.name}`,
    record.description ? `\n${record.description}` : '',
    record.content ? `\n${record.content}` : '',
    `\nSource revision: ${record.revision}`,
    `\nSource updated: ${record.sourceUpdatedAt}`,
  ].join('');
  const input: ArticleReconstructionInput = {
    targetKind: 'article',
    externalId: namespaced(record.orgId, resource, record.id),
    source: source(record, resource, record.id),
    title: record.name,
    slug: `${resource.slice(0, 40)}-${record.id.slice(0, 8)}`,
    folderId: null,
    markdown,
    visibleToClients: false,
  };
  return { reconstructionInput: input };
}

function typedRelation(
  record: BreezeRecordBase,
  relationship: Record<string, any>,
): TypedDriverRecord {
  const sourceId = `${record.id}:${relationship.id}`;
  const input: RelationReconstructionInput = {
    targetKind: 'relation',
    externalId: namespaced(record.orgId, 'device-relationships', sourceId),
    source: source(record, 'device-relationships', sourceId),
    sourceRef: {
      resourceKey: relationship.sourceResourceKey,
      externalId: namespaced(record.orgId, relationship.sourceResourceKey, relationship.sourceId),
    },
    targetRef: {
      resourceKey: relationship.targetResourceKey,
      externalId: namespaced(record.orgId, relationship.targetResourceKey, relationship.targetId),
    },
    relationType: relationship.type,
  };
  return { reconstructionInput: input };
}

function asStructuredText(value: unknown): string {
  return JSON.stringify(value);
}
