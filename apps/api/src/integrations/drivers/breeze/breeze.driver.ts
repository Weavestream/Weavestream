import {
  driverDescriptorSchema,
  type SourceFieldDto,
  type SourceOrgDto,
} from '@weavestream/shared';
import type {
  DriverFetchPage,
  FetchRecordsContext,
  IntegrationContext,
  IntegrationDriver,
  RecommendedDestination,
} from '../integration-driver.js';
import {
  BreezePartnerApiClient,
  validateBreezeConfiguration,
} from './breeze-partner-api.client.js';
import {
  BREEZE_ENDPOINT_BY_RESOURCE,
  BREEZE_RESOURCE_KEYS,
  breezeResourceKeySchema,
  type BreezeOrganization,
  type BreezePartnerEnvelope,
  type BreezeResourceKey,
} from './breeze.schemas.js';
import { BreezeBoundedDefinitionError, BreezeSensitiveDefinitionError, transformBreezeRecord } from './breeze.transforms.js';

interface BreezeClientPort {
  testConnection(ctx: IntegrationContext): Promise<void>;
  listOrganizations(ctx: IntegrationContext): Promise<BreezeOrganization[]>;
  fetchPage(
    ctx: IntegrationContext,
    input: {
      resource: BreezeResourceKey;
      externalOrgId: string;
      cursor: string | null;
      updatedSince: string | null;
    },
  ): Promise<BreezePartnerEnvelope<unknown>>;
}

const siteFields = [
  field('breezeId', 'Breeze ID', 'breeze-id', 'TEXT', 'source_wins'),
  field('name', 'Name', 'name', 'TEXT', 'preserve_manual', true, true),
  field('timezone', 'Timezone', 'timezone', 'TEXT'),
  field('addressLine1', 'Address Line 1', 'address-line-1', 'TEXT'),
  field('addressLine2', 'Address Line 2', 'address-line-2', 'TEXT'),
  field('city', 'City', 'city', 'TEXT'),
  field('region', 'Region', 'region', 'TEXT'),
  field('postalCode', 'Postal Code', 'postal-code', 'TEXT'),
  field('country', 'Country', 'country', 'TEXT'),
  field('contactName', 'Contact Name', 'contact-name', 'TEXT'),
  field('contactEmail', 'Contact Email', 'contact-email', 'EMAIL'),
  field('contactPhone', 'Contact Phone', 'contact-phone', 'PHONE'),
  field('sourceRevision', 'Source Revision', 'source-revision', 'TEXT'),
  field('sourceFingerprint', 'Source Fingerprint', 'source-fingerprint', 'TEXT'),
] as const;

const deviceIdentityFields = [
  field('breezeId', 'Breeze ID', 'breeze-id', 'TEXT', 'source_wins'),
  field('hostname', 'Hostname', 'hostname', 'TEXT', 'preserve_manual', true, true),
  field('displayName', 'Display Name', 'display-name', 'TEXT', 'preserve_manual'),
  field('deviceType', 'Type', 'device-type', 'TEXT'),
  field('deviceRole', 'Role', 'device-role', 'TEXT'),
  field('siteId', 'Site', 'site', 'TEXT'),
  field('vendor', 'Vendor', 'vendor', 'TEXT'),
  field('model', 'Model', 'model', 'TEXT'),
  field('serialNumber', 'Serial Number', 'serial-number', 'TEXT'),
  field('osEdition', 'OS Edition', 'os-edition', 'TEXT'),
  field('osBuild', 'OS Build', 'os-build', 'TEXT'),
  field('osArchitecture', 'OS Architecture', 'os-architecture', 'TEXT'),
  field('enrolledAt', 'Installed / Enrolled At', 'enrolled-at', 'DATETIME'),
  field('assetTag', 'Asset Tag', 'asset-tag', 'TEXT'),
  field('inventoryId', 'Inventory ID', 'inventory-id', 'TEXT'),
  field('upstreamExternalId', 'Upstream External ID', 'upstream-external-id', 'TEXT'),
  field('virtualizationRole', 'Virtualization Role', 'virtualization-role', 'TEXT'),
  field('tags', 'Tags', 'tags', 'TAGS'),
  field('sourceRevision', 'Source Revision', 'source-revision', 'TEXT'),
  field('sourceFingerprint', 'Source Fingerprint', 'source-fingerprint', 'TEXT'),
] as const;

const inventoryFields = [
  field('breezeId', 'Breeze ID', 'breeze-id', 'TEXT', 'source_wins'),
  field('processor', 'Processor', 'processor', 'TEXTAREA'),
  field('processorCores', 'Processor Cores', 'processor-cores', 'NUMBER'),
  field('processorThreads', 'Processor Threads', 'processor-threads', 'NUMBER'),
  field('memoryMb', 'Memory (MB)', 'memory-mb', 'NUMBER'),
  field('graphics', 'Graphics', 'graphics', 'TEXT'),
  field('motherboard', 'Motherboard', 'motherboard', 'TEXTAREA'),
  field('biosVersion', 'BIOS Version', 'bios-version', 'TEXT'),
  field('disks', 'Disks', 'disks', 'TEXTAREA'),
  field('interfaces', 'Interfaces', 'interfaces', 'TEXTAREA'),
  field('networkAddresses', 'Network Address History', 'network-addresses', 'TEXTAREA'),
  field('gateways', 'Gateways', 'gateways', 'TEXT'),
  field('dnsServers', 'DNS Servers', 'dns-servers', 'TEXT'),
  field('warrantyStatus', 'Warranty Status', 'warranty-status', 'TEXT'),
  field('warrantyStartsOn', 'Warranty Starts', 'warranty-starts-on', 'DATE'),
  field('warrantyEndsOn', 'Warranty Ends', 'warranty-ends-on', 'DATE', 'source_wins', false, true, {
    isExpiry: true,
  }),
  field('warrantySubscription', 'Warranty Subscription', 'warranty-subscription', 'BOOLEAN'),
  field('virtualMachines', 'Virtual Machines', 'virtual-machines', 'TEXTAREA'),
  field('inventoryCompleteness', 'Inventory Completeness', 'inventory-completeness', 'TEXTAREA'),
  field('sourceRevision', 'Source Revision', 'source-revision', 'TEXT'),
  field('sourceFingerprint', 'Source Fingerprint', 'source-fingerprint', 'TEXT'),
] as const;

const softwareFields = [
  field('breezeId', 'Breeze ID', 'breeze-id', 'TEXT', 'source_wins'),
  field('installedSoftware', 'Installed Software', 'installed-software', 'TEXTAREA'),
  field('softwareCompleteness', 'Software Completeness', 'software-completeness', 'TEXT'),
  field('sourceRevision', 'Source Revision', 'source-revision', 'TEXT'),
  field('sourceFingerprint', 'Source Fingerprint', 'source-fingerprint', 'TEXT'),
] as const;

const siteInventoryFields = [
  field('breezeId', 'Breeze ID', 'breeze-id', 'TEXT', 'source_wins'),
  field('networkEquipment', 'Network Equipment', 'network-equipment', 'TEXTAREA'),
  field('networkSegments', 'Network Segments', 'network-segments', 'TEXTAREA'),
  field('inventoryCompleteness', 'Inventory Completeness', 'inventory-completeness', 'TEXTAREA'),
  field('sourceRevision', 'Source Revision', 'source-revision', 'TEXT'),
  field('sourceFingerprint', 'Source Fingerprint', 'source-fingerprint', 'TEXT'),
] as const;

const equipmentFields = [
  field('breezeId', 'Breeze ID', 'breeze-id', 'TEXT', 'source_wins'),
  field('siteId', 'Site ID', 'site-id', 'TEXT'),
  field('equipmentType', 'Equipment Type', 'equipment-type', 'TEXT'),
  field('address', 'Address', 'address', 'IP_ADDRESS', 'source_wins', false, false, {
    version: 'any',
    allowCidr: false,
  }),
  field('macAddress', 'MAC Address', 'mac-address', 'TEXT'),
  field('manufacturer', 'Manufacturer', 'manufacturer', 'TEXT'),
  field('model', 'Model', 'model', 'TEXT'),
  field('sourceRevision', 'Source Revision', 'source-revision', 'TEXT'),
  field('sourceFingerprint', 'Source Fingerprint', 'source-fingerprint', 'TEXT'),
] as const;

const virtualMachineFields = [
  field('breezeId', 'Breeze ID', 'breeze-id', 'TEXT', 'source_wins'),
  field('hostDeviceId', 'Host Device ID', 'host-device-id', 'TEXT'),
  field('upstreamExternalId', 'Upstream External ID', 'upstream-external-id', 'TEXT'),
  field('generation', 'Generation', 'generation', 'NUMBER'),
  field('memoryMb', 'Memory (MB)', 'memory-mb', 'NUMBER'),
  field('processorCount', 'Processor Count', 'processor-count', 'NUMBER'),
  field('rctEnabled', 'RCT Enabled', 'rct-enabled', 'BOOLEAN'),
  field('passthroughDisks', 'Passthrough Disks', 'passthrough-disks', 'BOOLEAN'),
  field('sourceRevision', 'Source Revision', 'source-revision', 'TEXT'),
  field('sourceFingerprint', 'Source Fingerprint', 'source-fingerprint', 'TEXT'),
] as const;

const customFieldValueFields = [
  field('breezeId', 'Breeze ID', 'breeze-id', 'TEXT', 'source_wins'),
  field('definitionId', 'Definition ID', 'definition-id', 'TEXT', 'source_wins'),
  field('deviceId', 'Device ID', 'device-id', 'TEXT', 'source_wins'),
  field('fieldKey', 'Field Key', 'field-key', 'TEXT'),
  field('fieldName', 'Field Name', 'field-name', 'TEXT'),
  field('fieldType', 'Field Type', 'field-type', 'TEXT'),
  field('value', 'Value', 'value', 'TEXTAREA'),
  field('valueCollection', 'Value Collection', 'value-collection', 'TEXT'),
  field('sourceRevision', 'Source Revision', 'source-revision', 'TEXT'),
  field('sourceFingerprint', 'Source Fingerprint', 'source-fingerprint', 'TEXT'),
] as const;

const deviceDestinationFields = uniqueFields([
  ...deviceIdentityFields,
  ...inventoryFields.map((item) => ({ ...item, mapResource: false as const })),
  ...softwareFields.map((item) => ({ ...item, mapResource: false as const })),
]);
const siteDestinationFields = uniqueFields([
  ...siteFields,
  ...siteInventoryFields.map((item) => ({ ...item, mapResource: false as const })),
]);

const siteDestination: RecommendedDestination = {
  layout: { name: 'Breeze Sites', slug: 'breeze-sites', icon: 'map-pin', color: 'teal' },
  fields: siteDestinationFields,
};
const deviceLayout = {
  name: 'Breeze Devices',
  slug: 'breeze-devices',
  icon: 'monitor',
  color: 'iris',
};

export const BREEZE_RECOMMENDED_DESTINATIONS: Readonly<Record<string, RecommendedDestination>> = {
  sites: siteDestination,
  devices: { layout: deviceLayout, fields: deviceDestinationFields },
  'site-inventory': { layout: siteDestination.layout, fields: siteInventoryFields },
  'device-inventory': { layout: deviceLayout, fields: inventoryFields },
  'device-software': { layout: deviceLayout, fields: softwareFields },
  'network-equipment': {
    layout: {
      name: 'Breeze Network Equipment',
      slug: 'breeze-network-equipment',
      icon: 'network',
      color: 'amber',
    },
    fields: equipmentFields,
  },
  'virtual-machines': {
    layout: {
      name: 'Breeze Virtual Machines',
      slug: 'breeze-virtual-machines',
      icon: 'server',
      color: 'violet',
    },
    fields: virtualMachineFields,
  },
  'custom-field-values': {
    layout: { name: 'Breeze Custom Field Values', slug: 'breeze-custom-field-values', icon: 'list', color: 'cyan' },
    fields: customFieldValueFields,
  },
};

export class BreezeDriver implements IntegrationDriver {
  readonly key = 'breeze';
  readonly recommendedDestinations = BREEZE_RECOMMENDED_DESTINATIONS;
  readonly descriptor = driverDescriptorSchema.parse({
    key: this.key,
    label: 'Breeze RMM',
    description: 'Reconstruct sites, devices, inventory, topology, and procedures from Breeze.',
    iconKey: 'breeze',
    configFields: [
      {
        key: 'baseUrl',
        label: 'Breeze URL',
        kind: 'url',
        required: true,
        description: 'Public base URL for the Breeze instance.',
      },
    ],
    secretFields: [{ key: 'apiKey', label: 'Partner API key', kind: 'password', required: true }],
    resources: [
      resource('sites', 'Sites', 'asset', { sourceEndpoint: '/sites' }),
      resource('devices', 'Devices', 'asset', { sourceEndpoint: '/devices' }, ['sites']),
      resource(
        'site-inventory',
        'Site inventory',
        'asset',
        { sourceEndpoint: '/device-inventory', bindingResourceKey: 'sites' },
        ['sites'],
      ),
      resource(
        'device-inventory',
        'Device inventory',
        'asset',
        { sourceEndpoint: '/device-inventory', bindingResourceKey: 'devices' },
        ['devices'],
      ),
      resource(
        'device-software',
        'Device software',
        'asset',
        { sourceEndpoint: '/device-software', bindingResourceKey: 'devices' },
        ['devices'],
      ),
      resource(
        'network-equipment',
        'Network equipment',
        'asset',
        { sourceEndpoint: '/device-inventory' },
        ['sites'],
      ),
      resource(
        'virtual-machines',
        'Virtual machines',
        'asset',
        { sourceEndpoint: '/device-inventory' },
        ['devices'],
      ),
      resource(
        'subnets',
        'Subnets',
        'subnet',
        { sourceEndpoint: '/device-inventory', normalization: 'cidr' },
        ['site-inventory', 'device-inventory'],
      ),
      resource(
        'ip-reservations',
        'IP reservations',
        'ip_reservation',
        { sourceEndpoint: '/device-inventory', normalization: 'ip' },
        ['subnets', 'device-inventory'],
      ),
      resource('configuration-policies', 'Configuration policies', 'article', {
        sourceEndpoint: '/configuration-policies',
        folderSlug: 'breeze-configuration-policies',
        visibility: 'internal',
      }),
      resource('configuration-assignments', 'Configuration assignments', 'article', {
        sourceEndpoint: '/configuration-assignments',
        folderSlug: 'breeze-configuration-assignments',
        visibility: 'internal',
      }, ['configuration-policies']),
      resource('configuration-assignment-relations', 'Configuration assignment relations', 'relation', {
        sourceEndpoint: '/configuration-assignments',
      }, ['configuration-policies', 'configuration-assignments', 'sites', 'devices']),
      resource('scripts', 'Scripts', 'article', {
        sourceEndpoint: '/scripts',
        folderSlug: 'breeze-scripts',
        visibility: 'internal',
      }),
      resource(
        'automations',
        'Automations',
        'article',
        {
          sourceEndpoint: '/automations',
          folderSlug: 'breeze-automations',
          visibility: 'internal',
        },
        ['scripts'],
      ),
      resource('automation-relations', 'Automation relations', 'relation', {
        sourceEndpoint: '/automations',
      }, ['automations', 'scripts']),
      resource('backup-configurations', 'Backup configurations', 'article', {
        sourceEndpoint: '/backup-configurations',
        folderSlug: 'breeze-backup-configurations',
        visibility: 'internal',
      }),
      resource('backup-configuration-relations', 'Backup configuration relations', 'relation', {
        sourceEndpoint: '/backup-configurations',
      }, ['backup-configurations']),
      resource(
        'custom-fields',
        'Custom fields',
        'article',
        { sourceEndpoint: '/custom-fields', folderSlug: 'breeze-custom-fields', visibility: 'internal' },
      ),
      resource('custom-field-values', 'Custom field values', 'asset', {
        sourceEndpoint: '/custom-fields',
      }, ['devices', 'custom-fields']),
      resource('custom-field-value-relations', 'Custom field value relations', 'relation', {
        sourceEndpoint: '/custom-fields',
      }, ['custom-field-values', 'devices']),
      resource(
        'device-relationships',
        'Device relationships',
        'relation',
        { sourceEndpoint: '/device-relationships' },
        BREEZE_RESOURCE_KEYS.filter((key) => key !== 'device-relationships'),
      ),
    ],
    capabilities: { kind: 'pull', listSourceOrgs: true, dryRun: true, ticketing: false },
  });

  constructor(private readonly client: BreezeClientPort = new BreezePartnerApiClient()) {}

  validateConfiguration(
    config: Record<string, unknown> | null | undefined,
    secret: Record<string, unknown> | null | undefined,
  ): void {
    validateBreezeConfiguration(config, secret);
  }

  async testConnection(ctx: IntegrationContext): Promise<{ ok: true; details?: string }> {
    await this.client.testConnection(ctx);
    return { ok: true, details: 'Reached Breeze Partner API.' };
  }

  async listSourceOrgs(ctx: IntegrationContext): Promise<SourceOrgDto[]> {
    return (await this.client.listOrganizations(ctx)).map((organization) => ({
      externalId: organization.id,
      name: organization.name,
      hint: organization.type,
    }));
  }

  async listSourceFields(
    _ctx: IntegrationContext & { externalOrgId: string; resourceKey: string },
  ): Promise<SourceFieldDto[]> {
    const resource = breezeResourceKeySchema.safeParse(_ctx.resourceKey);
    if (!resource.success) throw new Error('Unknown Breeze resource.');
    const recommended = this.recommendedDestinations[resource.data];
    if (!recommended) return [];
    return recommended.fields
      .filter((field) => field.mapResource !== false)
      .map((field) => ({
        key: field.sourceField,
        label: field.name,
        hintType:
          field.fieldType === 'PHONE' || field.fieldType === 'ASSET_REFERENCE'
            ? 'TEXT'
            : field.fieldType === 'TEXTAREA'
              ? 'TEXTAREA'
              : field.fieldType,
        alwaysPresent: field.sourceField === 'breezeId',
      })) as SourceFieldDto[];
  }

  async fetchRecords(ctx: FetchRecordsContext, cursor: string | null): Promise<DriverFetchPage> {
    const resource = breezeResourceKeySchema.safeParse(ctx.resourceKey);
    if (!resource.success) throw new Error('Unknown Breeze resource.');
    const page = await this.client.fetchPage(ctx, {
      resource: resource.data,
      externalOrgId: ctx.externalOrgId,
      cursor,
      updatedSince: ctx.mode === 'full' ? null : ctx.updatedSince,
    });
    if (ctx.snapshotAt && page.snapshotAt !== ctx.snapshotAt) {
      throw new Error('Breeze partner API snapshot changed during traversal.');
    }
    validatePageOrdering(page.data, page.snapshotAt, ctx.mode, ctx.updatedSince);
    for (const blocked of page.blocked ?? []) {
      if (
        blocked.orgId !== ctx.externalOrgId ||
        blocked.resource !== BREEZE_ENDPOINT_BY_RESOURCE[resource.data]
      ) {
        throw new Error(
          'Breeze partner API returned blocked metadata for a different organization or resource.',
        );
      }
    }
    const transformed = [] as ReturnType<typeof transformBreezeRecord>;
    const inlineBlocked: Array<{ id: string; orgId: string }> = [];
    const boundedBlocked: Array<{ id: string; orgId: string }> = [];
    for (const record of page.data) {
      if (
        !record ||
        typeof record !== 'object' ||
        (record as Record<string, unknown>)['orgId'] !== ctx.externalOrgId
      ) {
        throw new Error('Breeze partner API returned a record for a different organization.');
      }
      try {
        transformed.push(...transformBreezeRecord(resource.data, record));
      } catch (error) {
        if (error instanceof BreezeSensitiveDefinitionError) {
          inlineBlocked.push({ id: error.sourceId, orgId: error.orgId });
        } else if (error instanceof BreezeBoundedDefinitionError) {
          boundedBlocked.push({ id: error.sourceId, orgId: error.orgId });
        } else {
          throw error;
        }
      }
    }
    const records = deduplicateDriverRecords(transformed);
    const highWater = ctx.mode === 'incremental' ? maxSourceUpdatedAt(page.data) : null;

    return {
      records,
      hasMore: page.hasMore,
      cursor: page.nextCursor,
      schemaVersion: page.schemaVersion,
      snapshotAt: page.snapshotAt,
      blockedInputs: [
        ...(page.blocked ?? []).map((blocked) => ({
        kind: 'secret_blocked' as const,
        externalId: `${blocked.orgId}:${resource.data}:${blocked.id}`,
        message: 'Breeze withheld a record because secret material was detected.',
        details: {
          reasonCode: blocked.reason,
          fieldPaths: blocked.fieldPaths,
          sourceResource: resource.data,
          sourceOrgId: blocked.orgId,
          sourceId: blocked.id,
        },
        })),
        ...inlineBlocked.map((blocked) => ({
          kind: 'secret_blocked' as const,
          externalId: `${blocked.orgId}:${resource.data}:${blocked.id}`,
          message: 'Breeze withheld a record because secret material was detected.',
          details: {
            reasonCode: 'secret_detected',
            fieldPaths: [],
            sourceResource: resource.data,
            sourceOrgId: blocked.orgId,
            sourceId: blocked.id,
          },
        })),
        ...boundedBlocked.map((blocked) => ({
          kind: 'validation' as const,
          externalId: `${blocked.orgId}:${resource.data}:${blocked.id}`,
          message: 'Breeze withheld a record because it exceeds a native field bound.',
          details: {
            reasonCode: 'bounded_input',
            sourceResource: resource.data,
            sourceOrgId: blocked.orgId,
            sourceId: blocked.id,
          },
        })),
      ],
      sourceHighWater: highWater,
      terminal: !page.hasMore,
    };
  }
}

function maxSourceUpdatedAt(records: unknown[]): string | null {
  let highWater: number | null = null;
  for (const raw of records) {
    const updatedAt = Date.parse((raw as { sourceUpdatedAt: string }).sourceUpdatedAt);
    if (highWater === null || updatedAt > highWater) highWater = updatedAt;
  }
  return highWater === null ? null : new Date(highWater).toISOString();
}

function deduplicateDriverRecords(records: DriverFetchPage['records']): DriverFetchPage['records'] {
  const byIdentity = new Map<string, DriverFetchPage['records'][number]>();
  for (const record of records) {
    const identity = record.reconstructionInput
      ? `${record.reconstructionInput.targetKind}:${record.reconstructionInput.externalId}`
      : `asset:${record.externalId}`;
    const existing = byIdentity.get(identity);
    if (existing) {
      const merged = mergeDriverRecords(existing, record);
      if (!merged) {
        throw new Error('Breeze partner API returned a conflicting duplicate stable identity.');
      }
      byIdentity.set(identity, merged);
    } else {
      byIdentity.set(identity, record);
    }
  }
  return convergeCanonicalIpamFacts([...byIdentity.values()]).sort((left, right) =>
    driverRecordIdentity(left).localeCompare(driverRecordIdentity(right)),
  );
}

function convergeCanonicalIpamFacts(
  records: DriverFetchPage['records'],
): DriverFetchPage['records'] {
  const output = [...records];
  const subnetIndexes = new Map<string, number[]>();
  for (const [index, record] of output.entries()) {
    const input = record.reconstructionInput;
    if (input?.targetKind !== 'subnet') continue;
    const indexes = subnetIndexes.get(input.cidr) ?? [];
    indexes.push(index);
    subnetIndexes.set(input.cidr, indexes);
  }
  for (const indexes of subnetIndexes.values()) {
    const inputs = indexes.map((index) => output[index]!.reconstructionInput!).filter(
      (input): input is Extract<NonNullable<typeof input>, { targetKind: 'subnet' }> =>
        input.targetKind === 'subnet',
    );
    const canonicalFacts = inputs.map(({ externalId: _externalId, source: _source, gateway: _gateway, ...facts }) =>
      JSON.stringify(facts),
    );
    if (new Set(canonicalFacts).size !== 1) {
      throw new Error('Breeze partner API returned conflicting canonical subnet facts.');
    }
    const gateways = [...new Set(inputs.map((input) => input.gateway).filter(Boolean))];
    if (gateways.length > 1) {
      throw new Error('Breeze partner API returned conflicting gateways for one canonical subnet.');
    }
    for (const index of indexes) {
      const record = output[index]!;
      const input = record.reconstructionInput;
      if (!input || input.targetKind !== 'subnet') continue;
      output[index] = {
        reconstructionInput: {
          ...input,
          gateway: gateways[0] ?? null,
        },
      };
    }
  }
  return output;
}

function driverRecordIdentity(record: DriverFetchPage['records'][number]): string {
  return record.reconstructionInput
    ? `${record.reconstructionInput.targetKind}:${record.reconstructionInput.externalId}`
    : `asset:${record.externalId}`;
}

function mergeDriverRecords(
  left: DriverFetchPage['records'][number],
  right: DriverFetchPage['records'][number],
): DriverFetchPage['records'][number] | null {
  const leftInput = left.reconstructionInput;
  const rightInput = right.reconstructionInput;
  if (leftInput?.targetKind === 'subnet' && rightInput?.targetKind === 'subnet') {
    const { source: _leftSource, gateway: leftGateway, ...leftFacts } = leftInput;
    const { source: _rightSource, gateway: rightGateway, ...rightFacts } = rightInput;
    if (JSON.stringify(leftFacts) !== JSON.stringify(rightFacts)) return null;
    if (leftGateway && rightGateway && leftGateway !== rightGateway) return null;
    const source = latestReconstructionSource(leftInput.source, rightInput.source);
    return {
      reconstructionInput: {
        ...leftInput,
        source,
        gateway: leftGateway ?? rightGateway ?? null,
      },
    };
  }
  if (driverRecordSemantics(left) !== driverRecordSemantics(right)) return null;
  return canonicalJsonChoice(left, right);
}

function canonicalJsonChoice<T>(left: T, right: T): T {
  return JSON.stringify(left).localeCompare(JSON.stringify(right)) <= 0 ? left : right;
}

function latestReconstructionSource<T extends { updatedAt?: string | null }>(left: T, right: T): T {
  const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : Number.NEGATIVE_INFINITY;
  const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : Number.NEGATIVE_INFINITY;
  if (leftTime !== rightTime) return leftTime > rightTime ? left : right;
  return canonicalJsonChoice(left, right);
}

function driverRecordSemantics(record: DriverFetchPage['records'][number]): string {
  if (record.reconstructionInput) {
    const input = record.reconstructionInput;
    return JSON.stringify({
      ...input,
      source: {
        externalOrgId: input.source.externalOrgId,
        resourceKey: input.source.resourceKey,
        sourceId: input.source.sourceId,
      },
    });
  }
  return JSON.stringify({
    externalId: record.externalId,
    displayName: record.displayName,
    fields: record.fields,
  });
}

function validatePageOrdering(
  records: unknown[],
  snapshotAt: string,
  mode: FetchRecordsContext['mode'],
  updatedSince: string | null,
): void {
  const snapshotMillis = Date.parse(snapshotAt);
  const updatedSinceMillis = updatedSince === null ? null : Date.parse(updatedSince);
  let previousMillis: number | null = null;
  for (const raw of records) {
    const sourceUpdatedAt = (raw as { sourceUpdatedAt?: unknown }).sourceUpdatedAt;
    const sourceMillis =
      typeof sourceUpdatedAt === 'string' ? Date.parse(sourceUpdatedAt) : Number.NaN;
    if (!Number.isFinite(sourceMillis) || sourceMillis > snapshotMillis) {
      throw new Error('Breeze sourceUpdatedAt must not exceed the traversal snapshot.');
    }
    if (
      mode === 'incremental' &&
      updatedSinceMillis !== null &&
      sourceMillis <= updatedSinceMillis
    ) {
      throw new Error('Breeze incremental records must be newer than updatedSince.');
    }
    if (mode === 'incremental' && previousMillis !== null && sourceMillis < previousMillis) {
      throw new Error('Breeze sourceUpdatedAt values must be ordered within each page.');
    }
    previousMillis = sourceMillis;
  }
}

function field(
  sourceField: string,
  name: string,
  slug: string,
  fieldType: Parameters<typeof typedField>[0],
  syncDirection: 'source_wins' | 'preserve_manual' | 'manual_only' = 'source_wins',
  isPrimary = false,
  showInTable = false,
  options: Record<string, unknown> = {},
) {
  return typedField(fieldType, {
    sourceField,
    name,
    slug,
    syncDirection,
    isPrimary,
    showInTable,
    options,
  });
}

function typedField(
  fieldType: RecommendedDestination['fields'][number]['fieldType'],
  rest: Omit<RecommendedDestination['fields'][number], 'fieldType'>,
) {
  return { ...rest, fieldType };
}

function resource(
  key: string,
  label: string,
  targetKind: string,
  targetConfig: Record<string, unknown>,
  dependsOnResourceKeys: readonly string[] = [],
) {
  return {
    key,
    label,
    targetKind,
    targetConfig,
    dependsOnResourceKeys: [...dependsOnResourceKeys],
  };
}

function uniqueFields(
  fields: readonly RecommendedDestination['fields'][number][],
): RecommendedDestination['fields'] {
  const bySlug = new Map<string, RecommendedDestination['fields'][number]>();
  for (const configured of fields) {
    if (!bySlug.has(configured.slug)) bySlug.set(configured.slug, configured);
  }
  return [...bySlug.values()];
}
