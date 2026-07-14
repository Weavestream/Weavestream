import type { DriverRecord, LegacyDriverRecord, TypedDriverRecord } from '../integration-driver.js';
import { ipInCidr, normalizeCidrV4, normalizeIpv4V4 } from '@weavestream/shared';
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

const DISK_COLUMNS = [
  ['ID', 'id'], ['Mount', 'mountPoint'], ['Device', 'device'],
  ['File system', 'fileSystem'], ['Total GB', 'totalGb'],
] as const;
const INTERFACE_COLUMNS = [
  ['ID', 'id'], ['Name', 'name'], ['MAC', 'macAddress'], ['Primary', 'primary'],
] as const;
const ADDRESS_COLUMNS = [
  ['ID', 'id'], ['Interface ID', 'interfaceId'], ['Interface', 'interfaceName'],
  ['Address', 'address'], ['Family', 'family'], ['Assignment', 'assignment'],
  ['Reservation eligible', 'reservationEligible'], ['Subnet mask', 'subnetMask'],
  ['Active', 'active'], ['First seen', 'firstSeenAt'], ['Deactivated', 'deactivatedAt'],
] as const;
const VM_COLUMNS = [
  ['ID', 'id'], ['External ID', 'externalId'], ['Name', 'name'],
  ['Generation', 'generation'], ['Memory MB', 'memoryMb'], ['Processors', 'processorCount'],
  ['RCT', 'rctEnabled'], ['Passthrough disks', 'passthroughDisks'],
] as const;
const EQUIPMENT_COLUMNS = [
  ['ID', 'id'], ['Type', 'type'], ['Name', 'name'], ['Address', 'address'],
  ['MAC', 'macAddress'], ['Manufacturer', 'manufacturer'], ['Model', 'model'],
] as const;
const SOFTWARE_COLUMNS = [
  ['ID', 'id'], ['Name', 'name'], ['Version', 'version'], ['Vendor', 'vendor'],
  ['Installed', 'installedOn'], ['Managed', 'managed'],
] as const;

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
    case 'device-inventory': {
      if (record.subjectType !== 'device') return [];
      const diskProjection = formatRowsProjection(record.disks, DISK_COLUMNS);
      const interfaceProjection = formatRowsProjection(record.interfaces, INTERFACE_COLUMNS);
      const addressProjection = formatRowsProjection(record.addresses, ADDRESS_COLUMNS);
      const gatewayProjection = formatUniqueTextProjection(
        record.addresses.map((address: Record<string, unknown>) => address.gateway),
      );
      const dnsServerProjection = formatUniqueTextProjection(
        record.addresses.flatMap((address: Record<string, unknown>) => address.dnsServers),
      );
      const virtualMachineProjection = formatRowsProjection(
        record.virtualMachines,
        VM_COLUMNS,
      );
      return [
        legacy(
          record,
          `Device ${record.deviceId}`,
          {
            breezeId: record.deviceId,
            processor: formatParts([
              ['Model', record.hardware.processor.model],
              ['Cores', record.hardware.processor.cores],
              ['Threads', record.hardware.processor.threads],
            ]),
            processorCores: record.hardware.processor.cores,
            processorThreads: record.hardware.processor.threads,
            memoryMb: record.hardware.memory.totalMb,
            graphics: record.hardware.graphics.model,
            motherboard: formatParts([
              ['Manufacturer', record.hardware.motherboard.manufacturer],
              ['Product', record.hardware.motherboard.product],
              ['Version', record.hardware.motherboard.version],
            ]),
            biosVersion: record.hardware.firmware.biosVersion,
            disks: diskProjection.text,
            interfaces: interfaceProjection.text,
            networkAddresses: addressProjection.text,
            gateways: gatewayProjection.text,
            dnsServers: dnsServerProjection.text,
            warrantyStatus: record.warranty?.status ?? null,
            warrantyStartsOn: record.warranty?.startsOn ?? null,
            warrantyEndsOn: record.warranty?.endsOn ?? null,
            warrantySubscription: record.warranty?.subscription ?? null,
            virtualMachines: virtualMachineProjection.text,
            inventoryCompleteness: [
              formatCollections(record.collections, {
                disks: diskProjection,
                interfaces: interfaceProjection,
                addresses: addressProjection,
                virtualMachines: virtualMachineProjection,
              }),
              formatProjectionCompleteness('gateways', gatewayProjection, 'values'),
              formatProjectionCompleteness('DNS servers', dnsServerProjection, 'values'),
            ]
              .filter(Boolean)
              .join('\n'),
            sourceRevision: record.revision,
            sourceFingerprint: record.revision,
          },
          record.deviceId,
        ),
      ];
    }
    case 'site-inventory':
      if (record.subjectType !== 'site') return [];
      return [
        legacy(
          record,
          `Site ${record.siteSubjectId}`,
          {
            breezeId: record.siteSubjectId,
            networkEquipment: formatRows(record.networkEquipment, EQUIPMENT_COLUMNS),
            networkSegments: formatNetworkSegments(record.networkSegments).text,
            inventoryCompleteness: formatCollections(record.collections, {
              networkEquipment: formatRowsProjection(
                record.networkEquipment,
                EQUIPMENT_COLUMNS,
              ),
              networkSegments: formatNetworkSegments(record.networkSegments),
            }),
            sourceRevision: record.revision,
            sourceFingerprint: record.revision,
          },
          record.siteSubjectId,
        ),
      ];
    case 'device-software':
      return [
        legacy(
          record,
          `Software ${record.deviceId}`,
          {
            breezeId: record.deviceId,
            installedSoftware: formatRows(record.software, SOFTWARE_COLUMNS),
            softwareCompleteness: formatCollection(
              'software',
              record.collection,
              formatRowsProjection(record.software, SOFTWARE_COLUMNS),
            ),
            sourceRevision: record.revision,
            sourceFingerprint: record.revision,
          },
          record.deviceId,
        ),
      ];
    case 'network-equipment':
      if (record.subjectType !== 'site') return [];
      return record.networkEquipment.map((equipment: Record<string, any>) =>
        legacy(
          record,
          equipment.name || `${equipment.type} ${equipment.id.slice(0, 8)}`,
          {
            breezeId: equipment.id,
            siteId: record.siteSubjectId,
            equipmentType: equipment.type,
            address: equipment.address,
            macAddress: equipment.macAddress,
            manufacturer: equipment.manufacturer,
            model: equipment.model,
            sourceRevision: record.revision,
            sourceFingerprint: record.revision,
          },
          equipment.id,
        ),
      );
    case 'virtual-machines':
      if (record.subjectType !== 'device') return [];
      return record.virtualMachines.map((vm: Record<string, any>) =>
        legacy(
          record,
          vm.name,
          {
            breezeId: vm.id,
            hostDeviceId: record.deviceId,
            upstreamExternalId: vm.externalId,
            generation: vm.generation,
            memoryMb: vm.memoryMb,
            processorCount: vm.processorCount,
            rctEnabled: vm.rctEnabled,
            passthroughDisks: vm.passthroughDisks,
            sourceRevision: record.revision,
            sourceFingerprint: record.revision,
          },
          vm.id,
        ),
      );
    case 'custom-fields':
      return [
        legacy(
          record,
          `Custom fields ${record.deviceId}`,
          {
            breezeId: record.deviceId,
            selectedCustomFields: formatRows(record.fields, [
              ['Key', 'key'],
              ['Label', 'label'],
              ['Value', 'value'],
            ]),
            sourceRevision: record.revision,
            sourceFingerprint: record.revision,
          },
          record.deviceId,
        ),
      ];
    case 'subnets':
      return subnetCandidates(record).map((subnet) => typedSubnet(record, subnet));
    case 'ip-reservations':
      return reservationCandidates(record).map((reservation) =>
        typedReservation(record, reservation),
      );
    case 'configuration-policies':
    case 'scripts':
    case 'automations':
    case 'backup-configurations':
      return [typedArticle(resource.data, record)];
    case 'device-relationships':
      return record.edges.map((relationship: Record<string, any>) =>
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
  return {
    externalId,
    displayName,
    fields,
    updatedAt: record.sourceUpdatedAt,
    sourceRevision: record.revision,
    sourceFingerprint: record.revision,
  };
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
  const sourceId = `cidr:${subnet.cidr}`;
  const input: SubnetReconstructionInput = {
    targetKind: 'subnet',
    externalId: namespaced(record.orgId, 'subnets', sourceId),
    source: source(record, 'subnets', sourceId),
    name: `Network ${subnet.cidr}`,
    cidr: subnet.cidr,
    gateway: subnet.gateway ?? null,
    description: subnet.description ?? null,
  };
  return { reconstructionInput: input };
}

function typedReservation(
  record: BreezeRecordBase,
  reservation: Record<string, any>,
): TypedDriverRecord {
  const sourceId = `${reservation.cidr}:${reservation.ipAddress}`;
  const subnetSourceId = `cidr:${reservation.cidr}`;
  const input: IpReservationReconstructionInput = {
    targetKind: 'ip_reservation',
    externalId: namespaced(record.orgId, 'ip-reservations', sourceId),
    source: source(record, 'ip-reservations', sourceId),
    subnetRef: {
      resourceKey: 'subnets',
      externalId: namespaced(record.orgId, 'subnets', subnetSourceId),
    },
    ipAddress: reservation.ipAddress,
    label: `Static address ${reservation.ipAddress}`,
    notes: null,
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
  const sourceId = relationship.key;
  const from = relationshipEndpoint(record.orgId, relationship.from);
  const to = relationshipEndpoint(record.orgId, relationship.to);
  const input: RelationReconstructionInput = {
    targetKind: 'relation',
    externalId: namespaced(record.orgId, 'device-relationships', sourceId),
    source: source(record, 'device-relationships', sourceId),
    sourceRef: {
      resourceKey: from.resourceKey,
      externalId: namespaced(record.orgId, from.resourceKey, from.id),
    },
    targetRef: {
      resourceKey: to.resourceKey,
      externalId: namespaced(record.orgId, to.resourceKey, to.id),
    },
    relationType: relationship.type,
  };
  return { reconstructionInput: input };
}

function relationshipEndpoint(
  orgId: string,
  endpoint: { type: string; id: string },
): { resourceKey: string; id: string } {
  const resourceKey = {
    organization: 'organizations',
    site: 'sites',
    device: 'devices',
    interface: 'network-interfaces',
    address: 'network-addresses',
    virtual_machine: 'virtual-machines',
    discovered_asset: 'network-equipment',
  }[endpoint.type];
  if (!resourceKey) throw new Error('Unsupported Breeze relationship endpoint.');
  return { resourceKey, id: endpoint.type === 'organization' ? orgId : endpoint.id };
}

function subnetCandidates(
  record: BreezeRecordBase & Record<string, any>,
): Array<Record<string, any>> {
  const candidates = new Map<string, Record<string, any>>();
  if (record.subjectType === 'site') {
    for (const segment of record.networkSegments as Array<Record<string, unknown>>) {
      const cidr = normalizeCidrV4(String(segment.cidr));
      if (!cidr) continue;
      candidates.set(cidr, {
        cidr,
        gateway: null,
        description: `Breeze durable network ${cidr}`,
      });
    }
  }
  if (record.subjectType === 'device') {
    for (const address of record.addresses as Array<Record<string, any>>) {
      const network = durableStaticNetwork(address);
      if (!network) continue;
      const current = candidates.get(network.cidr);
      candidates.set(network.cidr, {
        cidr: network.cidr,
        gateway: current?.gateway ?? network.gateway,
        description: `Breeze durable network ${network.cidr}`,
      });
    }
  }
  return [...candidates.values()].sort((left, right) => left.cidr.localeCompare(right.cidr));
}

function reservationCandidates(
  record: BreezeRecordBase & Record<string, any>,
): Array<Record<string, any>> {
  if (record.subjectType !== 'device') return [];
  const candidates = new Map<string, Record<string, any>>();
  for (const address of record.addresses as Array<Record<string, any>>) {
    const network = durableStaticNetwork(address);
    if (!network) continue;
    const key = `${network.cidr}:${network.ipAddress}`;
    candidates.set(key, { cidr: network.cidr, ipAddress: network.ipAddress });
  }
  return [...candidates.values()].sort((left, right) =>
    `${left.cidr}:${left.ipAddress}`.localeCompare(`${right.cidr}:${right.ipAddress}`),
  );
}

function durableStaticNetwork(address: Record<string, any>): {
  cidr: string;
  ipAddress: string;
  gateway: string | null;
} | null {
  if (
    address.family !== 'ipv4' ||
    address.assignment !== 'static' ||
    address.reservationEligible !== true ||
    address.active !== true ||
    address.deactivatedAt !== null
  ) {
    return null;
  }
  const ipAddress = normalizeIpv4V4(String(address.address));
  const prefix = subnetMaskPrefix(address.subnetMask);
  if (!ipAddress || prefix === null) return null;
  const cidr = normalizeCidrV4(`${ipAddress}/${prefix}`);
  if (!cidr) return null;
  const gateway = address.gateway ? normalizeIpv4V4(String(address.gateway)) : null;
  return { cidr, ipAddress, gateway: gateway && ipInCidr(gateway, cidr) ? gateway : null };
}

function subnetMaskPrefix(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const octets = value.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return null;
  }
  const bits = octets.map((octet) => octet.toString(2).padStart(8, '0')).join('');
  if (!/^1*0*$/u.test(bits)) return null;
  return bits.indexOf('0') === -1 ? 32 : bits.indexOf('0');
}

interface StructuredProjection {
  text: string;
  shown: number;
  total: number;
}

function formatNetworkSegments(
  segments: Array<Record<string, unknown>>,
): StructuredProjection {
  return formatLinesProjection(
    segments
      .map(
        (segment) =>
          `${segment.id} | ${normalizeCidrV4(String(segment.cidr)) ?? `invalid: ${segment.cidr}`}`,
      )
      .sort(),
  );
}

function formatRows(
  rows: Array<Record<string, unknown>>,
  columns: ReadonlyArray<readonly [label: string, key: string]>,
): string {
  return formatRowsProjection(rows, columns).text;
}

function formatRowsProjection(
  rows: Array<Record<string, unknown>>,
  columns: ReadonlyArray<readonly [label: string, key: string]>,
): StructuredProjection {
  const lines = [...rows]
    .sort((left, right) => String(left.id ?? '').localeCompare(String(right.id ?? '')))
    .map((row) =>
      columns.map(([label, key]) => `${label}: ${displayValue(row[key])}`).join(' | '),
    );
  return formatLinesProjection(lines);
}

function formatLinesProjection(lines: string[]): StructuredProjection {
  const limit = 50_000;
  const complete = lines.join('\n');
  if (complete.length <= limit) return { text: complete, shown: lines.length, total: lines.length };
  const included: string[] = [];
  for (const line of lines) {
    const shown = included.length + 1;
    const marker = `[projection truncated: ${shown}/${lines.length} rows shown]`;
    const candidate = [...included, line, marker].join('\n');
    if (candidate.length > limit) break;
    included.push(line);
  }
  const marker = `[projection truncated: ${included.length}/${lines.length} rows shown]`;
  return {
    text: [...included, marker].join('\n'),
    shown: included.length,
    total: lines.length,
  };
}

function formatParts(parts: Array<readonly [label: string, value: unknown]>): string {
  return parts.map(([label, value]) => `${label}: ${displayValue(value)}`).join(' | ');
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value).replaceAll('\n', ' ').slice(0, 2_000);
}

function formatUniqueTextProjection(values: unknown[]): StructuredProjection {
  const uniqueValues = [
    ...new Set(
      values.filter((value): value is string => typeof value === 'string' && value.length > 0),
    ),
  ].sort();
  const limit = 10_000;
  const complete = uniqueValues.join(', ');
  if (complete.length <= limit) {
    return { text: complete, shown: uniqueValues.length, total: uniqueValues.length };
  }
  const included: string[] = [];
  for (const value of uniqueValues) {
    const marker = `[projection truncated: ${included.length + 1}/${uniqueValues.length} values shown]`;
    if ([...included, value, marker].join(', ').length > limit) break;
    included.push(value);
  }
  const marker = `[projection truncated: ${included.length}/${uniqueValues.length} values shown]`;
  return {
    text: [...included, marker].join(', '),
    shown: included.length,
    total: uniqueValues.length,
  };
}

function formatProjectionCompleteness(
  name: string,
  projection: StructuredProjection,
  unit: 'rows' | 'values',
): string {
  return projection.shown < projection.total
    ? `${name}: projection ${projection.shown}/${projection.total} ${unit} shown`
    : '';
}

function formatCollections(
  collections: Record<string, unknown>,
  projections: Record<string, StructuredProjection> = {},
): string {
  return Object.entries(collections)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, collection]) =>
      formatCollection(name, collection as Record<string, unknown>, projections[name]),
    )
    .join('\n');
}

function formatCollection(
  name: string,
  collection: Record<string, unknown>,
  projection?: StructuredProjection,
): string {
  const source = `${name}: ${collection.included}/${collection.total} ${collection.complete ? 'complete' : 'incomplete (collection limit exceeded)'}`;
  return projection && projection.shown < projection.total
    ? `${source}; projection ${projection.shown}/${projection.total} rows shown`
    : source;
}
