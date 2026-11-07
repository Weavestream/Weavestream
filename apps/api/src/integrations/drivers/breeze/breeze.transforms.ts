import type { DriverRecord, LegacyDriverRecord, TypedDriverRecord } from '../integration-driver.js';
import {
  WITHHELD_PLACEHOLDER,
  isCredentialName,
  redactSensitiveText,
  scanSensitiveMaterial,
} from '../../sensitive-material.js';
import { ipInCidr, normalizeCidrV4, normalizeIpv4V4 } from '@weavestream/shared';
import {
  MAX_RECONSTRUCTION_INPUT_BYTES,
  reconstructionInputByteLength,
} from '../../reconstruction/reconstruction-target.js';
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
  isSupportedBreezeVariant,
  readBreezeRecordSafely,
  type BreezeRecordBase,
  type BreezeResourceKey,
  type BreezeSourceEndpoint,
} from './breeze.schemas.js';

const MANAGED_START = '<!-- weavestream:breeze:managed:start -->';
const MANAGED_END = '<!-- weavestream:breeze:managed:end -->';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class BreezeBoundedDefinitionError extends Error {
  constructor(readonly sourceId: string, readonly orgId: string) {
    super('Breeze desired configuration exceeds a native field bound.');
    this.name = 'BreezeBoundedDefinitionError';
  }
}

/**
 * A record Weavestream could not read (a field it relies on is missing or
 * has an unexpected type). Carries only field paths and issue codes, never
 * values, so nothing from the record reaches logs or the run viewer.
 */
export class BreezeUnreadableRecordError extends Error {
  constructor(
    readonly sourceId: string | null,
    readonly fieldPaths: string[],
  ) {
    super('Breeze record could not be read.');
    this.name = 'BreezeUnreadableRecordError';
  }
}

/**
 * A record whose data Weavestream cannot use as it is (for example two
 * gateways for one network). The record is skipped as a gap; the rest of
 * the page is synced. `reasonCode` is a fixed code; no value is carried.
 */
export class BreezeRecordGapError extends Error {
  constructor(
    readonly reasonCode: string,
    readonly fieldPaths: string[] = [],
  ) {
    super('Breeze record data is inconsistent.');
    this.name = 'BreezeRecordGapError';
  }
}

/** A record synced with values replaced by `[withheld]`. */
export interface BreezeRecordRedaction {
  sourceId: string;
  orgId: string;
  /** How many values were withheld. */
  count: number;
  /** Where, as key names and indexes only (at most 20). */
  fieldPaths: string[];
}

export function transformBreezeRecord(
  rawResource: BreezeResourceKey,
  rawRecord: unknown,
  onRedaction?: (redaction: BreezeRecordRedaction) => void,
): DriverRecord[] {
  const resource = breezeResourceKeySchema.safeParse(rawResource);
  if (!resource.success) throw new Error('Unknown Breeze resource.');
  const endpoint = BREEZE_ENDPOINT_BY_RESOURCE[resource.data];
  if (!isSupportedBreezeVariant(endpoint, rawRecord)) return [];
  const parsed = readBreezeRecord(endpoint, rawRecord) as BreezeRecordBase & Record<string, any>;
  // Values that look like credentials are replaced by `[withheld]` and the
  // record is synced. Desired configuration keeps its size bounds.
  const redaction = redactBreezeRecord(parsed, isDesiredConfigurationResource(resource.data));
  if (redaction.boundsExceeded) {
    throw new BreezeBoundedDefinitionError(parsed.id, parsed.orgId);
  }
  let record = redaction.value as BreezeRecordBase & Record<string, any>;
  // A custom field is a key-value pair whose key is its definition: a field
  // named like a credential ("Local admin password") has its value withheld.
  if (
    (endpoint === 'custom-field-values' || endpoint === 'custom-fields') &&
    [record.fieldKey, record.name].some((name) => typeof name === 'string' && isCredentialName(name))
  ) {
    for (const key of ['value', 'defaultValue'] as const) {
      if (!(key in record) || record[key] === WITHHELD_PLACEHOLDER || isEmptyConfigurationValue(record[key], 0)) continue;
      record = { ...record, [key]: WITHHELD_PLACEHOLDER };
      redaction.count += 1;
      if (redaction.fieldPaths.length < MAX_REDACTED_PATHS) redaction.fieldPaths.push(key);
    }
  }
  if (
    BREEZE_ENDPOINT_BY_RESOURCE[resource.data] === 'custom-field-values' &&
    stableJson(record.value).length > 50_000
  ) {
    throw new BreezeBoundedDefinitionError(record.id, record.orgId);
  }
  if (redaction.count > 0) {
    onRedaction?.({
      sourceId: record.id, orgId: record.orgId, count: redaction.count, fieldPaths: redaction.fieldPaths,
    });
  }

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
      const diskProjection = formatDiskProjection(record.disks);
      const interfaceProjection = formatInterfaceProjection(record.interfaces);
      const addressProjection = formatAddressProjection(record.addresses);
      const gatewayProjection = formatUniqueTextProjection(
        record.addresses.map((address: Record<string, unknown>) => address.gateway),
      );
      const dnsServerProjection = formatUniqueTextProjection(
        record.addresses.flatMap((address: Record<string, unknown>) => address.dnsServers),
      );
      const virtualMachineProjection = formatVirtualMachineProjection(
        record.virtualMachines,
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
    case 'site-inventory': {
      if (record.subjectType !== 'site') return [];
      const equipmentProjection = formatEquipmentProjection(record.networkEquipment);
      const segmentProjection = formatNetworkSegments(record.networkSegments);
      return [
        legacy(
          record,
          `Site ${record.siteSubjectId}`,
          {
            breezeId: record.siteSubjectId,
            networkEquipment: equipmentProjection.text,
            networkSegments: segmentProjection.text,
            inventoryCompleteness: formatCollections(record.collections, {
              networkEquipment: equipmentProjection,
              networkSegments: segmentProjection,
            }),
            sourceRevision: record.revision,
            sourceFingerprint: record.revision,
          },
          record.siteSubjectId,
        ),
      ];
    }
    case 'device-software': {
      const softwareProjection = formatSoftwareProjection(record.software);
      return [
        legacy(
          record,
          `Software ${record.deviceId}`,
          {
            breezeId: record.deviceId,
            installedSoftware: softwareProjection.text,
            softwareCompleteness: formatCollection(
              'software',
              record.collection,
              softwareProjection,
            ),
            sourceRevision: record.revision,
            sourceFingerprint: record.revision,
          },
          record.deviceId,
        ),
      ];
    }
    case 'network-equipment':
      if (record.subjectType !== 'site') return [];
      return record.networkEquipment.map((equipment: Record<string, any>) =>
        legacy(
          record,
          equipment.name || `${equipment.type ?? 'equipment'} ${equipment.id.slice(0, 8)}`,
          {
            breezeId: equipment.id,
            siteId: record.siteSubjectId,
            equipmentType: equipment.type,
            address: equipment.address ?? null,
            macAddress: equipment.macAddress,
            manufacturer: equipment.manufacturer,
            model: equipment.model,
            url: equipment.url ?? null,
            source: equipment.source ?? null,
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
          vm.name || `Virtual machine ${vm.id.slice(0, 8)}`,
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
      return [typedArticle(resource.data, record)];
    case 'custom-field-values':
      return [{
        ...legacy(record, `${record.name} on ${record.deviceId}`, {
          [record.definitionId]: record.value,
        }),
        mappingSourceField: record.definitionId,
        bindingRef: {
          resourceKey: 'devices',
          externalId: namespaced(record.orgId, 'devices', record.deviceId),
        },
      }];
    case 'subnets':
      return subnetCandidates(record).map((subnet) => typedSubnet(record, subnet));
    case 'ip-reservations':
      return reservationCandidates(record).map((reservation) =>
        typedReservation(record, reservation),
      );
    case 'configuration-policies':
    case 'configuration-assignments':
    case 'scripts':
    case 'automations':
    case 'backup-configurations':
      return [typedArticle(resource.data, record)];
    case 'configuration-assignment-relations': {
      const relations = [typedDependencyRelation(
        record, resource.data, `${record.id}:policy`, 'configuration-assignments', record.id,
        'configuration-policies', record.policyId, 'configuration_policy',
      )];
      if (record.level === 'site' || record.level === 'device') {
        const targetResource = record.level === 'site' ? 'sites' : 'devices';
        relations.push(typedDependencyRelation(
          record, resource.data, `${record.id}:target`, 'configuration-assignments', record.id,
          targetResource, record.targetId, 'applies_to',
        ));
      }
      return relations;
    }
    case 'automation-relations':
      return record.dependencies
        .filter((dependency: Record<string, any>) => dependency.resource === 'scripts')
        .sort((left: Record<string, any>, right: Record<string, any>) => left.id.localeCompare(right.id))
        .map((dependency: Record<string, any>) => typedDependencyRelation(
          record, resource.data, `${record.id}:script:${dependency.id}`, 'automations', record.id,
          'scripts', dependency.id, 'automation_script',
        ));
    case 'backup-configuration-relations':
      return record.destinationId
        ? [typedDependencyRelation(
            record, resource.data, `${record.id}:destination`, 'backup-configurations', record.id,
            'backup-configurations', record.destinationId, 'backup_destination',
          )]
        : [];
    case 'device-relationships':
      // Edges to endpoint kinds Weavestream does not model are skipped.
      return record.edges
        .filter((relationship: Record<string, any>) =>
          relationshipResourceKey(relationship.from.type) !== null &&
          relationshipResourceKey(relationship.to.type) !== null)
        .map((relationship: Record<string, any>) => typedRelation(record, relationship));
  }
}

function readBreezeRecord(endpoint: BreezeSourceEndpoint, rawRecord: unknown): unknown {
  const read = readBreezeRecordSafely(breezeRecordSchemaByEndpoint[endpoint], rawRecord);
  if (read.success) return read.data;
  const rawId = (rawRecord as { id?: unknown } | null)?.id;
  throw new BreezeUnreadableRecordError(
    typeof rawId === 'string' && UUID_PATTERN.test(rawId) ? rawId : null,
    read.fieldPaths,
  );
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
  const sourceId = subnet.sourceId;
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
  const sourceId = reservation.sourceId;
  const subnetSourceId = reservation.sourceId;
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
  resource: 'configuration-policies' | 'configuration-assignments' | 'scripts' | 'automations' | 'backup-configurations' | 'custom-fields',
  record: BreezeRecordBase & Record<string, any>,
): TypedDriverRecord {
  const markdown = renderDesiredConfiguration(resource, record);
  const input: ArticleReconstructionInput & { folderSlug: string; folderName: string } = {
    targetKind: 'article',
    externalId: namespaced(record.orgId, resource, record.id),
    source: source(record, resource, record.id),
    title: boundedTitle(record.name),
    slug: `${resource}-${record.id}`,
    folderId: null,
    folderSlug: `breeze-${resource}`,
    folderName: `Breeze ${resource.split('-').map(titleCase).join(' ')}`,
    markdown,
    visibleToClients: false,
  };
  if (reconstructionInputByteLength(input) > MAX_RECONSTRUCTION_INPUT_BYTES) {
    throw new BreezeBoundedDefinitionError(record.id, record.orgId);
  }
  return { reconstructionInput: input };
}

function typedDependencyRelation(
  record: BreezeRecordBase,
  relationResource: BreezeResourceKey,
  sourceId: string,
  fromResource: string,
  fromId: string,
  toResource: string,
  toId: string,
  relationType: string,
): TypedDriverRecord {
  const input: RelationReconstructionInput = {
    targetKind: 'relation',
    externalId: namespaced(record.orgId, relationResource, sourceId),
    source: source(record, relationResource, sourceId),
    sourceRef: { resourceKey: fromResource, externalId: namespaced(record.orgId, fromResource, fromId) },
    targetRef: { resourceKey: toResource, externalId: namespaced(record.orgId, toResource, toId) },
    relationType,
  };
  return { reconstructionInput: input };
}

function isDesiredConfigurationResource(resource: BreezeResourceKey): boolean {
  return [
    'configuration-policies', 'configuration-assignments', 'configuration-assignment-relations',
    'scripts', 'automations', 'automation-relations', 'backup-configurations',
    'backup-configuration-relations', 'custom-fields', 'custom-field-values',
  ].includes(resource);
}

const MAX_FIELD_PATH_LENGTH = 200;
const MAX_REDACTED_PATHS = 20;
const SAFE_PATH_COMPONENT = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;

interface RecordRedactionResult {
  value: unknown;
  count: number;
  /** Where values were withheld, as key names and indexes only. */
  fieldPaths: string[];
  boundsExceeded: boolean;
}

/**
 * Copy a parsed record with every value that looks like a credential
 * replaced by `[withheld]`, so the rest of the record can sync:
 *
 * - a string, or a key, is redacted span by span with the shared format scan
 *   (`redactSensitiveText`, the same rules the writers check), so a script
 *   keeps everything but the matched text;
 * - a credential-named key that still carries a value has the whole value
 *   withheld. Breeze already withholds credential-named fields; this is the
 *   cheap second line for one that slips through.
 *
 * Identifier fields (`id`, `key`, `...Id`, the top-level `revision`) are not
 * rewritten: an identity must never change. If one looked like a
 * credential, the writer's own scan still withholds that record.
 *
 * `bounded` keeps the size bounds desired configuration always had (depth,
 * node count, string length); other records are already bounded by their
 * schemas.
 */
function redactBreezeRecord(root: unknown, bounded: boolean): RecordRedactionResult {
  const fieldPaths: string[] = [];
  let count = 0;
  let visited = 0;
  let boundsExceeded = false;
  const record = (path: string): void => {
    count += 1;
    if (fieldPaths.length < MAX_REDACTED_PATHS) fieldPaths.push(boundFieldPath(path || '(record)'));
  };
  const visit = (value: unknown, depth: number, path: string, key: string | null): unknown => {
    visited += 1;
    if (bounded && (visited > 10_000 || depth > 32)) {
      boundsExceeded = true;
      return value;
    }
    if (typeof value === 'string') {
      if (bounded && value.length > 12_288) {
        boundsExceeded = true;
        return value;
      }
      if (key !== null && isIdentifierKey(key, depth)) return value;
      const redacted = redactSensitiveText(value);
      if (redacted.redacted) record(path);
      return redacted.text;
    }
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      return value.map((child, index) => visit(child, depth + 1, appendArrayPath(path, index), null));
    }
    const output: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = appendObjectPath(path, childKey);
      // A key is source data too (a map keyed by token).
      const keyRedaction = redactSensitiveText(childKey);
      let outputKey = childKey;
      if (keyRedaction.redacted) {
        outputKey = uniqueKey(output, WITHHELD_PLACEHOLDER);
        record(childPath);
      }
      if (isCredentialName(childKey) && !isEmptyConfigurationValue(child, 0)) {
        output[outputKey] = WITHHELD_PLACEHOLDER;
        record(childPath);
        continue;
      }
      output[outputKey] = visit(child, depth + 1, childPath, childKey);
    }
    return output;
  };
  const value = visit(root, 0, '', null);
  return boundsExceeded
    ? { value, count: 0, fieldPaths: [], boundsExceeded }
    : { value, count, fieldPaths, boundsExceeded };
}

function isIdentifierKey(key: string, depth: number): boolean {
  if (key === 'id' || key === 'key' || /^[a-z][A-Za-z0-9]*Id$/u.test(key)) return true;
  // `depth` is the string's own depth: 1 for a top-level field.
  return depth === 1 && (key === 'revision' || key === 'sourceUpdatedAt');
}

function uniqueKey(target: Record<string, unknown>, base: string): string {
  if (!Object.hasOwn(target, base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base} ${index}`;
    if (!Object.hasOwn(target, candidate)) return candidate;
  }
}

/**
 * True when a value holds nothing: null, a boolean, a blank string, an object
 * with no keys, or a list of only those. An object with any key is not empty,
 * because a key is source data and can itself hold a secret (a map keyed by
 * token). Bounded; a list too deep or too long counts as not empty, so the
 * caller withholds it.
 */
// A value the source already masked holds no secret; re-withholding it would
// warn on every run.
const MASKED_VALUE_PATTERN = /^(?:\*+|•+|\[?(?:redacted|withheld|hidden|masked)\]?)$/iu;

function isEmptyConfigurationValue(value: unknown, depth: number): boolean {
  if (value === null || value === undefined || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.trim() === '' || MASKED_VALUE_PATTERN.test(value.trim());
  if (typeof value !== 'object' || depth >= 8) return false;
  if (!Array.isArray(value)) return Object.keys(value as Record<string, unknown>).length === 0;
  return value.length <= 256 && value.every((child) => isEmptyConfigurationValue(child, depth + 1));
}

// Same shape as the paths Breeze reports for its own withheld records. A key
// is source data too, so only a plain identifier is shown. Anything else (an
// assignment such as `password=abc`, spaces, punctuation, or a token-shaped
// run) is shown as `[redacted]`, never rewritten into a readable form.
function appendObjectPath(path: string, key: string): string {
  const component = SAFE_PATH_COMPONENT.test(key) && scanSensitiveMaterial(key) === 'safe'
    ? key
    : '[redacted]';
  return path ? `${path}.${component}` : component;
}

function appendArrayPath(path: string, index: number): string {
  return `${path}[${index}]`;
}

// Paths are built in full (the walk's depth bound keeps them short) and
// bounded once when reported. The end names the field, so it is kept.
function boundFieldPath(path: string): string {
  return path.length <= MAX_FIELD_PATH_LENGTH
    ? path
    : `…${path.slice(path.length - (MAX_FIELD_PATH_LENGTH - 1))}`;
}

function renderDesiredConfiguration(
  resource: 'configuration-policies' | 'configuration-assignments' | 'scripts' | 'automations' | 'backup-configurations' | 'custom-fields',
  record: BreezeRecordBase & Record<string, any>,
): string {
  const lines = [`# ${singleLine(record.name)}`, '', `Source scope: ${singleLine(record.sourceScope)}`];
  if (record.description) lines.push('', record.description);
  if (resource === 'configuration-policies') {
    lines.push(`Status: ${record.status}`, '', '## Policy features');
    for (const feature of [...record.features].sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push('', `### ${singleLine(feature.type)} (${feature.id})`, `Policy UUID: ${feature.policyId ?? 'not exported'}`, fencedJson(feature.settings));
    }
  } else if (resource === 'configuration-assignments') {
    lines.push(
      `Policy: ${singleLine(record.policyName)} (${record.policyId})`, `Target level: ${record.level}`,
      `Target UUID: ${record.targetId}`, `Priority: ${record.priority}`,
      `Role filter: ${record.roleFilter?.map(singleLine).join(', ') || 'none'}`,
      `OS filter: ${record.osFilter?.map(singleLine).join(', ') || 'none'}`,
      '', record.level === 'site' || record.level === 'device'
        ? 'The target relation is resolved during the native relation stage.'
        : 'The exported target has no durable Weavestream asset relation for this target level.',
    );
  } else if (resource === 'scripts') {
    lines.push(
      `Category: ${record.category ? singleLine(record.category) : 'not exported'}`, `Operating systems: ${record.osTypes.map(singleLine).join(', ') || 'not exported'}`,
      `Language: ${record.language}`, `Run as: ${record.runAs}`, `Timeout: ${record.timeoutSeconds} seconds`,
      `Native script version: ${record.version}`, '', '## Parameters', fencedJson(record.parameters),
      '', '## Rebuild-safe content', fencedCode(record.content, record.language),
      '', '## Exit-code severity mapping', fencedJson(record.exitCodeSeverityMapping),
      '', 'Installation sources and post-build validation steps are not exported unless present in the script content.',
    );
  } else if (resource === 'automations') {
    lines.push(`Enabled: ${record.enabled ? 'yes' : 'no'}`, `On failure: ${record.onFailure}`, '', '## Trigger', fencedJson(record.trigger), '', '## Conditions', fencedJson(record.conditions), '', '## Ordered actions');
    record.actions.forEach((action: unknown, index: number) => lines.push('', `${index + 1}.`, fencedJson(action)));
    lines.push('', '## Notification targets', fencedJson(record.notificationTargets), '', '## Script dependencies');
    for (const dependency of [...record.dependencies].sort((a, b) => a.id.localeCompare(b.id))) lines.push(`- ${dependency.id}`);
  } else if (resource === 'backup-configurations') {
    lines.push(`Kind: ${record.kind}`);
    for (const [label, key] of [['Provider', 'provider'], ['Type', 'type'], ['Active', 'active'], ['Default', 'default'], ['Enabled', 'enabled'], ['Compression', 'compression'], ['Encryption', 'encryption'], ['Destination UUID', 'destinationId'], ['Legal hold', 'legalHold'], ['Legal hold reason', 'legalHoldReason'], ['Bandwidth limit Mbps', 'bandwidthLimitMbps'], ['Backup window start', 'backupWindowStart'], ['Backup window end', 'backupWindowEnd'], ['Priority', 'priority']] as const) {
      if (key in record) lines.push(`${label}: ${displayValue(record[key])}`);
    }
    lines.push('', '## Schedule', fencedJson(record.schedule), '', '## Retention', fencedJson(record.retention), '', '## Exclusions', ...record.exclusions.map((item: string) => `- ${singleLine(item)}`));
    if ('selections' in record) lines.push('', '## Selections', fencedJson(record.selections));
    if ('targets' in record) lines.push('', '## Targets', fencedJson(record.targets));
    if ('gfs' in record) lines.push('', '## GFS', fencedJson(record.gfs));
    lines.push('', 'Credentials, provider configuration, encryption keys, job state, snapshots, and restore-job state are not exported.');
  } else {
    lines.push(
      `Field key: ${singleLine(record.fieldKey)}`, `Type: ${record.type}`, `Required: ${record.required ? 'yes' : 'no'}`,
      `Device types: ${record.deviceTypes?.map(singleLine).join(', ') || 'all exported device types'}`,
      '', '## Options', fencedJson(record.options), '', '## Default value', fencedJson(record.defaultValue),
      '', 'Per-device values are traversed independently and written to their bound device assets.',
    );
  }
  lines.push('', '## Source provenance', `Source UUID: ${record.id}`, `Source revision: ${record.revision}`, `Source fingerprint: ${record.revision}`, `Exported source date: ${record.sourceUpdatedAt}`);
  const body = lines.join('\n')
    .replaceAll(MANAGED_START, '&lt;!-- weavestream:breeze:managed:start --&gt;')
    .replaceAll(MANAGED_END, '&lt;!-- weavestream:breeze:managed:end --&gt;');
  const markdown = `${MANAGED_START}\n${body}\n${MANAGED_END}`;
  if (markdown.split(MANAGED_START).length !== 2 || markdown.split(MANAGED_END).length !== 2) {
    throw new BreezeRecordGapError('invalid_managed_region');
  }
  return markdown;
}

function stableJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
}

function fencedJson(value: unknown): string {
  return fencedCode(stableJson(value), 'json');
}

function fencedCode(content: string, language: string): string {
  const longest = Math.max(0, ...(content.match(/`+/gu) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${singleLine(language)}\n${content}\n${fence}`;
}

function singleLine(value: unknown): string {
  return String(value).replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim();
}

function boundedTitle(value: unknown): string {
  return [...singleLine(value)].slice(0, 200).join('');
}

function titleCase(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
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
  const resourceKey = relationshipResourceKey(endpoint.type);
  if (!resourceKey) throw new BreezeRecordGapError('unsupported_relationship_endpoint');
  return { resourceKey, id: endpoint.type === 'organization' ? orgId : endpoint.id };
}

const RELATIONSHIP_RESOURCE_KEYS: Readonly<Record<string, string>> = {
  organization: 'organizations',
  site: 'sites',
  device: 'devices',
  interface: 'network-interfaces',
  address: 'network-addresses',
  virtual_machine: 'virtual-machines',
  discovered_asset: 'network-equipment',
};

function relationshipResourceKey(type: string): string | null {
  return Object.hasOwn(RELATIONSHIP_RESOURCE_KEYS, type) ? RELATIONSHIP_RESOURCE_KEYS[type]! : null;
}

function subnetCandidates(
  record: BreezeRecordBase & Record<string, any>,
): Array<Record<string, any>> {
  const candidates: Array<Record<string, any>> = [];
  if (record.subjectType === 'site') {
    for (const segment of record.networkSegments as Array<Record<string, unknown>>) {
      const cidr = normalizeCidrV4(String(segment.cidr));
      if (!cidr) continue;
      candidates.push({
        sourceId: segment.id,
        cidr,
        gateway: null,
        description: `Breeze durable network ${cidr}`,
      });
    }
  }
  if (record.subjectType === 'device') {
    for (const address of record.addresses as Array<Record<string, any>>) {
      const network = currentStaticNetwork(address);
      if (!network) continue;
      candidates.push({
        sourceId: address.id,
        cidr: network.cidr,
        gateway: network.gateway,
        description: `Breeze durable network ${network.cidr}`,
      });
    }
  }
  assertCompatibleSubnetGateways(candidates);
  return candidates.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

function reservationCandidates(
  record: BreezeRecordBase & Record<string, any>,
): Array<Record<string, any>> {
  if (record.subjectType !== 'device') return [];
  const candidates: Array<Record<string, any>> = [];
  for (const address of record.addresses as Array<Record<string, any>>) {
    const network = currentStaticNetwork(address);
    if (!network || address.reservationEligible !== true) continue;
    candidates.push({
      sourceId: address.id,
      cidr: network.cidr,
      ipAddress: network.ipAddress,
    });
  }
  return candidates.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

function currentStaticNetwork(address: Record<string, any>): {
  cidr: string;
  ipAddress: string;
  gateway: string | null;
} | null {
  if (
    address.family !== 'ipv4' ||
    address.assignment !== 'static' ||
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
  if (address.gateway && (!gateway || !ipInCidr(gateway, cidr))) {
    throw new BreezeRecordGapError('invalid_static_gateway', ['addresses.gateway']);
  }
  return { cidr, ipAddress, gateway };
}

function assertCompatibleSubnetGateways(candidates: Array<Record<string, any>>): void {
  const gatewayByCidr = new Map<string, string>();
  for (const candidate of candidates) {
    if (!candidate.gateway) continue;
    const existing = gatewayByCidr.get(candidate.cidr);
    if (existing && existing !== candidate.gateway) {
      throw new BreezeRecordGapError('conflicting_subnet_gateways', ['addresses.gateway']);
    }
    gatewayByCidr.set(candidate.cidr, candidate.gateway);
  }
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
    [...new Set(
      segments.map(
        (segment) => normalizeCidrV4(String(segment.cidr)) ?? `invalid: ${segment.cidr}`,
      ),
    )].sort(),
  );
}

// Projection lines are operator-facing text; Breeze row UUIDs carry no meaning
// for readers, so lines show source facts only. Rendering must stay
// deterministic (stable sort, stable segments) so unchanged source data keeps
// producing byte-identical field values across syncs.
function projectRows(
  rows: Array<Record<string, unknown>>,
  render: (row: Record<string, unknown>) => string,
  sortKey: (row: Record<string, unknown>) => string,
): StructuredProjection {
  const lines = mergeRowsById(rows)
    .map((row) => ({ key: sortKey(row), text: render(row) }))
    .sort(
      (left, right) =>
        left.key.localeCompare(right.key) || left.text.localeCompare(right.text),
    )
    .map((entry) => entry.text);
  return formatLinesProjection([...new Set(lines)]);
}

// Breeze occasionally reports the same row twice with conflicting flags (e.g.
// one interface row with primary=yes and one with primary=no). Without the
// UUID in the line, those would render as confusing near-duplicates; merge
// them instead — booleans OR together, first non-empty value wins otherwise.
function mergeRowsById(
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const merged = new Map<string, Record<string, unknown>>();
  for (const [index, row] of rows.entries()) {
    const key = row.id ? String(row.id) : `__row_${index}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...row });
      continue;
    }
    for (const [field, value] of Object.entries(row)) {
      if (typeof value === 'boolean') {
        existing[field] = existing[field] === true || value;
      } else if (
        existing[field] === null ||
        existing[field] === undefined ||
        existing[field] === ''
      ) {
        existing[field] = value;
      }
    }
  }
  return [...merged.values()];
}

function inline(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replaceAll('\n', ' ').slice(0, 2_000);
}

function segmentLine(parts: Array<string | false | null | undefined>): string {
  return parts
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' · ');
}

function shortDate(value: unknown): string {
  return inline(value).slice(0, 10);
}

function formatDiskProjection(rows: Array<Record<string, unknown>>): StructuredProjection {
  return projectRows(
    rows,
    (disk) =>
      segmentLine([
        inline(disk.mountPoint),
        inline(disk.fileSystem),
        typeof disk.totalGb === 'number'
          ? `${Number.isInteger(disk.totalGb) ? disk.totalGb : disk.totalGb.toFixed(1)} GB`
          : '',
        inline(disk.device),
      ]),
    (disk) => inline(disk.mountPoint),
  );
}

function formatInterfaceProjection(rows: Array<Record<string, unknown>>): StructuredProjection {
  return projectRows(
    rows,
    (row) =>
      segmentLine([
        inline(row.name),
        row.macAddress ? `MAC ${inline(row.macAddress)}` : '',
        row.primary === true && 'primary',
      ]),
    (row) => `${row.primary === true ? '0' : '1'}:${inline(row.name)}`,
  );
}

function formatAddressProjection(rows: Array<Record<string, unknown>>): StructuredProjection {
  return projectRows(
    rows,
    (row) =>
      segmentLine([
        inline(row.address),
        inline(row.family),
        row.assignment === 'unknown' ? '' : inline(row.assignment),
        row.interfaceName ? `on ${inline(row.interfaceName)}` : '',
        row.subnetMask ? `mask ${inline(row.subnetMask)}` : '',
        row.reservationEligible === true && 'reservation eligible',
        row.active === true ? 'active' : 'inactive',
        row.firstSeenAt ? `first seen ${shortDate(row.firstSeenAt)}` : '',
        row.deactivatedAt ? `deactivated ${shortDate(row.deactivatedAt)}` : '',
      ]),
    (row) => `${inline(row.interfaceName)}:${inline(row.family)}:${inline(row.address)}`,
  );
}

function formatVirtualMachineProjection(
  rows: Array<Record<string, unknown>>,
): StructuredProjection {
  return projectRows(
    rows,
    (row) =>
      segmentLine([
        inline(row.name),
        row.generation === null || row.generation === undefined
          ? ''
          : `gen ${inline(row.generation)}`,
        typeof row.memoryMb === 'number' ? `${row.memoryMb} MB` : '',
        typeof row.processorCount === 'number' ? `${row.processorCount} vCPU` : '',
        row.rctEnabled === true && 'RCT',
        row.passthroughDisks === true && 'passthrough disks',
        inline(row.externalId),
      ]),
    (row) => inline(row.name),
  );
}

function formatEquipmentProjection(rows: Array<Record<string, unknown>>): StructuredProjection {
  return projectRows(
    rows,
    (row) =>
      segmentLine([
        inline(row.name),
        inline(row.type).replaceAll('_', ' '),
        inline(row.address),
        row.url ? inline(row.url) : '',
        row.macAddress ? `MAC ${inline(row.macAddress)}` : '',
        [inline(row.manufacturer), inline(row.model)].filter(Boolean).join(' '),
      ]),
    (row) => `${inline(row.name)}:${inline(row.address)}:${inline(row.url)}`,
  );
}

function formatSoftwareProjection(rows: Array<Record<string, unknown>>): StructuredProjection {
  return projectRows(
    rows,
    (row) =>
      segmentLine([
        row.version ? `${inline(row.name)} ${inline(row.version)}` : inline(row.name),
        inline(row.vendor),
        row.installedOn ? `installed ${inline(row.installedOn)}` : '',
        row.managed === true && 'managed',
      ]),
    (row) => `${inline(row.name)}:${inline(row.version)}`,
  );
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
    .filter(([, collection]) => collection !== null && collection !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, collection]) =>
      formatCollection(name, collection as Record<string, unknown>, projections[name]),
    )
    .join('\n');
}

function formatCollection(
  name: string,
  collection: Record<string, unknown> | null,
  projection?: StructuredProjection,
): string {
  if (!collection) return '';
  const source = `${name}: ${collection.included}/${collection.total} ${collection.complete ? 'complete' : 'incomplete (collection limit exceeded)'}`;
  return projection && projection.shown < projection.total
    ? `${source}; projection ${projection.shown}/${projection.total} rows shown`
    : source;
}
