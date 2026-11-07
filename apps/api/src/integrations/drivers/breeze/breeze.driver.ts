import {
  driverDescriptorSchema,
  type SourceFieldDto,
  type SourceOrgDto,
} from '@weavestream/shared';
import type {
  DriverBlockedInput,
  DriverFetchPage,
  DriverRedaction,
  DriverSourceVersion,
  FetchRecordsContext,
  IntegrationContext,
  IntegrationDriver,
  RecommendedDestination,
} from '../integration-driver.js';
import { assertRecommendedDestinations } from '../driver-utils.js';
import {
  BREEZE_KNOWN_SCHEMA_VERSION,
  BreezePartnerApiClient,
  unknownSchemaVersionMessage,
  validateBreezeConfiguration,
} from './breeze-partner-api.client.js';
import {
  BREEZE_ENDPOINT_BY_RESOURCE,
  breezeBlockedRecordSchema,
  breezeResourceKeySchema,
  readBreezeRecordSafely,
  type BreezeBlockedRecord,
  type BreezeOrganization,
  type BreezePartnerEnvelope,
  type BreezeResourceKey,
} from './breeze.schemas.js';
import { observeBreezeFields } from './breeze-field-presence.js';
import {
  BreezeBoundedDefinitionError,
  BreezeRecordGapError,
  BreezeUnreadableRecordError,
  transformBreezeRecord,
  type BreezeRecordRedaction,
} from './breeze.transforms.js';

interface BreezeClientPort {
  testConnection(ctx: IntegrationContext): Promise<{ schemaVersion: string }>;
  /** Optional: a client without it reports no server version. */
  readServerVersion?(ctx: IntegrationContext): Promise<string | null>;
  listOrganizations(ctx: IntegrationContext): Promise<BreezeOrganization[]>;
  fetchPage(
    ctx: IntegrationContext,
    input: {
      resource: BreezeResourceKey;
      externalOrgId: string;
      cursor: string | null;
      updatedSince: string | null;
      acceptedSchemaVersion?: string | null;
      acceptAnySchemaVersion?: boolean;
    },
  ): Promise<BreezePartnerEnvelope<unknown>>;
}

const siteFields = [
  field('breezeId', 'Breeze ID', 'breeze_id', 'TEXT', 'source_wins'),
  field('name', 'Name', 'name', 'TEXT', 'preserve_manual', true, true),
  field('timezone', 'Timezone', 'timezone', 'TEXT'),
  field('addressLine1', 'Address Line 1', 'address_line_1', 'TEXT'),
  field('addressLine2', 'Address Line 2', 'address_line_2', 'TEXT'),
  field('city', 'City', 'city', 'TEXT'),
  field('region', 'Region', 'region', 'TEXT'),
  field('postalCode', 'Postal Code', 'postal_code', 'TEXT'),
  field('country', 'Country', 'country', 'TEXT'),
  field('contactName', 'Contact Name', 'contact_name', 'TEXT'),
  field('contactEmail', 'Contact Email', 'contact_email', 'EMAIL'),
  field('contactPhone', 'Contact Phone', 'contact_phone', 'PHONE'),
  field('sourceRevision', 'Source Revision', 'source_revision', 'TEXT'),
  field('sourceFingerprint', 'Source Fingerprint', 'source_fingerprint', 'TEXT'),
] as const;

const deviceIdentityFields = [
  field('breezeId', 'Breeze ID', 'breeze_id', 'TEXT', 'source_wins'),
  field('hostname', 'Hostname', 'hostname', 'TEXT', 'preserve_manual', true, true),
  field('displayName', 'Display Name', 'display_name', 'TEXT', 'preserve_manual'),
  field('deviceType', 'Type', 'device_type', 'TEXT'),
  field('deviceRole', 'Role', 'device_role', 'TEXT'),
  field('siteId', 'Site', 'site', 'TEXT'),
  field('vendor', 'Vendor', 'vendor', 'TEXT'),
  field('model', 'Model', 'model', 'TEXT'),
  field('serialNumber', 'Serial Number', 'serial_number', 'TEXT'),
  field('osEdition', 'OS Edition', 'os_edition', 'TEXT'),
  field('osBuild', 'OS Build', 'os_build', 'TEXT'),
  field('osArchitecture', 'OS Architecture', 'os_architecture', 'TEXT'),
  field('enrolledAt', 'Installed / Enrolled At', 'enrolled_at', 'DATETIME'),
  field('assetTag', 'Asset Tag', 'asset_tag', 'TEXT'),
  field('inventoryId', 'Inventory ID', 'inventory_id', 'TEXT'),
  field('upstreamExternalId', 'Upstream External ID', 'upstream_external_id', 'TEXT'),
  field('virtualizationRole', 'Virtualization Role', 'virtualization_role', 'TEXT'),
  field('tags', 'Tags', 'tags', 'TAGS'),
  field('sourceRevision', 'Source Revision', 'source_revision', 'TEXT'),
  field('sourceFingerprint', 'Source Fingerprint', 'source_fingerprint', 'TEXT'),
] as const;

const inventoryFields = [
  field('breezeId', 'Breeze ID', 'breeze_id', 'TEXT', 'source_wins'),
  field('processor', 'Processor', 'processor', 'TEXTAREA'),
  field('processorCores', 'Processor Cores', 'processor_cores', 'NUMBER'),
  field('processorThreads', 'Processor Threads', 'processor_threads', 'NUMBER'),
  field('memoryMb', 'Memory (MB)', 'memory_mb', 'NUMBER'),
  field('graphics', 'Graphics', 'graphics', 'TEXT'),
  field('motherboard', 'Motherboard', 'motherboard', 'TEXTAREA'),
  field('biosVersion', 'BIOS Version', 'bios_version', 'TEXT'),
  field('disks', 'Disks', 'disks', 'TEXTAREA'),
  field('interfaces', 'Interfaces', 'interfaces', 'TEXTAREA'),
  field('networkAddresses', 'Network Address History', 'network_addresses', 'TEXTAREA'),
  field('gateways', 'Gateways', 'gateways', 'TEXT'),
  field('dnsServers', 'DNS Servers', 'dns_servers', 'TEXT'),
  field('warrantyStatus', 'Warranty Status', 'warranty_status', 'TEXT'),
  field('warrantyStartsOn', 'Warranty Starts', 'warranty_starts_on', 'DATE'),
  field('warrantyEndsOn', 'Warranty Ends', 'warranty_ends_on', 'DATE', 'source_wins', false, true, {
    isExpiry: true,
  }),
  field('warrantySubscription', 'Warranty Subscription', 'warranty_subscription', 'BOOLEAN'),
  field('virtualMachines', 'Virtual Machines', 'virtual_machines', 'TEXTAREA'),
  field('inventoryCompleteness', 'Inventory Completeness', 'inventory_completeness', 'TEXTAREA'),
  field('sourceRevision', 'Source Revision', 'source_revision', 'TEXT'),
  field('sourceFingerprint', 'Source Fingerprint', 'source_fingerprint', 'TEXT'),
] as const;

const softwareFields = [
  field('breezeId', 'Breeze ID', 'breeze_id', 'TEXT', 'source_wins'),
  field('installedSoftware', 'Installed Software', 'installed_software', 'TEXTAREA'),
  field('softwareCompleteness', 'Software Completeness', 'software_completeness', 'TEXT'),
  field('sourceRevision', 'Source Revision', 'source_revision', 'TEXT'),
  field('sourceFingerprint', 'Source Fingerprint', 'source_fingerprint', 'TEXT'),
] as const;

const siteInventoryFields = [
  field('breezeId', 'Breeze ID', 'breeze_id', 'TEXT', 'source_wins'),
  field('networkEquipment', 'Network Equipment', 'network_equipment', 'TEXTAREA'),
  field('networkSegments', 'Network Segments', 'network_segments', 'TEXTAREA'),
  field('inventoryCompleteness', 'Inventory Completeness', 'inventory_completeness', 'TEXTAREA'),
  field('sourceRevision', 'Source Revision', 'source_revision', 'TEXT'),
  field('sourceFingerprint', 'Source Fingerprint', 'source_fingerprint', 'TEXT'),
] as const;

const equipmentFields = [
  field('breezeId', 'Breeze ID', 'breeze_id', 'TEXT', 'source_wins'),
  field('siteId', 'Site ID', 'site_id', 'TEXT'),
  field('equipmentType', 'Equipment Type', 'equipment_type', 'TEXT'),
  field('address', 'Address', 'address', 'IP_ADDRESS', 'source_wins', false, false, {
    version: 'any',
    allowCidr: false,
  }),
  field('macAddress', 'MAC Address', 'mac_address', 'TEXT'),
  field('manufacturer', 'Manufacturer', 'manufacturer', 'TEXT'),
  field('model', 'Model', 'model', 'TEXT'),
  field('url', 'URL', 'url', 'URL'),
  field('source', 'Source', 'source', 'TEXT'),
  field('sourceRevision', 'Source Revision', 'source_revision', 'TEXT'),
  field('sourceFingerprint', 'Source Fingerprint', 'source_fingerprint', 'TEXT'),
] as const;

const virtualMachineFields = [
  field('breezeId', 'Breeze ID', 'breeze_id', 'TEXT', 'source_wins'),
  field('hostDeviceId', 'Host Device ID', 'host_device_id', 'TEXT'),
  field('upstreamExternalId', 'Upstream External ID', 'upstream_external_id', 'TEXT'),
  field('generation', 'Generation', 'generation', 'NUMBER'),
  field('memoryMb', 'Memory (MB)', 'memory_mb', 'NUMBER'),
  field('processorCount', 'Processor Count', 'processor_count', 'NUMBER'),
  field('rctEnabled', 'RCT Enabled', 'rct_enabled', 'BOOLEAN'),
  field('passthroughDisks', 'Passthrough Disks', 'passthrough_disks', 'BOOLEAN'),
  field('sourceRevision', 'Source Revision', 'source_revision', 'TEXT'),
  field('sourceFingerprint', 'Source Fingerprint', 'source_fingerprint', 'TEXT'),
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
  layout: { name: 'Breeze Sites', slug: 'breeze_sites', icon: 'map-pin', color: 'teal' },
  fields: siteDestinationFields,
};
const deviceLayout = {
  name: 'Breeze Devices',
  slug: 'breeze_devices',
  icon: 'monitor',
  color: 'iris',
};

export const BREEZE_RECOMMENDED_DESTINATIONS: Readonly<Record<string, RecommendedDestination>> = assertRecommendedDestinations('breeze', {
  sites: siteDestination,
  devices: { layout: deviceLayout, fields: deviceDestinationFields },
  'site-inventory': { layout: siteDestination.layout, fields: siteInventoryFields },
  'device-inventory': { layout: deviceLayout, fields: inventoryFields },
  'device-software': { layout: deviceLayout, fields: softwareFields },
  'network-equipment': {
    layout: {
      name: 'Breeze Network Equipment',
      slug: 'breeze_network_equipment',
      icon: 'network',
      color: 'amber',
    },
    fields: equipmentFields,
  },
  'virtual-machines': {
    layout: {
      name: 'Breeze Virtual Machines',
      slug: 'breeze_virtual_machines',
      icon: 'server',
      color: 'violet',
    },
    fields: virtualMachineFields,
  },
  'custom-field-values': {
    layout: deviceLayout,
    fields: [],
  },
});

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
    // The key goes to baseUrl: moving it to a new host needs the key again.
    secretBoundConfigKeys: ['baseUrl'],
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
        sourceEndpoint: '/custom-field-values',
        bindingResourceKey: 'devices',
      }, ['devices', 'custom-fields']),
      resource(
        'device-relationships',
        'Device relationships',
        'relation',
        { sourceEndpoint: '/device-relationships' },
        // Only the resources an edge can point at (`RELATIONSHIP_RESOURCE_KEYS`
        // in breeze.transforms.ts). They order the run; an endpoint that is
        // not synced becomes a per-record gap, not a skipped resource.
        ['sites', 'devices', 'virtual-machines', 'network-equipment'],
        { defaultEnabled: false },
      ),
    ],
    capabilities: {
      kind: 'pull',
      listSourceOrgs: true,
      dryRun: true,
      ticketing: false,
      // Breeze syncs reconstruction dossiers, so its resources are scored
      // against the ten documentation capabilities after every sync.
      reconstructionCompleteness: true,
    },
  });

  constructor(private readonly client: BreezeClientPort = new BreezePartnerApiClient()) {}

  validateConfiguration(
    config: Record<string, unknown> | null | undefined,
    secret: Record<string, unknown> | null | undefined,
  ): void {
    validateBreezeConfiguration(config, secret);
  }

  async testConnection(ctx: IntegrationContext): Promise<{ ok: true; details?: string }> {
    // The server version is informational: a failed read never fails the test.
    const [{ schemaVersion }, serverVersion] = await Promise.all([
      this.client.testConnection(ctx),
      this.readServerVersion(ctx).catch(() => null),
    ]);
    const versions = serverVersion
      ? ` (Breeze ${serverVersion}, partner API schema version ${schemaVersion})`
      : ` (partner API schema version ${schemaVersion})`;
    const reached = `Reached Breeze Partner API${versions}.`;
    if (schemaVersion === BREEZE_KNOWN_SCHEMA_VERSION) return { ok: true, details: reached };
    return { ok: true, details: `${reached} ${unknownSchemaVersionMessage(schemaVersion)}` };
  }

  /**
   * Early warning: the Breeze release and partner API schema version, saved
   * on each sync run. Each half is read on its own and a failed read is
   * null; this method never throws.
   */
  async readSourceVersion(ctx: IntegrationContext): Promise<DriverSourceVersion> {
    const [server, schema] = await Promise.allSettled([
      this.readServerVersion(ctx),
      this.client.testConnection(ctx),
    ]);
    return {
      serverVersion: server.status === 'fulfilled' ? server.value : null,
      schemaVersion: schema.status === 'fulfilled' ? schema.value.schemaVersion : null,
    };
  }

  private async readServerVersion(ctx: IntegrationContext): Promise<string | null> {
    return this.client.readServerVersion ? this.client.readServerVersion(ctx) : null;
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
      acceptedSchemaVersion: ctx.acceptedSourceVersion ?? null,
      acceptAnySchemaVersion: ctx.acceptAnySourceVersion === true,
    });
    if (ctx.snapshotAt && page.snapshotAt !== ctx.snapshotAt) {
      throw new Error('Breeze partner API snapshot changed during traversal.');
    }
    const endpoint = BREEZE_ENDPOINT_BY_RESOURCE[resource.data];
    const namespacedId = (sourceId: string) => `${ctx.externalOrgId}:${resource.data}:${sourceId}`;
    // Hard stops are kept only for safety: data for another organization
    // than the one requested. Every other oddity costs the affected records
    // only (a `validation` gap: the record is skipped, its last-known-good
    // data is kept, and the traversal is non-authoritative, so no stale
    // sweep runs).
    const recordGaps: DriverBlockedInput[] = [];
    const breezeBlocked: BreezeBlockedRecord[] = [];
    for (const raw of page.blocked ?? []) {
      const rawOrgId = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)['orgId'] : undefined;
      if (rawOrgId !== undefined && rawOrgId !== ctx.externalOrgId) {
        throw new Error('Breeze partner API returned blocked metadata for a different organization.');
      }
      const blocked = readBreezeRecordSafely(breezeBlockedRecordSchema, raw);
      if (!blocked.success || blocked.data.orgId !== ctx.externalOrgId) {
        recordGaps.push(recordGap(resource.data, null, 'unreadable_blocked_notice',
          `Breeze withheld a ${resource.data} record, but Weavestream could not read which one. The other records in the page were synced.`));
        continue;
      }
      if (blocked.data.resource !== endpoint) {
        recordGaps.push(recordGap(resource.data, null, 'blocked_notice_other_resource',
          `Breeze reported a withheld record for another resource while Weavestream read ${resource.data}. The other records in the page were synced.`));
        continue;
      }
      breezeBlocked.push(blocked.data);
    }
    const transformed = [] as ReturnType<typeof transformBreezeRecord>;
    const redactions: DriverRedaction[] = [];
    for (const record of page.data) {
      if (
        !record ||
        typeof record !== 'object' ||
        (record as Record<string, unknown>)['orgId'] !== ctx.externalOrgId
      ) {
        throw new Error('Breeze partner API returned a record for a different organization.');
      }
      const rawId = (record as Record<string, unknown>)['id'];
      const sourceId = typeof rawId === 'string' && UUID_PATTERN.test(rawId) ? rawId : null;
      let redaction: BreezeRecordRedaction | null = null;
      try {
        transformed.push(...transformBreezeRecord(resource.data, record, (found) => {
          redaction = found;
        }));
      } catch (error) {
        recordGaps.push(transformErrorGap(resource.data, sourceId, namespacedId, error));
        continue;
      }
      if (redaction) {
        const found = redaction as BreezeRecordRedaction;
        redactions.push({
          externalId: `${found.orgId}:${resource.data}:${found.sourceId}`,
          count: found.count,
          fieldPaths: found.fieldPaths,
        });
      }
    }
    const deduplicated = deduplicateDriverRecords(transformed, namespacedId);
    recordGaps.push(...deduplicated.gaps.map((gap) => recordGap(
      resource.data, gap.externalId, gap.reasonCode, gap.message,
    )));
    const records = deduplicated.records;
    // Breeze documents `snapshotAt` as the consumer checkpoint: every change
    // up to it is in this traversal. It is constant across the traversal, so
    // the checkpoint does not depend on how Breeze orders records in a page.
    const highWater = ctx.mode === 'incremental' ? page.snapshotAt : null;

    return {
      records,
      hasMore: page.hasMore,
      cursor: page.nextCursor,
      schemaVersion: page.schemaVersion,
      snapshotAt: page.snapshotAt,
      // Key presence of the fields Weavestream reads, from the raw records,
      // so the runner can hold a page when Breeze stops sending one.
      observedFields: observeBreezeFields(endpoint, page.data),
      redactions,
      blockedInputs: [
        ...breezeBlocked.map((blocked) => ({
          kind: 'secret_blocked' as const,
          externalId: `${blocked.orgId}:${resource.data}:${blocked.id}`,
          message: `Breeze withheld a ${resource.data} record because it detected secret material in it. Remove the secret from the record in Breeze and rerun the sync.`,
          details: {
            reasonCode: blocked.reason,
            fieldPaths: blocked.fieldPaths,
            sourceResource: resource.data,
            sourceOrgId: blocked.orgId,
            sourceId: blocked.id,
          },
        })),
        ...recordGaps,
      ],
      sourceHighWater: highWater,
      terminal: !page.hasMore,
    };
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** A record-level `validation` gap: the record is skipped, nothing else. */
function recordGap(
  resource: BreezeResourceKey,
  externalId: string | null,
  reasonCode: string,
  message: string,
  extra: { fieldPaths?: string[]; sourceId?: string; sourceOrgId?: string } = {},
): DriverBlockedInput {
  return {
    kind: 'validation',
    externalId,
    message: boundStart(message, MAX_GAP_MESSAGE_LENGTH),
    details: {
      reasonCode,
      sourceResource: resource,
      ...(extra.fieldPaths && extra.fieldPaths.length > 0 ? { fieldPaths: extra.fieldPaths } : {}),
      ...(extra.sourceOrgId ? { sourceOrgId: extra.sourceOrgId } : {}),
      ...(extra.sourceId ? { sourceId: extra.sourceId } : {}),
    },
  };
}

/**
 * One record that could not be transformed becomes a gap for that record.
 * Only fixed reason codes and key paths go into the gap: an unexpected
 * error's message is never copied, because it could carry source text.
 */
function transformErrorGap(
  resource: BreezeResourceKey,
  sourceId: string | null,
  namespacedId: (sourceId: string) => string,
  error: unknown,
): DriverBlockedInput {
  const externalId = sourceId ? namespacedId(sourceId) : null;
  const ids = sourceId ? { sourceId } : {};
  if (error instanceof BreezeBoundedDefinitionError) {
    return recordGap(resource, externalId, 'bounded_input',
      `Weavestream withheld a ${resource} record because it exceeds a native field bound.`, ids);
  }
  if (error instanceof BreezeUnreadableRecordError) {
    // A record Weavestream could not read is skipped and the rest of the
    // page is written.
    return recordGap(resource, externalId, 'unreadable_source_record',
      `Weavestream skipped a ${resource} record it could not read. The other records in the page were synced.`,
      { ...ids, fieldPaths: error.fieldPaths });
  }
  if (error instanceof BreezeRecordGapError) {
    return recordGap(resource, externalId, error.reasonCode,
      `Weavestream skipped a ${resource} record whose data is inconsistent (${error.reasonCode}). The other records in the page were synced.`,
      { ...ids, fieldPaths: error.fieldPaths });
  }
  return recordGap(resource, externalId, 'record_transform_failed',
    `Weavestream skipped a ${resource} record it could not process. The other records in the page were synced.`, ids);
}

interface DeduplicationGap {
  externalId: string;
  reasonCode: string;
  message: string;
}

/**
 * Merge records that share one stable identity. Records that conflict (the
 * same identity with different data, or one network with different facts
 * or gateways) are all dropped from the page and reported as gaps: which
 * one is right is unknown, so the last-known-good data is kept.
 */
function deduplicateDriverRecords(
  records: DriverFetchPage['records'],
  namespacedId: (sourceId: string) => string,
): { records: DriverFetchPage['records']; gaps: DeduplicationGap[] } {
  const byIdentity = new Map<string, DriverFetchPage['records'][number]>();
  const conflicted = new Set<string>();
  const gaps: DeduplicationGap[] = [];
  for (const record of records) {
    const identity = driverRecordIdentity(record);
    if (conflicted.has(identity)) continue;
    const existing = byIdentity.get(identity);
    if (existing) {
      const merged = mergeDriverRecords(existing, record);
      if (!merged) {
        byIdentity.delete(identity);
        conflicted.add(identity);
        gaps.push({
          externalId: gapExternalId(record, namespacedId),
          reasonCode: 'conflicting_duplicate_identity',
          message: 'Breeze returned the same record twice with different data. Weavestream skipped it and kept the last synced version.',
        });
        continue;
      }
      byIdentity.set(identity, merged);
    } else {
      byIdentity.set(identity, record);
    }
  }
  const converged = convergeCanonicalIpamFacts([...byIdentity.values()], namespacedId);
  return {
    records: converged.records.sort((left, right) =>
      driverRecordIdentity(left).localeCompare(driverRecordIdentity(right)),
    ),
    gaps: [...gaps, ...converged.gaps],
  };
}

function gapExternalId(
  record: DriverFetchPage['records'][number],
  namespacedId: (sourceId: string) => string,
): string {
  return record.reconstructionInput
    ? record.reconstructionInput.externalId
    : namespacedId(record.externalId);
}

function convergeCanonicalIpamFacts(
  records: DriverFetchPage['records'],
  namespacedId: (sourceId: string) => string,
): { records: DriverFetchPage['records']; gaps: DeduplicationGap[] } {
  const output: Array<DriverFetchPage['records'][number] | null> = [...records];
  const gaps: DeduplicationGap[] = [];
  const subnetIndexes = new Map<string, number[]>();
  for (const [index, record] of output.entries()) {
    const input = record?.reconstructionInput;
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
    const gateways = [...new Set(inputs.map((input) => input.gateway).filter(Boolean))];
    if (new Set(canonicalFacts).size !== 1 || gateways.length > 1) {
      const reasonCode = new Set(canonicalFacts).size !== 1
        ? 'conflicting_subnet_facts'
        : 'conflicting_subnet_gateways';
      for (const index of indexes) {
        gaps.push({
          externalId: gapExternalId(output[index]!, namespacedId),
          reasonCode,
          message: 'Breeze reported one network with different gateways or facts. Weavestream skipped those network records and kept the last synced versions.',
        });
        output[index] = null;
      }
      continue;
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
  return {
    records: output.filter((record): record is DriverFetchPage['records'][number] => record !== null),
    gaps,
  };
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

// The runner rejects a gap message over 512 characters.
const MAX_GAP_MESSAGE_LENGTH = 500;

// Bounds count UTF-16 code units, as the runner's `message.length` check
// does, and never split a character. The ellipsis is one code unit.
function boundStart(value: string, max: number): string {
  if (value.length <= max) return value;
  let kept = '';
  for (const char of value) {
    if (kept.length + char.length > max - 1) break;
    kept += char;
  }
  return `${kept}…`;
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
  options: { defaultEnabled?: boolean } = {},
) {
  return {
    key,
    label,
    targetKind,
    targetConfig,
    dependsOnResourceKeys: [...dependsOnResourceKeys],
    ...options,
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
