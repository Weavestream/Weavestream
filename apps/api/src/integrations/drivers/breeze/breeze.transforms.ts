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

const MANAGED_START = '<!-- weavestream:breeze:managed:start -->';
const MANAGED_END = '<!-- weavestream:breeze:managed:end -->';
const FORBIDDEN_CONFIGURATION_KEYS = new Set([
  'authorization', 'credential', 'credentials', 'encryptionkey', 'apikey', 'accesstoken',
  'refreshtoken', 'privatekey', 'providerconfig', 'password', 'passwd', 'pwd', 'secret', 'token',
  'recoverykey', 'bitlockerrecoverykey',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SECRET_VALUE_PATTERNS = [
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/iu,
  /\bauthorization\s*:\s*(?:bearer|basic)\s+[A-Za-z0-9+/=_-]{12,}/iu,
  /\b(?:gh[oprsu]_|sk-(?:live|test)?-?|xox[baprs]-)[A-Za-z0-9_-]{20,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/iu,
  /\bConvertTo-SecureString\s+(?:-String\s+)?(?:"[^"\r\n]+"|'[^'\r\n]+')\s+-AsPlainText\b/iu,
] as const;

export class BreezeSensitiveDefinitionError extends Error {
  constructor(readonly sourceId: string, readonly orgId: string) {
    super('Breeze desired configuration was blocked as sensitive input.');
    this.name = 'BreezeSensitiveDefinitionError';
  }
}

export class BreezeBoundedDefinitionError extends Error {
  constructor(readonly sourceId: string, readonly orgId: string) {
    super('Breeze desired configuration exceeds a native field bound.');
    this.name = 'BreezeBoundedDefinitionError';
  }
}

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
  if (isDesiredConfigurationResource(resource.data) && inspectDesiredConfiguration(record) !== 'safe') {
    throw new BreezeSensitiveDefinitionError(record.id, record.orgId);
  }
  if (BREEZE_ENDPOINT_BY_RESOURCE[resource.data] === 'scripts' && isSensitiveScriptContent(record.content)) {
    throw new BreezeSensitiveDefinitionError(record.id, record.orgId);
  }
  if (
    BREEZE_ENDPOINT_BY_RESOURCE[resource.data] === 'custom-field-values' &&
    stableJson(record.value).length > 50_000
  ) {
    throw new BreezeBoundedDefinitionError(record.id, record.orgId);
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
      return [...record.dependencies]
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

function inspectDesiredConfiguration(root: unknown): 'safe' | 'sensitive' | 'bounds_exceeded' {
  const pending: Array<{ value: unknown; depth: number; trustedRevision?: boolean }> = [{ value: root, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const { value, depth, trustedRevision } = pending.pop()!;
    visited += 1;
    if (visited > 10_000 || depth > 32) return 'bounds_exceeded';
    if (typeof value === 'string') {
      if (value.length > 12_288) return 'bounds_exceeded';
      if (!(trustedRevision && SHA256_PATTERN.test(value)) && isSecretLikeConfigurationValue(value)) {
        return 'sensitive';
      }
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      for (const child of value) pending.push({ value: child, depth: depth + 1 });
      continue;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isForbiddenConfigurationKey(key)) return 'sensitive';
      pending.push({ value: child, depth: depth + 1, trustedRevision: depth === 0 && key === 'revision' });
    }
  }
  return 'safe';
}

function splitConfigurationFieldName(name: string): string[] {
  const words = name
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  return [...words, words.join('')];
}

function isForbiddenConfigurationKey(name: string): boolean {
  const tokens = splitConfigurationFieldName(name);
  return tokens.some((token) => FORBIDDEN_CONFIGURATION_KEYS.has(token));
}

function shannonEntropy(value: string): number {
  const frequencies = new Map<string, number>();
  for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function boundedWindows(value: string, windowSize: number): string[] {
  if (value.length <= windowSize) return [value];
  const offsets = [0, Math.floor((value.length - windowSize) / 2), value.length - windowSize];
  return [...new Set(offsets)].map((offset) => value.slice(offset, offset + windowSize));
}

function candidateLooksHighEntropy(candidate: string): boolean {
  if (candidate.length < 32 || UUID_PATTERN.test(candidate)) return false;
  const sampleSize = Math.min(64, candidate.length);
  return boundedWindows(candidate, sampleSize).some((sample) => shannonEntropy(sample) >= 3.2);
}

function containsCredentialAssignment(value: string): boolean {
  const assignments = value.matchAll(
    /(?:^|[\s;|&{[,])(?:export\s+|setx?\s+)?["']?\$?(?:env:)?([A-Za-z][A-Za-z0-9_-]{0,127})["']?\s*(?:=|:)\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s;,}\]]+)/gimu,
  );
  for (const assignment of assignments) {
    if (splitConfigurationFieldName(assignment[1] ?? '').some((token) => FORBIDDEN_CONFIGURATION_KEYS.has(token))) {
      return true;
    }
  }
  const setCommands = value.matchAll(
    /\b(?:setx?)(?:\s+\/M)?\s+["']?([A-Za-z][A-Za-z0-9_-]{0,127})(?:\s*=\s*|\s+)(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s;]+)/gimu,
  );
  for (const command of setCommands) {
    if (splitConfigurationFieldName(command[1] ?? '').some((token) => FORBIDDEN_CONFIGURATION_KEYS.has(token))) {
      return true;
    }
  }
  if (
    /\bConvertTo-SecureString\b/iu.test(value) &&
    /(?:^|\s)-AsPlainText(?:\s|$)/iu.test(value) &&
    /(?:"[^"\r\n]+"|'[^'\r\n]+')/u.test(value)
  ) {
    return true;
  }
  return false;
}

function isSecretLikeConfigurationValue(value: string): boolean {
  const highEntropyCandidates = value.match(/[A-Za-z0-9+/_=-]{32,}/gu) ?? [];
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))
    || containsCredentialAssignment(value)
    || (/^[A-Za-z0-9_.-]{1,128}$/u.test(value)
      && splitConfigurationFieldName(value).some((token) => FORBIDDEN_CONFIGURATION_KEYS.has(token)))
    || highEntropyCandidates.some(candidateLooksHighEntropy);
}

function isSensitiveScriptContent(content: string): boolean {
  if (
    /\bConvertTo-SecureString\b/iu.test(content) &&
    /(?:^|\s)-AsPlainText(?:\s|$)/iu.test(content)
  ) {
    return true;
  }
  const hasForbiddenIdentifier = (identifier: string | undefined) =>
    splitConfigurationFieldName(identifier ?? '')
      .some((token) => FORBIDDEN_CONFIGURATION_KEYS.has(token));
  for (const match of content.matchAll(/[A-Za-z][A-Za-z0-9_.-]*/gu)) {
    const identifier = match[0];
    const prefix = content.slice(Math.max(0, (match.index ?? 0) - 2), match.index ?? 0);
    if (prefix === '--' && identifier.toLowerCase() === 'password-policy') continue;
    if (hasForbiddenIdentifier(identifier)) return true;
  }
  for (const match of content.matchAll(
    /(?:^|[\s{[,;|&])(?:export\s+|setx?(?:\s+\/M)?\s+)?["']?\$?(?:env:)?([A-Za-z][A-Za-z0-9_-]{0,127})["']?\s*(?==|:)/gimu,
  )) {
    if (hasForbiddenIdentifier(match[1])) return true;
  }
  for (const match of content.matchAll(
    /(?:^|\s)--?([A-Za-z][A-Za-z0-9_-]{0,127})(?=$|[\s=])/gimu,
  )) {
    const compact = (match[1] ?? '').replace(/[^A-Za-z0-9]/gu, '').toLowerCase();
    if (FORBIDDEN_CONFIGURATION_KEYS.has(compact)) return true;
  }
  return false;
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
    lines.push('', '## Schedule', fencedJson(record.schedule), '', '## Retention', fencedJson(record.retention), '', '## Exclusions', ...record.exclusions.map((item: string) => `- ${singleLine(item)}`), '', '## Restore capabilities', fencedJson(record.restore));
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
    throw new Error('Breeze desired configuration produced invalid managed-region markers.');
  }
  if (markdown.length > 500_000) throw new BreezeBoundedDefinitionError(record.id, record.orgId);
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
    throw new Error('Breeze source contains an invalid static-address gateway.');
  }
  return { cidr, ipAddress, gateway };
}

function assertCompatibleSubnetGateways(candidates: Array<Record<string, any>>): void {
  const gatewayByCidr = new Map<string, string>();
  for (const candidate of candidates) {
    if (!candidate.gateway) continue;
    const existing = gatewayByCidr.get(candidate.cidr);
    if (existing && existing !== candidate.gateway) {
      throw new Error('Breeze source contains conflicting gateways for one canonical subnet.');
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
