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
import { transformBreezeRecord } from './breeze.transforms.js';

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
  field('cpu', 'CPU', 'cpu', 'TEXTAREA'),
  field('memoryBytes', 'Memory Bytes', 'memory-bytes', 'NUMBER'),
  field('firmware', 'Firmware', 'firmware', 'TEXTAREA'),
  field('disks', 'Disks', 'disks', 'TEXTAREA'),
  field('interfaces', 'Interfaces', 'interfaces', 'TEXTAREA'),
  field(
    'warrantyExpiry',
    'Warranty Expiry',
    'warranty-expiry',
    'DATETIME',
    'source_wins',
    false,
    true,
    { isExpiry: true },
  ),
  field(
    'supportExpiry',
    'Support Expiry',
    'support-expiry',
    'DATETIME',
    'source_wins',
    false,
    true,
    { isExpiry: true },
  ),
  field('sourceRevision', 'Source Revision', 'source-revision', 'TEXT'),
  field('sourceFingerprint', 'Source Fingerprint', 'source-fingerprint', 'TEXT'),
] as const;

const softwareFields = [
  field('breezeId', 'Breeze ID', 'breeze-id', 'TEXT', 'source_wins'),
  field('installedSoftware', 'Installed Software', 'installed-software', 'TEXTAREA'),
  field('sourceRevision', 'Source Revision', 'source-revision', 'TEXT'),
  field('sourceFingerprint', 'Source Fingerprint', 'source-fingerprint', 'TEXT'),
] as const;

const customFields = [
  field('breezeId', 'Breeze ID', 'breeze-id', 'TEXT', 'source_wins'),
  field(
    'selectedCustomFields',
    'Selected Custom Fields',
    'selected-custom-fields',
    'TEXTAREA',
    'preserve_manual',
  ),
  field('sourceRevision', 'Source Revision', 'source-revision', 'TEXT'),
  field('sourceFingerprint', 'Source Fingerprint', 'source-fingerprint', 'TEXT'),
] as const;

const deviceDestinationFields = uniqueFields([
  ...deviceIdentityFields,
  ...inventoryFields.map((item) => ({ ...item, mapResource: false as const })),
  ...softwareFields.map((item) => ({ ...item, mapResource: false as const })),
  ...customFields.map((item) => ({ ...item, mapResource: false as const })),
]);

const siteDestination: RecommendedDestination = {
  layout: { name: 'Breeze Sites', slug: 'breeze-sites', icon: 'map-pin', color: 'teal' },
  fields: siteFields,
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
  'device-inventory': { layout: deviceLayout, fields: inventoryFields },
  'device-software': { layout: deviceLayout, fields: softwareFields },
  'custom-fields': { layout: deviceLayout, fields: customFields },
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
        'subnets',
        'Subnets',
        'subnet',
        { sourceEndpoint: '/device-inventory', normalization: 'cidr' },
        ['devices'],
      ),
      resource(
        'ip-reservations',
        'IP reservations',
        'ip_reservation',
        { sourceEndpoint: '/device-inventory', normalization: 'ip' },
        ['subnets', 'devices'],
      ),
      resource('configuration-policies', 'Configuration policies', 'article', {
        sourceEndpoint: '/configuration-policies',
        folderSlug: 'breeze-configuration-policies',
        visibility: 'internal',
      }),
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
      resource('backup-configurations', 'Backup configurations', 'article', {
        sourceEndpoint: '/backup-configurations',
        folderSlug: 'breeze-backup-configurations',
        visibility: 'internal',
      }),
      resource(
        'custom-fields',
        'Custom fields',
        'asset',
        { sourceEndpoint: '/custom-fields', bindingResourceKey: 'devices' },
        ['devices'],
      ),
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
    const records = page.data.flatMap((record) => {
      if (
        !record ||
        typeof record !== 'object' ||
        (record as Record<string, unknown>)['orgId'] !== ctx.externalOrgId
      ) {
        throw new Error('Breeze partner API returned a record for a different organization.');
      }
      return transformBreezeRecord(resource.data, record);
    });
    const highWater =
      ctx.mode === 'incremental' && !page.hasMore ? maxSourceUpdatedAt(page.data) : null;

    return {
      records,
      hasMore: page.hasMore,
      cursor: page.nextCursor,
      schemaVersion: page.schemaVersion,
      snapshotAt: page.snapshotAt,
      blockedInputs: (page.blocked ?? []).map((blocked) => ({
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
      sourceHighWater: highWater,
      terminal: !page.hasMore,
    };
  }
}

function maxSourceUpdatedAt(records: unknown[]): string | null {
  let highWater: string | null = null;
  for (const raw of records) {
    const updatedAt = (raw as { sourceUpdatedAt: string }).sourceUpdatedAt;
    if (!highWater || updatedAt > highWater) highWater = updatedAt;
  }
  return highWater;
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
