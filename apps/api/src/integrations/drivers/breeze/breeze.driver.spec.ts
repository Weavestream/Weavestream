import { createHash } from 'node:crypto';
import type { FetchRecordsContext, IntegrationContext } from '../integration-driver.js';
import { driverDescriptorSchema, fieldSlugSchema, layoutSlugSchema } from '@weavestream/shared';
import { assertRecommendedDestinations } from '../driver-utils.js';
import { BreezeDriver } from './breeze.driver.js';
import {
  BreezeBoundedDefinitionError,
  BreezeRecordGapError,
  transformBreezeRecord,
  type BreezeRecordRedaction,
} from './breeze.transforms.js';
import { TextStrategy, TextareaStrategy } from '../../../field-types/strategies/text.strategy.js';
import {
  MAX_RECONSTRUCTION_INPUT_BYTES,
  articleReconstructionInputSchema,
  reconstructionInputByteLength,
} from '../../reconstruction/reconstruction-target.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const DISK = '44444444-4444-4444-8444-444444444444';
const INTERFACE = '55555555-5555-4555-8555-555555555555';
const STATIC_ADDRESS = '66666666-6666-4666-8666-666666666666';
const DYNAMIC_ADDRESS = '77777777-7777-4777-8777-777777777777';
const VM = '88888888-8888-4888-8888-888888888888';
const EQUIPMENT = '99999999-9999-4999-8999-999999999999';
const SEGMENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOFTWARE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REVISION = 'a'.repeat(64);
const UPDATED = '2026-07-14T11:00:00.000Z';
const UPDATED_SINCE = '2026-07-14T10:00:00.000Z';

const base = { id: DEVICE, orgId: ORG, siteId: SITE, sourceUpdatedAt: UPDATED, revision: REVISION };

// Credential-shaped fixtures are assembled at runtime from a deterministic
// non-secret sequence so no secret-shaped literal exists in source (§2) and
// no secret scanner can match the committed file. Each still has the mixed
// alphabet and entropy of the real thing.
const FIXTURE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function syntheticToken(length: number, stride: number): string {
  return Array.from({ length }, (_, index) => FIXTURE_ALPHABET[(index * stride) % FIXTURE_ALPHABET.length]).join('');
}
/** Same shape as a Google API key: the `AIza` prefix and 35 URL-safe characters. */
function syntheticGoogleApiKey(): string {
  return ['AI', 'za'].join('') + syntheticToken(35, 7);
}
/** Same shape as a signed JWT: two base64url JSON segments and a 43-character signature. */
function syntheticJwt(): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [segment({ alg: 'HS256', typ: 'JWT' }), segment({ sub: 'fixture' }), syntheticToken(43, 11)].join('.');
}
const token = syntheticToken;
const PLAIN = ['hunter', '2'].join('');
const WITHHELD = '[withheld]';

/** The record-gap reason a transform threw, or what else happened. */
function gapReason(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof BreezeRecordGapError ? error.reasonCode : 'other error';
  }
  return 'no error';
}

/** Transform one record and collect what was withheld in it. */
function transformWithRedactions(resource: Parameters<typeof transformBreezeRecord>[0], record: unknown) {
  const redactions: BreezeRecordRedaction[] = [];
  const records = transformBreezeRecord(resource, record, (found) => redactions.push(found));
  const input = records[0]?.reconstructionInput;
  return {
    records,
    redactions,
    text: JSON.stringify(records),
    markdown: input?.targetKind === 'article' ? input.markdown : '',
  };
}
const completeCollection = { total: 1, included: 1, complete: true, reason: null } as const;
const deviceInventory = {
  ...base,
  subjectType: 'device' as const,
  deviceId: DEVICE,
  hardware: {
    processor: { model: 'Intel Xeon W-2245', cores: 8, threads: 16 },
    memory: { totalMb: 32768 },
    graphics: { model: 'NVIDIA T1000' },
    motherboard: { manufacturer: 'Dell', product: '0ABC', version: 'A01' },
    firmware: { biosVersion: '1.2.3' },
  },
  disks: [{ id: DISK, mountPoint: 'C:', device: 'Disk 0', fileSystem: 'NTFS', totalGb: 512 }],
  interfaces: [{ id: INTERFACE, name: 'Ethernet', macAddress: '00:11:22:33:44:55', primary: true }],
  addresses: [
    {
      id: STATIC_ADDRESS,
      interfaceId: INTERFACE,
      interfaceName: 'Ethernet',
      address: '10.20.0.50',
      family: 'ipv4' as const,
      assignment: 'static' as const,
      reservationEligible: true,
      subnetMask: '255.255.255.0',
      gateway: '10.20.0.1',
      dnsServers: ['10.20.0.2', '1.1.1.1'],
      active: true,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      deactivatedAt: null,
    },
    {
      id: DYNAMIC_ADDRESS,
      interfaceId: INTERFACE,
      interfaceName: 'Ethernet',
      address: '10.20.0.99',
      family: 'ipv4' as const,
      assignment: 'dhcp' as const,
      reservationEligible: false,
      subnetMask: '255.255.255.0',
      gateway: '10.20.0.1',
      dnsServers: ['10.20.0.2'],
      active: true,
      firstSeenAt: '2026-02-01T00:00:00.000Z',
      deactivatedAt: null,
    },
  ],
  warranty: {
    status: 'active' as const,
    startsOn: '2025-01-01',
    endsOn: '2028-01-01',
    subscription: false,
  },
  virtualMachines: [
    {
      id: VM,
      externalId: 'vm-guid-1',
      name: 'Build VM',
      generation: 2,
      memoryMb: 8192,
      processorCount: 4,
      rctEnabled: true,
      passthroughDisks: false,
    },
  ],
  collections: {
    disks: completeCollection,
    interfaces: completeCollection,
    addresses: { total: 2, included: 2, complete: true, reason: null },
    virtualMachines: completeCollection,
  },
};

const siteInventory = {
  ...base,
  id: SITE,
  subjectType: 'site' as const,
  siteSubjectId: SITE,
  networkEquipment: [
    {
      id: EQUIPMENT,
      type: 'switch' as const,
      name: 'Core Switch',
      address: '10.20.0.2',
      macAddress: '00:aa:bb:cc:dd:ee',
      manufacturer: 'Cisco',
      model: 'C9300',
    },
  ],
  networkSegments: [{ id: SEGMENT, cidr: '10.20.0.50/24' }],
  collections: { networkEquipment: completeCollection, networkSegments: completeCollection },
};
const device = {
  ...base,
  hostname: 'ws\0-01',
  displayName: 'Workstation\0 01',
  type: { os: 'windows', role: 'workstation', virtual: false, virtualizationPlatform: null },
  operatingSystem: { edition: 'Windows 11 Pro', build: '26100', architecture: 'x64' },
  installation: { enrolledAt: '2025-01-01T00:00:00.000Z' },
  hardwareIdentity: { serialNumber: 'SER-1', manufacturer: 'Dell', model: 'Latitude' },
  stableIdentifiers: { assetTag: 'AT-1', inventoryId: null, externalId: null },
  tags: ['managed'],
  groupIds: [],
  groupMembership: { total: 0, included: 0, complete: true, reason: null },
  linkGroupId: null,
  linkGroupRole: null,
};

function ctx(resourceKey = 'devices'): FetchRecordsContext {
  return {
    config: { baseUrl: 'https://breeze.example.test' },
    secret: { apiKey: 'key' },
    http: { timeoutMs: 100, maxRetries: 0, backoffMs: 0 },
    correlationId: 'corr',
    externalOrgId: ORG,
    resourceKey,
    filter: {},
    mode: 'incremental',
    updatedSince: UPDATED_SINCE,
    snapshotAt: null,
  };
}

describe('BreezeDriver descriptor', () => {
  it('rejects non-exact config/secret bundles before persistence', () => {
    const driver = new BreezeDriver();
    expect(() =>
      driver.validateConfiguration?.(
        { baseUrl: 'https://user:password@breeze.example.test' },
        { apiKey: 'key' },
      ),
    ).toThrow(/baseUrl/i);
    expect(() =>
      driver.validateConfiguration?.(
        { baseUrl: 'https://breeze.example.test', extra: true },
        { apiKey: 'key' },
      ),
    ).toThrow();
    expect(() =>
      driver.validateConfiguration?.(
        { baseUrl: 'https://breeze.example.test' },
        { apiKey: 'key', extra: 'secret' },
      ),
    ).toThrow();
  });

  it('parses through the shared schema and advertises the exact resources and dependencies', () => {
    const descriptor = driverDescriptorSchema.parse(new BreezeDriver().descriptor);
    expect(descriptor.capabilities).toEqual({
      kind: 'pull',
      listSourceOrgs: true,
      dryRun: true,
      ticketing: false,
      reconstructionCompleteness: true,
    });
    expect(descriptor.configFields.map((field) => field.key)).toEqual(['baseUrl']);
    expect(descriptor.secretFields.map((field) => field.key)).toEqual(['apiKey']);
    expect(
      descriptor.resources.map(({ key, targetKind, dependsOnResourceKeys, targetConfig }) => ({
        key,
        targetKind,
        dependsOnResourceKeys,
        targetConfig,
      })),
    ).toEqual([
      {
        key: 'sites',
        targetKind: 'asset',
        dependsOnResourceKeys: [],
        targetConfig: { sourceEndpoint: '/sites' },
      },
      {
        key: 'devices',
        targetKind: 'asset',
        dependsOnResourceKeys: ['sites'],
        targetConfig: { sourceEndpoint: '/devices' },
      },
      {
        key: 'site-inventory',
        targetKind: 'asset',
        dependsOnResourceKeys: ['sites'],
        targetConfig: { sourceEndpoint: '/device-inventory', bindingResourceKey: 'sites' },
      },
      {
        key: 'device-inventory',
        targetKind: 'asset',
        dependsOnResourceKeys: ['devices'],
        targetConfig: { sourceEndpoint: '/device-inventory', bindingResourceKey: 'devices' },
      },
      {
        key: 'device-software',
        targetKind: 'asset',
        dependsOnResourceKeys: ['devices'],
        targetConfig: { sourceEndpoint: '/device-software', bindingResourceKey: 'devices' },
      },
      {
        key: 'network-equipment',
        targetKind: 'asset',
        dependsOnResourceKeys: ['sites'],
        targetConfig: { sourceEndpoint: '/device-inventory' },
      },
      {
        key: 'virtual-machines',
        targetKind: 'asset',
        dependsOnResourceKeys: ['devices'],
        targetConfig: { sourceEndpoint: '/device-inventory' },
      },
      {
        key: 'subnets',
        targetKind: 'subnet',
        dependsOnResourceKeys: ['site-inventory', 'device-inventory'],
        targetConfig: { sourceEndpoint: '/device-inventory', normalization: 'cidr' },
      },
      {
        key: 'ip-reservations',
        targetKind: 'ip_reservation',
        dependsOnResourceKeys: ['subnets', 'device-inventory'],
        targetConfig: { sourceEndpoint: '/device-inventory', normalization: 'ip' },
      },
      {
        key: 'configuration-policies',
        targetKind: 'article',
        dependsOnResourceKeys: [],
        targetConfig: {
          sourceEndpoint: '/configuration-policies',
          folderSlug: 'breeze-configuration-policies',
          visibility: 'internal',
        },
      },
      {
        key: 'configuration-assignments', targetKind: 'article',
        dependsOnResourceKeys: ['configuration-policies'],
        targetConfig: { sourceEndpoint: '/configuration-assignments', folderSlug: 'breeze-configuration-assignments', visibility: 'internal' },
      },
      {
        key: 'configuration-assignment-relations', targetKind: 'relation',
        dependsOnResourceKeys: ['configuration-policies', 'configuration-assignments', 'sites', 'devices'],
        targetConfig: { sourceEndpoint: '/configuration-assignments' },
      },
      {
        key: 'scripts',
        targetKind: 'article',
        dependsOnResourceKeys: [],
        targetConfig: {
          sourceEndpoint: '/scripts',
          folderSlug: 'breeze-scripts',
          visibility: 'internal',
        },
      },
      {
        key: 'automations',
        targetKind: 'article',
        dependsOnResourceKeys: ['scripts'],
        targetConfig: {
          sourceEndpoint: '/automations',
          folderSlug: 'breeze-automations',
          visibility: 'internal',
        },
      },
      {
        key: 'automation-relations', targetKind: 'relation',
        dependsOnResourceKeys: ['automations', 'scripts'], targetConfig: { sourceEndpoint: '/automations' },
      },
      {
        key: 'backup-configurations',
        targetKind: 'article',
        dependsOnResourceKeys: [],
        targetConfig: {
          sourceEndpoint: '/backup-configurations',
          folderSlug: 'breeze-backup-configurations',
          visibility: 'internal',
        },
      },
      {
        key: 'backup-configuration-relations', targetKind: 'relation',
        dependsOnResourceKeys: ['backup-configurations'], targetConfig: { sourceEndpoint: '/backup-configurations' },
      },
      {
        key: 'custom-fields',
        targetKind: 'article',
        dependsOnResourceKeys: [],
        targetConfig: { sourceEndpoint: '/custom-fields', folderSlug: 'breeze-custom-fields', visibility: 'internal' },
      },
      {
        key: 'custom-field-values', targetKind: 'asset',
        dependsOnResourceKeys: ['devices', 'custom-fields'],
        targetConfig: { sourceEndpoint: '/custom-field-values', bindingResourceKey: 'devices' },
      },
      {
        key: 'device-relationships',
        targetKind: 'relation',
        dependsOnResourceKeys: ['sites', 'devices', 'virtual-machines', 'network-equipment'],
        targetConfig: { sourceEndpoint: '/device-relationships' },
      },
    ]);
    // Device relationships seeds disabled; every other resource keeps the
    // enabled-by-default behavior.
    expect(
      descriptor.resources
        .filter((resource) => resource.defaultEnabled === false)
        .map((resource) => resource.key),
    ).toEqual(['device-relationships']);
  });

  it('recommends deterministic site/device destinations without status or last-seen fields', () => {
    const recommendations = new BreezeDriver().recommendedDestinations;
    expect(recommendations?.sites?.layout.slug).toBe('breeze_sites');
    expect(recommendations?.devices?.layout.slug).toBe('breeze_devices');
    expect(recommendations?.['device-inventory']?.layout.slug).toBe('breeze_devices');
    const serialized = JSON.stringify(recommendations).toLowerCase();
    expect(serialized).not.toMatch(
      /live.?status|last.?seen|heartbeat|uptime|alert|vulnerab|patch|metric|session|command/,
    );
    expect(recommendations?.devices?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'breeze_id' }),
        expect.objectContaining({ slug: 'hostname' }),
        expect.objectContaining({ slug: 'warranty_ends_on', options: { isExpiry: true } }),
        expect.objectContaining({ slug: 'installed_software' }),
      ]),
    );
    expect(recommendations?.['device-inventory']?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'warranty_subscription', fieldType: 'BOOLEAN' }),
      ]),
    );
    expect(recommendations?.['network-equipment']?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: 'address',
          fieldType: 'IP_ADDRESS',
          options: { version: 'any', allowCidr: false },
        }),
      ]),
    );
    expect(recommendations?.['virtual-machines']?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'rct_enabled', fieldType: 'BOOLEAN' }),
        expect.objectContaining({ slug: 'passthrough_disks', fieldType: 'BOOLEAN' }),
      ]),
    );
  });

  // The driver used to mint kebab-case slugs. `ensureResourceDestination`
  // writes layouts and fields straight through Prisma, so nothing on that
  // path re-validates them and every activation created rows the layout
  // builder and the `field.<slug>=` filter DSL both reject.
  it('recommends only snake_case layout and field slugs', () => {
    const recommendations = new BreezeDriver().recommendedDestinations ?? {};
    for (const [resourceKey, destination] of Object.entries(recommendations)) {
      expect({ resourceKey, slug: destination.layout.slug }).toEqual({
        resourceKey,
        slug: expect.stringMatching(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/),
      });
      expect(layoutSlugSchema.safeParse(destination.layout.slug).success).toBe(true);
      for (const field of destination.fields) {
        expect({ resourceKey, slug: field.slug }).toEqual({
          resourceKey,
          slug: expect.stringMatching(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/),
        });
        expect(fieldSlugSchema.safeParse(field.slug).success).toBe(true);
      }
    }
  });

  it('rejects a driver whose recommendation reintroduces a kebab-case slug', () => {
    expect(() =>
      assertRecommendedDestinations('breeze', {
        devices: {
          layout: { name: 'Breeze Devices', slug: 'breeze-devices', icon: 'monitor', color: 'iris' },
          fields: [],
        },
      }),
    ).toThrow(/layout slug "breeze-devices" is invalid/);
    expect(() =>
      assertRecommendedDestinations('breeze', {
        devices: {
          layout: { name: 'Breeze Devices', slug: 'breeze_devices', icon: 'monitor', color: 'iris' },
          fields: [
            {
              sourceField: 'breezeId',
              name: 'Breeze ID',
              slug: 'breeze-id',
              fieldType: 'TEXT',
              syncDirection: 'source_wins',
              isPrimary: false,
              showInTable: false,
              options: {},
            },
          ],
        },
      }),
    ).toThrow(/field slug "breeze-id" is invalid/);
  });
});

describe('Breeze transforms', () => {
  it('renders exact desired-configuration DTOs as deterministic rebuild-safe Markdown', () => {
    const policyId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const scriptId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const destinationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const article = (resource: Parameters<typeof transformBreezeRecord>[0], value: unknown) =>
      (transformBreezeRecord(resource, value)[0] as { reconstructionInput: Record<string, any> })
        .reconstructionInput;

    const policy = article('configuration-policies', {
      ...base, id: policyId, siteId: null, sourceScope: 'organization', name: 'Server baseline',
      description: 'Durable desired state', status: 'active',
      features: [{ id: SEGMENT, type: 'patch', policyId: null, settings: { rebootPolicy: 'if_required' } }],
    });
    expect(policy).toMatchObject({
      slug: `configuration-policies-${policyId}`,
      folderSlug: 'breeze-configuration-policies',
      markdown: expect.stringContaining('## Policy features'),
    });
    expect(policy.markdown).toContain('rebootPolicy');
    expect(policy.markdown).toContain(`Source fingerprint: ${REVISION}`);
    expect(policy.markdown).toContain('<!-- weavestream:breeze:managed:start -->');

    const assignment = article('configuration-assignments', {
      ...base, id: SEGMENT, siteId: null, policyId, policyName: 'Server baseline',
      sourceScope: 'organization', level: 'site', targetId: SITE, priority: 10,
      roleFilter: ['server'], osFilter: ['windows'],
    });
    expect(assignment.markdown).toContain('Target level: site');
    expect(assignment.markdown).toContain('Role filter: server');
    const assignmentRelations = transformBreezeRecord('configuration-assignment-relations', {
      ...base, id: SEGMENT, siteId: null, policyId, policyName: 'Server baseline',
      sourceScope: 'organization', level: 'site', targetId: SITE, priority: 10,
      roleFilter: ['server'], osFilter: ['windows'],
    }) as Array<{ reconstructionInput: Record<string, any> }>;
    expect(assignmentRelations.map(({ reconstructionInput }) => reconstructionInput)).toEqual(expect.arrayContaining([
      expect.objectContaining({ relationType: 'configuration_policy', targetRef: { resourceKey: 'configuration-policies', externalId: `${ORG}:configuration-policies:${policyId}` } }),
      expect.objectContaining({ relationType: 'applies_to', targetRef: { resourceKey: 'sites', externalId: `${ORG}:sites:${SITE}` } }),
    ]));

    const script = article('scripts', {
      ...base, id: scriptId, siteId: null, sourceScope: 'partner', name: 'Install database',
      description: 'Rebuild procedure', category: 'build', osTypes: ['linux'], language: 'bash',
      content: 'dnf install postgresql17', parameters: [{ name: 'cluster', required: true }],
      timeoutSeconds: 900, runAs: 'elevated', version: 4,
      exitCodeSeverityMapping: { '0': null, '1': 'high' },
    });
    expect(script.markdown).toContain('```bash\ndnf install postgresql17\n```');
    expect(script.markdown).toContain('## Parameters');
    expect(script.markdown).toContain('## Exit-code severity mapping');

    const automation = article('automations', {
      ...base, siteId: null, sourceScope: 'partner', name: 'Rebuild application', description: null,
      enabled: true, trigger: { type: 'manual' }, conditions: null,
      actions: [{ type: 'run_script', scriptId }, { type: 'reboot' }], onFailure: 'stop',
      notificationTargets: null, dependencies: [{ resource: 'scripts', id: scriptId }],
    });
    expect(automation.markdown.indexOf('1.')).toBeLessThan(automation.markdown.indexOf('2.'));
    const automationRelations = transformBreezeRecord('automation-relations', {
      ...base, siteId: null, sourceScope: 'partner', name: 'Rebuild application', description: null,
      enabled: true, trigger: { type: 'manual' }, conditions: null,
      actions: [{ type: 'run_script', scriptId }, { type: 'reboot' }], onFailure: 'stop',
      notificationTargets: null, dependencies: [{ resource: 'scripts', id: scriptId }],
    }) as Array<{ reconstructionInput: Record<string, any> }>;
    expect(automationRelations.map(({ reconstructionInput }) => reconstructionInput)).toEqual([
      expect.objectContaining({ relationType: 'automation_script', targetRef: { resourceKey: 'scripts', externalId: `${ORG}:scripts:${scriptId}` } }),
    ]);

    const backup = article('backup-configurations', {
      ...base, id: destinationId, siteId: null, kind: 'destination', sourceScope: 'organization',
      name: 'Primary offsite', type: 'system_image', provider: 's3', compression: true,
      encryption: true, active: true, default: true,
      schedule: { cron: '0 2 * * *', timezone: 'America/Denver' }, retention: { daily: 14 },
      exclusions: ['/var/cache'],
    });
    expect(backup.markdown).toContain('Provider: s3');
    expect(backup.markdown).toContain('- /var/cache');
    expect(JSON.stringify(backup)).not.toMatch(/providerConfig|encryptionKey|restoreJobs/);

    const profile = article('backup-configurations', {
      ...base, id: SEGMENT, siteId: null, kind: 'profile', sourceScope: 'partner', name: 'File profile',
      description: 'Selected files', active: true, selections: { paths: ['/srv/data'] },
      destinationId: destinationId, schedule: null, retention: null, exclusions: ['*.tmp'],
    });
    expect(profile.markdown).toContain('## Selections');
    expect(profile.markdown).toContain('/srv/data');
    const policyBackupId = 'abababab-abab-4bab-8bab-abababababab';
    const policyBackup = article('backup-configurations', {
      ...base, id: policyBackupId, siteId: null, kind: 'policy', sourceScope: 'organization',
      name: 'Server backup', enabled: true, destinationId, targets: { roles: ['server'] },
      schedule: { cron: '0 1 * * *' }, retention: { daily: 14 }, exclusions: [],
      gfs: { monthly: 12 }, legalHold: true,
      legalHoldReason: 'Case 42', bandwidthLimitMbps: 100, backupWindowStart: '01:00',
      backupWindowEnd: '05:00', priority: 5,
    });
    expect(policyBackup.markdown).toContain('Legal hold: yes');
    expect(policyBackup.markdown).toContain('## Targets');
    const backupRelations = transformBreezeRecord('backup-configuration-relations', {
      ...base, id: policyBackupId, siteId: null, kind: 'policy', sourceScope: 'organization',
      name: 'Server backup', enabled: true, destinationId, targets: { roles: ['server'] },
      schedule: null, retention: null, exclusions: [],
      gfs: null, legalHold: false, legalHoldReason: null, bandwidthLimitMbps: null,
      backupWindowStart: null, backupWindowEnd: null, priority: null,
    }) as Array<{ reconstructionInput: Record<string, any> }>;
    expect(backupRelations[0]!.reconstructionInput).toMatchObject({
      relationType: 'backup_destination',
      targetRef: { resourceKey: 'backup-configurations', externalId: `${ORG}:backup-configurations:${destinationId}` },
    });

    for (const rendered of [policy, assignment, script, automation, backup]) {
      expect(rendered.slug.length).toBeLessThanOrEqual(80);
      expect(reconstructionInputByteLength(rendered)).toBeLessThanOrEqual(
        MAX_RECONSTRUCTION_INPUT_BYTES,
      );
      expect(articleReconstructionInputSchema.safeParse(rendered).success).toBe(true);
    }
  });

  it('strips unknown desired-configuration keys and withholds secret values in place', () => {
    const safeScript = {
      ...base, siteId: null, sourceScope: 'organization', name: 'Install', description: null,
      category: null, osTypes: ['linux'], language: 'bash', content: 'true', parameters: null,
      timeoutSeconds: 30, runAs: 'system', version: 1, exitCodeSeverityMapping: null,
    };
    // A key Breeze adds later is dropped before redaction, rendering, and storage.
    expect(JSON.stringify(transformBreezeRecord('scripts', {
      ...safeScript, providerConfig: { accessToken: 'added-later' },
    }))).not.toMatch(/providerConfig|added-later/u);
    const script = transformWithRedactions('scripts', { ...safeScript, content: `export TOKEN=${PLAIN}\necho done` });
    expect(script.text).not.toContain(PLAIN);
    expect(script.markdown).toContain(`export TOKEN=${WITHHELD}`);
    expect(script.markdown).toContain('echo done');
    expect(script.redactions).toEqual([{ sourceId: DEVICE, orgId: ORG, count: 1, fieldPaths: ['content'] }]);

    const policy = (settings: Record<string, unknown>) => ({
      ...base, siteId: null, sourceScope: 'organization', name: 'Safe policy', description: null,
      status: 'active', features: [{ id: SEGMENT, type: 'settings', policyId: null, settings }],
    });
    for (const settings of [
      { tokenize: true, secretary: 'Alice', policyEnabled: true },
      // A credential-named field with no text or number in it holds no secret
      // (issue 112: an empty S3 destination form in a backup feature).
      { passwordPolicyEnabled: true },
      { providerConfig: {} },
      { destination: { name: '', bucket: '', accessKeyId: '', secretAccessKey: '  ' } },
      // A setting about a credential is not one.
      { passwordMinLength: 12, tokenExpiryDays: 30 },
      // A value the source already masked.
      { password: '********' },
    ]) {
      expect(transformWithRedactions('configuration-policies', policy(settings)).redactions).toEqual([]);
    }
    for (const [settings, path, secret] of [
      [{ providerConfig: { region: 'eu' } }, 'features[0].settings.providerConfig', 'eu'],
      [{ secretAccessKey: 'abc' }, 'features[0].settings.secretAccessKey', 'abc'],
      [{ pin: { password: 1234 } }, 'features[0].settings.pin.password', '1234'],
      [{ nested: { accessToken: 'ordinary' } }, 'features[0].settings.nested.accessToken', 'ordinary'],
      [{ value: token(48, 11) }, 'features[0].settings.value', token(48, 11)],
    ] as const) {
      const result = transformWithRedactions('configuration-policies', policy({ ...settings, keep: 'visible' }));
      expect(result.records).toHaveLength(1);
      expect(result.markdown).not.toContain(`"${secret}"`);
      expect(result.markdown).not.toContain(`:${secret}}`);
      expect(result.markdown).toContain('visible');
      expect(result.redactions[0]?.fieldPaths).toEqual([path]);
    }
  });

  it.each([
    'Windows-Defender-Realtime-Protection-Policy',
    'Veeam-Agent-Backup-Job-Daily-Full-Retain-14-Days',
    'Install-WindowsUpdate-AcceptAll-AutoReboot',
    'ThisIsAnOrdinaryDescriptionWithoutSpaces',
    'srv-fileserver-primary-datacenter-01',
    'https://downloads.example.com/agent/windows/x64/latest/agent-installer.exe',
    'Windows-Update-Policy-For-All-Workstations',
    'Bitdefender-Speedtest-Update-Lockdown',
    'WindowsDefenderRealtimeProtectionPolicyForAllManagedWorkstations',
    'correct-horse-battery-staple-marble-hamlet',
  ].filter((text) => !text.startsWith('Veeam')))('keeps word-shaped text anywhere in the record: %s', (text) => {
    const policy = {
      ...base, siteId: null, sourceScope: 'organization', name: text, description: text,
      status: 'active',
      features: [{ id: SEGMENT, type: 'settings', policyId: null, settings: { value: text, registry: { data: text } } }],
    };
    expect(transformWithRedactions('configuration-policies', policy).redactions).toEqual([]);
    expect(transformWithRedactions('scripts', {
      ...base, siteId: null, sourceScope: 'organization', name: text, description: text,
      category: text.slice(0, 100), osTypes: [text.slice(0, 50)], language: 'bash', content: 'true',
      parameters: { description: text }, timeoutSeconds: 30, runAs: 'system', version: 1, exitCodeSeverityMapping: null,
    }).redactions).toEqual([]);
    const freeText = {
      ...base, deviceId: DEVICE, definitionId: SEGMENT, target: { type: 'device', id: DEVICE },
      name: 'WiFi notes', fieldKey: 'wifi_notes', type: 'text', value: text,
    };
    expect(transformWithRedactions('custom-field-values', freeText).redactions).toEqual([]);
  });

  it('costs one value, not the record, when the shared scan misreads a name as a credential', () => {
    // The shared scan's entropy rule flags this four-class run. Before, the
    // article writer withheld the whole record for it; now only the value is.
    const text = 'Veeam-Agent-Backup-Job-Daily-Full-Retain-14-Days';
    const result = transformWithRedactions('configuration-policies', {
      ...base, siteId: null, sourceScope: 'organization', name: 'Backup policy', description: text,
      status: 'active', features: [{ id: SEGMENT, type: 'settings', policyId: null, settings: null }],
    });
    expect(result.records).toHaveLength(1);
    expect(result.markdown).toContain('# Backup policy');
    expect(result.redactions[0]).toMatchObject({ count: 1, fieldPaths: ['description'] });
  });

  it.each([
    'JBSWY3DPEHPK3PXP'.repeat(3),
    'kJhGfDsAqWeRtYuIoPlKjHgFdSaZxCvBnMqAzWsXe',
  ])('relies on Breeze and the key name for two-class random text: %s', (text) => {
    // The shared format scan needs three character classes; the old
    // Breeze-only entropy rule is gone. Under a credential-named key the
    // value is still withheld.
    const policy = (settings: Record<string, unknown>) => ({
      ...base, siteId: null, sourceScope: 'organization', name: 'Safe policy', description: null,
      status: 'active', features: [{ id: SEGMENT, type: 'settings', policyId: null, settings }],
    });
    expect(transformWithRedactions('configuration-policies', policy({ value: text })).redactions).toEqual([]);
    const named = transformWithRedactions('configuration-policies', policy({ totpSecret: text }));
    expect(named.text).not.toContain(text);
    expect(named.redactions[0]?.fieldPaths).toEqual(['features[0].settings.totpSecret']);
  });

  it('withholds the value of a custom field named as a credential and keeps the record', () => {
    const result = transformWithRedactions('custom-field-values', {
      ...base, deviceId: DEVICE, definitionId: SEGMENT, target: { type: 'device', id: DEVICE },
      name: 'WiFi passphrase', fieldKey: 'wifi_passphrase', type: 'text', value: 'short',
    });
    expect(result.records).toHaveLength(1);
    expect(result.text).not.toContain('short');
    expect(result.redactions).toEqual([{ sourceId: DEVICE, orgId: ORG, count: 1, fieldPaths: ['value'] }]);
    // A field about a credential is not one.
    expect(transformWithRedactions('custom-field-values', {
      ...base, deviceId: DEVICE, definitionId: SEGMENT, target: { type: 'device', id: DEVICE },
      name: 'Password expiry date', fieldKey: 'password_expiry_date', type: 'date', value: '2027-01-01',
    }).redactions).toEqual([]);
  });

  it.each([
    token(48, 11),
    syntheticGoogleApiKey(),
    createHash('sha256').update('').digest('base64'),
    syntheticJwt(),
  ])('withholds encoded credential material and syncs the record: %s', (text) => {
    const policy = {
      ...base, siteId: null, sourceScope: 'organization', name: 'Safe policy', description: null,
      status: 'active', features: [{ id: SEGMENT, type: 'settings', policyId: null, settings: { value: text, mode: 'audit' } }],
    };
    const result = transformWithRedactions('configuration-policies', policy);
    expect(result.records).toHaveLength(1);
    expect(result.text).not.toContain(text);
    expect(result.markdown).toContain('audit');
    expect(result.redactions).toEqual([
      { sourceId: DEVICE, orgId: ORG, count: 1, fieldPaths: ['features[0].settings.value'] },
    ]);
  });

  it('preserves a benign desired-configuration inspection bound as a bounded error', () => {
    const oversizedPolicy = {
      ...base, siteId: null, sourceScope: 'organization', name: 'Large benign policy',
      description: null, status: 'active',
      features: [{
        id: SEGMENT, type: 'settings', policyId: null,
        settings: { documentation: 'x'.repeat(12_289) },
      }],
    };

    expect(() => transformBreezeRecord('configuration-policies', oversizedPolicy))
      .toThrow(BreezeBoundedDefinitionError);
  });

  it.each([
    [`password=${PLAIN}`],
    [`set "PASSWORD=${PLAIN}"`],
    [`setx /M DB_PASSWORD ${PLAIN}`],
    [`tool --password ${PLAIN} --mode rebuild`],
    [`{"user":"admin","password":"${PLAIN}","mode":"rebuild"}`],
    [`tool "PASSWORD=${PLAIN}"`],
    [`postgresql://operator:${PLAIN}@database.example/rebuild`],
    [`$Password = '${PLAIN}!'`],
    [`ConvertTo-SecureString -AsPlainText -Force '${PLAIN}!'`],
  ])('withholds only the credential span in a script: %s', (line) => {
    const content = `Write-Host start\n${line}\nWrite-Host end`;
    const result = transformWithRedactions('scripts', {
      ...base, siteId: null, sourceScope: 'organization', name: 'Rebuild', description: null,
      category: 'build', osTypes: ['windows'], language: 'powershell', content, parameters: null,
      timeoutSeconds: 300, runAs: 'system', version: 1, exitCodeSeverityMapping: null,
    });
    expect(result.records).toHaveLength(1);
    expect(result.text).not.toContain(PLAIN);
    expect(result.markdown).toContain('Write-Host start');
    expect(result.markdown).toContain('Write-Host end');
    expect(result.markdown).toContain(WITHHELD);
    expect(result.redactions[0]).toMatchObject({ count: 1, fieldPaths: ['content'] });
  });

  it.each([
    ['tool --password=Wintergarden --mode rebuild'],
    ['tool --password Wintergarden --mode rebuild'],
    ['agent.exe /install /password:Wintergarden /quiet'],
    ['tool --password=-Wintergarden --mode rebuild'],
    [`$Password = 'Summer''Wintergarden'`],
    [String.raw`export DB_PASSWORD="Summer\"Wintergarden"`],
    [String.raw`$Password = 'Summer\'; $Token = 'Wintergarden'`],
  ])('withholds a letters-only password passed as a flag (review finding): %s', (line) => {
    const result = transformWithRedactions('scripts', {
      ...base, siteId: null, sourceScope: 'organization', name: 'Install agent', description: null,
      category: 'build', osTypes: ['windows'], language: 'powershell', content: `Write-Host start\n${line}`,
      parameters: null, timeoutSeconds: 300, runAs: 'system', version: 1, exitCodeSeverityMapping: null,
    });
    expect(result.records).toHaveLength(1);
    expect(result.text).not.toContain('Wintergarden');
    expect(result.markdown).toContain(WITHHELD);
    expect(result.redactions[0]).toMatchObject({ count: 1, fieldPaths: ['content'] });
  });

  it.each([
    'tool --password-policy enabled --mode rebuild',
    'echo secretary tokenize ordinary prose',
    'postgresql://database.example/rebuild',
    'Usage: tool --password',
    'Help: provide credential before running',
    'TODO rotate DB_PASSWORD later',
    '$cred = Get-Credential',
  ])('allows nearby benign reconstruction script text: %s', (content) => {
    const result = transformWithRedactions('scripts', {
      ...base, siteId: null, sourceScope: 'organization', name: 'Safe rebuild', description: null,
      category: 'build', osTypes: ['linux'], language: 'bash', content, parameters: null,
      timeoutSeconds: 300, runAs: 'system', version: 1, exitCodeSeverityMapping: null,
    });
    expect(result.redactions).toEqual([]);
    expect(result.markdown).toContain(content);
  });

  it('does not rewrite identifiers, even when they would look like a credential', () => {
    const revision = token(64, 7);
    const result = transformWithRedactions('scripts', {
      ...base, revision, siteId: null, sourceScope: 'organization', name: 'Credential policy documentation',
      description: 'Usage documentation mentions tool --password without carrying a value.',
      category: 'documentation', osTypes: ['linux'], language: 'bash', content: 'echo safe',
      parameters: null, timeoutSeconds: 300, runAs: 'system', version: 1,
      exitCodeSeverityMapping: null,
    });
    expect(result.redactions).toEqual([]);
    expect(result.text).toContain(revision);
  });

  it('preserves split custom-field definitions and repeated device value pages losslessly', () => {
    const definitionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const definition = transformBreezeRecord('custom-fields', {
      ...base, id: definitionId, siteId: null, sourceScope: 'partner', name: 'Rack', fieldKey: 'rack',
      type: 'text', options: null, required: false, defaultValue: null, deviceTypes: ['server'],
    })[0] as { reconstructionInput: Record<string, any> };
    expect(definition.reconstructionInput).toMatchObject({
      targetKind: 'article', externalId: `${ORG}:custom-fields:${definitionId}`,
      slug: `custom-fields-${definitionId}`,
    });
    const valueRecord = {
      ...base,
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      siteId: null,
      deviceId: DEVICE,
      definitionId,
      target: { type: 'device' as const, id: DEVICE },
      name: 'Rack',
      fieldKey: 'rack',
      type: 'text',
      value: 'DC1-R07',
    };
    const first = transformBreezeRecord('custom-field-values', valueRecord);
    const repeated = transformBreezeRecord('custom-field-values', valueRecord);
    expect(first).toEqual(repeated);
    expect(first).toHaveLength(1);
    expect(first).toEqual([expect.objectContaining({
      externalId: valueRecord.id,
      mappingSourceField: definitionId,
      bindingRef: { resourceKey: 'devices', externalId: `${ORG}:devices:${DEVICE}` },
      fields: { [definitionId]: 'DC1-R07' },
    })]);
    expect(JSON.stringify(first[0])).toContain(definitionId);
  });

  it('bounds legal titles, uses collision-safe fences, and accepts maximum simple cardinalities', () => {
    const longName = `${'N'.repeat(120)}\n${'M'.repeat(134)}`;
    const [script] = transformBreezeRecord('scripts', {
      ...base, siteId: null, sourceScope: 'organization', name: longName, description: null,
      category: null, osTypes: ['linux'], language: 'bash', content: 'echo "```"', parameters: null,
      timeoutSeconds: 30, runAs: 'system', version: 1, exitCodeSeverityMapping: null,
    }) as Array<{ reconstructionInput: Record<string, any> }>;
    expect(script!.reconstructionInput.title).toHaveLength(200);
    expect(script!.reconstructionInput.title).not.toMatch(/[\r\n]/u);
    expect(script!.reconstructionInput.markdown).toContain('````bash\necho "```"\n````');

    const actions = Array.from({ length: 500 }, (_, index) => ({ type: 'step', index }));
    const [automation] = transformBreezeRecord('automations', {
      ...base, siteId: null, sourceScope: 'organization', name: 'Maximum automation', description: null,
      enabled: true, trigger: { type: 'manual' }, conditions: null, actions,
      onFailure: 'stop', notificationTargets: null, dependencies: [],
    }) as Array<{ reconstructionInput: Record<string, any> }>;
    expect(automation!.reconstructionInput.markdown).toContain('500.');
    expect(reconstructionInputByteLength(automation!.reconstructionInput)).toBeLessThanOrEqual(
      MAX_RECONSTRUCTION_INPUT_BYTES,
    );

    const features = Array.from({ length: 500 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      type: 'feature', policyId: null, settings: { enabled: true, index },
    }));
    const [policy] = transformBreezeRecord('configuration-policies', {
      ...base, siteId: null, sourceScope: 'organization', name: 'Maximum policy', description: null,
      status: 'active', features,
    }) as Array<{ reconstructionInput: Record<string, any> }>;
    expect(policy!.reconstructionInput.markdown).toContain(features[499]!.id);
    expect(reconstructionInputByteLength(policy!.reconstructionInput)).toBeLessThanOrEqual(
      MAX_RECONSTRUCTION_INPUT_BYTES,
    );

  });

  it('blocks an oversized legal Markdown projection at a semantic boundary', () => {
    const actions = Array.from({ length: 500 }, (_, index) => ({
      type: 'step', index, instructions: 'x'.repeat(1_100),
    }));
    expect(() => transformBreezeRecord('automations', {
      ...base, siteId: null, sourceScope: 'organization', name: 'Too large', description: null,
      enabled: true, trigger: { type: 'manual' }, conditions: null, actions,
      onFailure: 'stop', notificationTargets: null, dependencies: [],
    })).toThrow(/native field bound/i);
  });

  it('enforces the shared serialized byte ceiling for non-ASCII projections', () => {
    const automation = (instructions: string) => ({
      ...base, siteId: null, sourceScope: 'organization', name: 'Unicode boundary',
      description: null, enabled: true, trigger: { type: 'manual' }, conditions: null,
      actions: Array.from({ length: 500 }, (_, index) => ({ type: 'step', index, instructions })),
      onFailure: 'stop', notificationTargets: null, dependencies: [],
    });
    const [nearBoundary] = transformBreezeRecord(
      'automations',
      automation('界'.repeat(140)),
    ) as Array<{ reconstructionInput: Record<string, any> }>;

    expect(reconstructionInputByteLength(nearBoundary!.reconstructionInput)).toBeGreaterThan(
      MAX_RECONSTRUCTION_INPUT_BYTES - 50_000,
    );
    expect(articleReconstructionInputSchema.safeParse(nearBoundary!.reconstructionInput).success)
      .toBe(true);
    expect(() => transformBreezeRecord(
      'automations',
      automation('界'.repeat(180)),
    )).toThrow(/native field bound/i);
  });

  it('neutralizes source-supplied managed marker tokens and emits exactly one region', () => {
    const marker = '<!-- weavestream:breeze:managed:start -->';
    const [record] = transformBreezeRecord('scripts', {
      ...base, siteId: null, sourceScope: 'organization', name: `Marker ${marker}`, description: marker,
      category: null, osTypes: ['linux'], language: 'bash', content: `echo '${marker}'`, parameters: null,
      timeoutSeconds: 30, runAs: 'system', version: 1, exitCodeSeverityMapping: null,
    }) as Array<{ reconstructionInput: Record<string, any> }>;
    const markdown = record!.reconstructionInput.markdown as string;
    expect(markdown.split('<!-- weavestream:breeze:managed:start -->')).toHaveLength(2);
    expect(markdown.split('<!-- weavestream:breeze:managed:end -->')).toHaveLength(2);
    expect(markdown).toContain('&lt;!-- weavestream:breeze:managed:start --&gt;');
  });

  it('keeps one scalar custom value within the native bound or blocks the row', () => {
    const custom = (value: unknown) => ({
      ...base,
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      siteId: null,
      deviceId: DEVICE,
      definitionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      target: { type: 'device', id: DEVICE },
      name: 'Structured',
      fieldKey: 'structured',
      type: 'text',
      value,
    });
    const [valid] = transformBreezeRecord('custom-field-values', custom(
      Array.from({ length: 4 }, (_, index) => `${index}:${'x'.repeat(12_000)}`),
    ));
    const definitionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const projected = (valid as unknown as { fields: Record<string, string[]> }).fields[definitionId];
    expect(projected).toHaveLength(4);
    expect(() => transformBreezeRecord('custom-field-values', custom(
      Array.from({ length: 5 }, (_, index) => `${index}:${'x'.repeat(12_000)}`),
    ))).toThrow(/native field bound/i);
  });

  it('uses stable namespaced identities, strips NUL recursively, and excludes monitoring fields', () => {
    const [record] = transformBreezeRecord('devices', device);
    expect(record).toMatchObject({
      externalId: DEVICE,
      displayName: 'Workstation 01',
      updatedAt: UPDATED,
      sourceRevision: REVISION,
      sourceFingerprint: REVISION,
      fields: expect.objectContaining({ hostname: 'ws-01', breezeId: DEVICE }),
    });
    const serialized = JSON.stringify(record).toLowerCase();
    expect(serialized).not.toContain('\\u0000');
    expect(serialized).not.toMatch(
      /status|lastseen|heartbeat|uptime|alert|vulnerab|patch|metric|session|command/,
    );
  });

  it('parses the actual device inventory DTO into grouped searchable fields and durable child assets', () => {
    const [inventory] = transformBreezeRecord('device-inventory', deviceInventory);
    expect(inventory).toMatchObject({
      externalId: DEVICE,
      fields: expect.objectContaining({
        breezeId: DEVICE,
        processor: expect.stringContaining('Intel Xeon W-2245'),
        processorCores: 8,
        processorThreads: 16,
        memoryMb: 32768,
        graphics: 'NVIDIA T1000',
        motherboard: expect.stringContaining('Dell'),
        biosVersion: '1.2.3',
        disks: 'C: · NTFS · 512 GB · Disk 0',
        interfaces: 'Ethernet · MAC 00:11:22:33:44:55 · primary',
        networkAddresses: expect.stringContaining(
          '10.20.0.99 · ipv4 · dhcp · on Ethernet · mask 255.255.255.0 · active · first seen 2026-02-01',
        ),
        gateways: expect.stringContaining('10.20.0.1'),
        dnsServers: expect.stringContaining('1.1.1.1'),
        warrantyStatus: 'active',
        warrantyEndsOn: '2028-01-01',
        virtualMachines: 'Build VM · gen 2 · 8192 MB · 4 vCPU · RCT · vm-guid-1',
        inventoryCompleteness: expect.stringContaining('addresses: 2/2 complete'),
      }),
    });
    expect(JSON.stringify(inventory)).not.toContain('"hardware"');

    const [vm] = transformBreezeRecord('virtual-machines', deviceInventory);
    expect(vm).toMatchObject({
      externalId: VM,
      displayName: 'Build VM',
      fields: expect.objectContaining({
        breezeId: VM,
        hostDeviceId: DEVICE,
        generation: 2,
        memoryMb: 8192,
        processorCount: 4,
      }),
    });

    const softwareRecord = {
      ...base,
      subjectType: 'device' as const,
      deviceId: DEVICE,
      software: [
        {
          id: SOFTWARE,
          name: 'Weave Agent',
          version: '2.4.0',
          vendor: 'Weavestream',
          installedOn: '2026-01-02',
          managed: true,
        },
      ],
      collection: completeCollection,
    };
    const [software] = transformBreezeRecord('device-software', softwareRecord);
    expect(software).toMatchObject({
      externalId: DEVICE,
      fields: expect.objectContaining({
        installedSoftware:
          'Weave Agent 2.4.0 · Weavestream · installed 2026-01-02 · managed',
        softwareCompleteness: 'software: 1/1 complete',
      }),
    });

    const renamed = transformBreezeRecord('device-software', {
      ...softwareRecord,
      software: [{ ...softwareRecord.software[0], name: 'Renamed Agent' }],
    });
    expect(renamed[0]).toMatchObject({ externalId: DEVICE });
    expect(JSON.stringify(renamed[0])).toContain('Renamed Agent 2.4.0');
  });

  it('maps site inventory, canonical subnets, and only eligible current static reservations', () => {
    const [site] = transformBreezeRecord('site-inventory', siteInventory);
    expect(site).toMatchObject({
      externalId: SITE,
      fields: expect.objectContaining({
        breezeId: SITE,
        networkEquipment:
          'Core Switch · switch · 10.20.0.2 · MAC 00:aa:bb:cc:dd:ee · Cisco C9300',
        networkSegments: expect.stringContaining('10.20.0.0/24'),
        inventoryCompleteness: expect.stringContaining('networkEquipment: 1/1 complete'),
      }),
    });

    const [equipment] = transformBreezeRecord('network-equipment', siteInventory);
    expect(equipment).toMatchObject({
      externalId: EQUIPMENT,
      displayName: 'Core Switch',
      fields: expect.objectContaining({
        breezeId: EQUIPMENT,
        siteId: SITE,
        equipmentType: 'switch',
        address: '10.20.0.2',
      }),
    });

    const [siteSubnet] = transformBreezeRecord('subnets', siteInventory) as Array<{
      reconstructionInput: Record<string, unknown>;
    }>;
    const [derivedSubnet] = transformBreezeRecord('subnets', deviceInventory) as Array<{
      reconstructionInput: Record<string, unknown>;
    }>;
    expect(siteSubnet!.reconstructionInput).toMatchObject({
      targetKind: 'subnet',
      cidr: '10.20.0.0/24',
      externalId: `${ORG}:subnets:${SEGMENT}`,
      source: { sourceId: SEGMENT },
    });
    expect(derivedSubnet!.reconstructionInput).toMatchObject({
      targetKind: 'subnet',
      cidr: '10.20.0.0/24',
      externalId: `${ORG}:subnets:${STATIC_ADDRESS}`,
      source: { sourceId: STATIC_ADDRESS },
    });

    const reservations = transformBreezeRecord('ip-reservations', deviceInventory) as Array<{
      reconstructionInput: Record<string, unknown>;
    }>;
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.reconstructionInput).toMatchObject({
      targetKind: 'ip_reservation',
      ipAddress: '10.20.0.50',
      externalId: `${ORG}:ip-reservations:${STATIC_ADDRESS}`,
      subnetRef: {
        resourceKey: 'subnets',
        externalId: `${ORG}:subnets:${STATIC_ADDRESS}`,
      },
    });
    expect(JSON.stringify(reservations)).not.toContain('10.20.0.99');
  });

  it('creates a subnet for current static IPv4 even when reservation eligibility is false', () => {
    const input = {
      ...deviceInventory,
      addresses: [
        {
          ...deviceInventory.addresses[0],
          reservationEligible: false,
        },
      ],
      collections: {
        ...deviceInventory.collections,
        addresses: completeCollection,
      },
    };

    expect(transformBreezeRecord('subnets', input)).toHaveLength(1);
    expect(transformBreezeRecord('ip-reservations', input)).toHaveLength(0);
  });

  it('skips one record (a record gap) on same-record same-CIDR gateway conflicts in any address order', () => {
    const conflicting = {
      ...deviceInventory.addresses[0],
      id: '14141414-1414-4414-8414-141414141414',
      address: '10.20.0.51',
      gateway: '10.20.0.3',
    };
    const makeInput = (addresses: unknown[]) => ({
      ...deviceInventory,
      addresses,
      collections: {
        ...deviceInventory.collections,
        addresses: { total: 2, included: 2, complete: true, reason: null },
      },
    });

    expect(gapReason(() =>
      transformBreezeRecord('subnets', makeInput([deviceInventory.addresses[0]!, conflicting])),
    )).toBe('conflicting_subnet_gateways');
    expect(gapReason(() =>
      transformBreezeRecord('subnets', makeInput([conflicting, deviceInventory.addresses[0]!])),
    )).toBe('conflicting_subnet_gateways');
  });

  it.each(['not-an-ip', '10.30.0.1'])(
    'skips one record (a record gap) on a malformed or out-of-subnet static gateway: %s',
    (gateway) => {
      expect(gapReason(() =>
        transformBreezeRecord('subnets', {
          ...deviceInventory,
          addresses: [{ ...deviceInventory.addresses[0], gateway }],
          collections: {
            ...deviceInventory.collections,
            addresses: completeCollection,
          },
        }),
      )).toBe('invalid_static_gateway');
    },
  );

  it('keeps UUID-backed IPAM source identity stable when native address facts change', () => {
    const [initialSubnet] = transformBreezeRecord('subnets', deviceInventory) as Array<{
      reconstructionInput: Record<string, any>;
    }>;
    const [initialReservation] = transformBreezeRecord(
      'ip-reservations',
      deviceInventory,
    ) as Array<{ reconstructionInput: Record<string, any> }>;
    const changed = {
      ...deviceInventory,
      addresses: deviceInventory.addresses.map((address, index) =>
        index === 0
          ? {
              ...address,
              address: '10.30.0.50',
              gateway: '10.30.0.1',
            }
          : address,
      ),
    };
    const [changedSubnet] = transformBreezeRecord('subnets', changed) as Array<{
      reconstructionInput: Record<string, any>;
    }>;
    const [changedReservation] = transformBreezeRecord(
      'ip-reservations',
      changed,
    ) as Array<{ reconstructionInput: Record<string, any> }>;

    expect(initialSubnet!.reconstructionInput.externalId).toBe(
      `${ORG}:subnets:${STATIC_ADDRESS}`,
    );
    expect(changedSubnet!.reconstructionInput.externalId).toBe(
      initialSubnet!.reconstructionInput.externalId,
    );
    expect(changedSubnet!.reconstructionInput).toMatchObject({
      cidr: '10.30.0.0/24',
      source: { sourceId: STATIC_ADDRESS },
    });
    expect(initialReservation!.reconstructionInput.externalId).toBe(
      `${ORG}:ip-reservations:${STATIC_ADDRESS}`,
    );
    expect(changedReservation!.reconstructionInput.externalId).toBe(
      initialReservation!.reconstructionInput.externalId,
    );
    expect(changedReservation!.reconstructionInput).toMatchObject({
      ipAddress: '10.30.0.50',
      source: { sourceId: STATIC_ADDRESS },
      subnetRef: {
        externalId: `${ORG}:subnets:${STATIC_ADDRESS}`,
      },
    });
  });

  it('preserves collection truncation as an explicit searchable completeness marker', () => {
    const [inventory] = transformBreezeRecord('device-inventory', {
      ...deviceInventory,
      disks: [],
      collections: {
        ...deviceInventory.collections,
        disks: {
          total: 501,
          included: 0,
          complete: false,
          reason: 'collection_limit_exceeded',
        },
      },
    });
    expect(inventory).toMatchObject({
      fields: {
        inventoryCompleteness: expect.stringContaining(
          'disks: 0/501 incomplete (collection limit exceeded)',
        ),
      },
    });
  });

  it('keeps unsupported and historical addresses informational and rejects raw sensitive fields', () => {
    const excludedAddresses = [
      {
        ...deviceInventory.addresses[0],
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        assignment: 'vpn' as const,
      },
      {
        ...deviceInventory.addresses[0],
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        assignment: 'link-local' as const,
      },
      {
        ...deviceInventory.addresses[0],
        id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        active: false,
        deactivatedAt: UPDATED,
      },
      {
        ...deviceInventory.addresses[0],
        id: '12121212-1212-4212-8212-121212121212',
        family: 'ipv6' as const,
        address: '2001:db8::20',
        subnetMask: '64',
        gateway: '2001:db8::1',
      },
      {
        ...deviceInventory.addresses[0],
        id: '13131313-1313-4313-8313-131313131313',
        address: '999.20.0.50',
      },
    ];
    const input = {
      ...deviceInventory,
      addresses: [...deviceInventory.addresses, ...excludedAddresses],
      collections: {
        ...deviceInventory.collections,
        addresses: { total: 7, included: 7, complete: true, reason: null },
      },
    };
    const [inventory] = transformBreezeRecord('device-inventory', input);
    const informational = JSON.stringify(inventory);
    expect(informational).toContain('2001:db8::20');
    expect(informational.toLowerCase()).toContain('vpn');
    expect(informational.toLowerCase()).toContain('link-local');
    expect(transformBreezeRecord('ip-reservations', input)).toHaveLength(1);

    expect(JSON.stringify(transformBreezeRecord('device-inventory', {
      ...deviceInventory,
      openPorts: [22, 3389],
    }))).not.toContain('openPorts');
    // An equipment type added in a later Breeze release syncs as plain text.
    expect(transformBreezeRecord('network-equipment', {
      ...siteInventory,
      networkEquipment: [{ ...siteInventory.networkEquipment[0], type: 'client' }],
    })).toEqual([expect.objectContaining({ fields: expect.objectContaining({ equipmentType: 'client' }) })]);
  });

  it('accepts Breeze v0.111 website/service equipment with a URL and no address', () => {
    const website = {
      id: '88888888-8888-4888-8888-888888888888',
      type: 'website' as const,
      name: 'Customer Portal',
      address: null,
      macAddress: null,
      manufacturer: null,
      model: null,
      url: 'https://portal.example.test',
      source: 'manual',
    };
    const inventory = {
      ...siteInventory,
      networkEquipment: [siteInventory.networkEquipment[0], website],
      collections: {
        ...siteInventory.collections,
        networkEquipment: { total: 2, included: 2, complete: true, reason: null },
      },
    };
    const [site] = transformBreezeRecord('site-inventory', inventory);
    expect(site).toMatchObject({
      fields: expect.objectContaining({
        networkEquipment: expect.stringContaining(
          'Customer Portal · website · https://portal.example.test',
        ),
      }),
    });
    const equipment = transformBreezeRecord('network-equipment', inventory);
    expect(equipment).toHaveLength(2);
    expect(equipment[1]).toMatchObject({
      externalId: website.id,
      displayName: 'Customer Portal',
      fields: expect.objectContaining({
        equipmentType: 'website',
        address: null,
        url: 'https://portal.example.test',
        source: 'manual',
      }),
    });
    // Exports from older Breeze releases omit `url` and `source` entirely.
    const [legacyEquipment] = transformBreezeRecord('network-equipment', siteInventory);
    expect(legacyEquipment).toMatchObject({
      fields: expect.objectContaining({ url: null, source: null }),
    });
  });

  it('maps only exported stable relationship edges to exact durable resource bindings', () => {
    const relationships = {
      ...base,
      subjectType: 'device' as const,
      deviceId: DEVICE,
      edges: [
        {
          key: 'site-device-edge',
          type: 'site_device' as const,
          from: { type: 'site' as const, id: SITE },
          to: { type: 'device' as const, id: DEVICE },
          metadata: {},
        },
        {
          key: 'device-interface-edge',
          type: 'device_interface' as const,
          from: { type: 'device' as const, id: DEVICE },
          to: { type: 'interface' as const, id: INTERFACE },
          metadata: { interfaceName: 'Ethernet' },
        },
        {
          key: 'host-vm-edge',
          type: 'hyperv_host_vm' as const,
          from: { type: 'device' as const, id: DEVICE },
          to: { type: 'virtual_machine' as const, id: VM },
          metadata: {},
        },
        {
          key: 'topology-edge',
          type: 'network_topology' as const,
          from: { type: 'site' as const, id: SITE },
          to: { type: 'discovered_asset' as const, id: EQUIPMENT },
          metadata: { connectionType: 'ethernet', vlan: 20 },
        },
      ],
      collection: { total: 4, included: 4, complete: true, reason: null },
    };
    const records = transformBreezeRecord('device-relationships', relationships) as Array<{
      reconstructionInput: Record<string, unknown>;
    }>;
    expect(records).toHaveLength(4);
    expect(records.map(({ reconstructionInput }) => reconstructionInput)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalId: `${ORG}:device-relationships:site-device-edge`,
          relationType: 'site_device',
          sourceRef: { resourceKey: 'sites', externalId: `${ORG}:sites:${SITE}` },
          targetRef: { resourceKey: 'devices', externalId: `${ORG}:devices:${DEVICE}` },
        }),
        expect.objectContaining({
          externalId: `${ORG}:device-relationships:host-vm-edge`,
          targetRef: {
            resourceKey: 'virtual-machines',
            externalId: `${ORG}:virtual-machines:${VM}`,
          },
        }),
        expect.objectContaining({
          externalId: `${ORG}:device-relationships:topology-edge`,
          targetRef: {
            resourceKey: 'network-equipment',
            externalId: `${ORG}:network-equipment:${EQUIPMENT}`,
          },
        }),
        expect.objectContaining({
          externalId: `${ORG}:device-relationships:device-interface-edge`,
          targetRef: {
            resourceKey: 'network-interfaces',
            externalId: `${ORG}:network-interfaces:${INTERFACE}`,
          },
        }),
      ]),
    );
    expect(JSON.stringify(records)).not.toMatch(/configuration.assignment|backup.procedure/i);

    // A new edge type between known endpoints syncs as plain text; an edge to
    // an endpoint kind Weavestream does not model is skipped, not fatal.
    expect(transformBreezeRecord('device-relationships', {
      ...relationships,
      edges: [
        {
          key: 'invented-edge',
          type: 'configuration_assignment',
          from: { type: 'device', id: DEVICE },
          to: { type: 'device', id: DEVICE },
          metadata: {},
        },
        {
          key: 'unknown-endpoint-edge',
          type: 'site_device',
          from: { type: 'cloud_tenant', id: DEVICE },
          to: { type: 'device', id: DEVICE },
          metadata: {},
        },
      ],
      collection: completeCollection,
    })).toEqual([
      expect.objectContaining({
        reconstructionInput: expect.objectContaining({ relationType: 'configuration_assignment' }),
      }),
    ]);
  });

  it.each([
    [
      'sites',
      {
        ...base,
        id: SITE,
        siteId: SITE,
        name: 'HQ',
        timezone: 'America/Denver',
        address: null,
        contact: null,
      },
    ],
    ['devices', device],
    ['site-inventory', siteInventory],
    ['device-inventory', deviceInventory],
    [
      'device-software',
      {
        ...base,
        subjectType: 'device',
        deviceId: DEVICE,
        software: [],
        collection: { total: 0, included: 0, complete: true, reason: null },
      },
    ],
    ['network-equipment', siteInventory],
    ['virtual-machines', deviceInventory],
    ['subnets', deviceInventory],
    ['ip-reservations', deviceInventory],
    [
      'configuration-policies',
      { ...base, siteId: null, name: 'Policy', description: null, sourceScope: 'organization', status: 'active', features: [] },
    ],
    ['configuration-assignments', { ...base, siteId: null, policyId: SEGMENT, policyName: 'Policy', sourceScope: 'organization', level: 'site', targetId: SITE, priority: 0, roleFilter: null, osFilter: null }],
    ['configuration-assignment-relations', { ...base, siteId: null, policyId: SEGMENT, policyName: 'Policy', sourceScope: 'organization', level: 'site', targetId: SITE, priority: 0, roleFilter: null, osFilter: null }],
    ['scripts', { ...base, siteId: null, sourceScope: 'organization', name: 'Install', description: null, category: null, osTypes: ['linux'], language: 'bash', content: 'true', parameters: null, timeoutSeconds: 30, runAs: 'system', version: 1, exitCodeSeverityMapping: null }],
    [
      'automations',
      { ...base, siteId: null, sourceScope: 'organization', name: 'Onboard', description: null, enabled: true, trigger: { type: 'manual' }, conditions: null, actions: [], onFailure: 'stop', notificationTargets: null, dependencies: [] },
    ],
    ['automation-relations', { ...base, siteId: null, sourceScope: 'organization', name: 'Onboard', description: null, enabled: true, trigger: { type: 'manual' }, conditions: null, actions: [], onFailure: 'stop', notificationTargets: null, dependencies: [] }],
    [
      'backup-configurations',
      { ...base, siteId: null, kind: 'profile', sourceScope: 'organization', name: 'Backup', description: null, active: true, selections: {}, destinationId: null, schedule: null, retention: null, exclusions: [] },
    ],
    ['backup-configuration-relations', { ...base, siteId: null, kind: 'profile', sourceScope: 'organization', name: 'Backup', description: null, active: true, selections: {}, destinationId: null, schedule: null, retention: null, exclusions: [] }],
    [
      'custom-fields',
      { ...base, siteId: null, sourceScope: 'organization', name: 'Owner', fieldKey: 'owner', type: 'text', options: null, required: false, defaultValue: null, deviceTypes: null },
    ],
    ['custom-field-values', {
      ...base,
      siteId: null,
      deviceId: DEVICE,
      definitionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      target: { type: 'device', id: DEVICE },
      name: 'Owner',
      fieldKey: 'owner',
      type: 'text',
      value: 'IT',
    }],
    [
      'device-relationships',
      {
        ...base,
        subjectType: 'device',
        deviceId: DEVICE,
        edges: [],
        collection: { total: 0, included: 0, complete: true, reason: null },
      },
    ],
  ] as const)('has a fail-closed transform for %s', (resource, input) => {
    expect(() => transformBreezeRecord(resource, input)).not.toThrow();
  });

  it('fails closed on unknown resources', () => {
    expect(() => transformBreezeRecord('unknown' as 'sites', device)).toThrow(/resource/i);
  });

  it('accepts the actual schema maximum software rows within the guarded response bound', () => {
    const software = Array.from({ length: 1_000 }, (_, index) => ({
      id: `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`,
      // Realistic long names keep 1000 compact lines above the 50k projection
      // limit so the truncation path stays exercised at the schema maximum.
      name: `Package ${index} Enterprise Security Agent Extended Edition Build`,
      version: null,
      vendor: null,
      installedOn: null,
      managed: false,
    }));
    const [record] = transformBreezeRecord('device-software', {
      ...base,
      subjectType: 'device',
      deviceId: DEVICE,
      software,
      collection: { total: 1_000, included: 1_000, complete: true, reason: null },
    });
    const installedSoftware = (record as unknown as { fields: { installedSoftware: string } }).fields
      .installedSoftware;
    const softwareCompleteness = (record as unknown as { fields: { softwareCompleteness: string } })
      .fields.softwareCompleteness;
    expect(() => new TextareaStrategy().valueSchema().parse(installedSoftware)).not.toThrow();
    expect(() => new TextStrategy().valueSchema().parse(softwareCompleteness)).not.toThrow();
    expect(installedSoftware).toMatch(/\[projection truncated: \d+\/1000 rows shown\]/u);
    expect(softwareCompleteness).toMatch(/software: 1000\/1000 complete; projection \d+\/1000/u);
  });

  it('bounds maximum adjacent inventory rows at complete asset-field boundaries', () => {
    const addresses = Array.from({ length: 500 }, (_, index) => ({
      ...deviceInventory.addresses[1],
      id: `${(index + 1).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
      address: `10.${Math.floor(index / 250)}.${Math.floor((index % 250) / 50)}.${(index % 50) + 1}`,
      // Long name keeps 500 compact lines above the 50k projection limit so
      // the truncation path stays exercised.
      interfaceName: 'Management Uplink Interface 0123456789',
    }));
    const [record] = transformBreezeRecord('device-inventory', {
      ...deviceInventory,
      addresses,
      collections: {
        ...deviceInventory.collections,
        addresses: { total: 500, included: 500, complete: true, reason: null },
      },
    });
    const fields = (record as unknown as {
      fields: { networkAddresses: string; inventoryCompleteness: string };
    }).fields;

    expect(() => new TextareaStrategy().valueSchema().parse(fields.networkAddresses)).not.toThrow();
    expect(() => new TextareaStrategy().valueSchema().parse(fields.inventoryCompleteness)).not.toThrow();
    expect(fields.networkAddresses).toMatch(/\[projection truncated: \d+\/500 rows shown\]/u);
    expect(fields.inventoryCompleteness).toMatch(/addresses: 500\/500 complete; projection \d+\/500/u);
  });

  it('bounds maximum adjacent gateway and DNS values at complete TEXT boundaries', () => {
    const addresses = Array.from({ length: 500 }, (_, addressIndex) => ({
      ...deviceInventory.addresses[1],
      id: `${(addressIndex + 1).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
      gateway: `gateway-${String(addressIndex).padStart(4, '0')}-${'g'.repeat(32)}`,
      dnsServers: Array.from(
        { length: 20 },
        (_, dnsIndex) =>
          `dns-${String(addressIndex).padStart(4, '0')}-${String(dnsIndex).padStart(2, '0')}-${'d'.repeat(32)}`,
      ),
    }));
    const [record] = transformBreezeRecord('device-inventory', {
      ...deviceInventory,
      addresses,
      collections: {
        ...deviceInventory.collections,
        addresses: { total: 500, included: 500, complete: true, reason: null },
      },
    });
    const fields = (record as unknown as {
      fields: {
        gateways: string;
        dnsServers: string;
        inventoryCompleteness: string;
      };
    }).fields;

    expect(() => new TextStrategy().valueSchema().parse(fields.gateways)).not.toThrow();
    expect(() => new TextStrategy().valueSchema().parse(fields.dnsServers)).not.toThrow();
    expect(fields.gateways).toMatch(/\[projection truncated: \d+\/500 values shown\]$/u);
    expect(fields.dnsServers).toMatch(/\[projection truncated: \d+\/10000 values shown\]$/u);
    expect(fields.inventoryCompleteness).toMatch(/gateways: projection \d+\/500 values shown/u);
    expect(fields.inventoryCompleteness).toMatch(/DNS servers: projection \d+\/10000 values shown/u);
  });
});

describe('BreezeDriver transport delegation', () => {
  const scriptPage = async (records: unknown[]) => {
    const client = {
      testConnection: jest.fn(), listOrganizations: jest.fn(),
      fetchPage: jest.fn().mockResolvedValue({
        schemaVersion: '1', snapshotAt: '2026-07-14T12:00:00.000Z', data: records,
        nextCursor: null, hasMore: false,
      }),
    };
    return new BreezeDriver(client).fetchRecords({ ...ctx('scripts'), mode: 'full', updatedSince: null }, null);
  };
  const script = (content: string, id = DEVICE, name = 'Rebuild') => ({
    ...base, id, siteId: null, sourceScope: 'organization', name, description: null,
    category: null, osTypes: ['windows'], language: 'powershell', content, parameters: null,
    timeoutSeconds: 30, runAs: 'system', version: 1, exitCodeSeverityMapping: null,
  });

  it.each([
    'Usage: tool --password',
    '{"password":""}',
    'set PASSWORD=',
    'TODO rotate DB_PASSWORD later',
    'Help: provide credential before running',
  ])('syncs a script that only mentions a credential, with no warning (issue 112): %s', async (content) => {
    const page = await scriptPage([script(content), script('tool --password-policy enabled', SEGMENT)]);
    expect(page.records).toHaveLength(2);
    expect(page.blockedInputs).toEqual([]);
    expect(page.redactions).toEqual([]);
  });

  it.each([
    `ConvertTo-SecureString ${PLAIN} -AsPlainText -Force`,
    `ConvertTo-SecureString -String ${PLAIN} -AsPlainText -Force`,
    `$Password = '${PLAIN}!'`,
  ])('withholds the literal in a script, syncs the record, and leaks nothing: %s', async (content) => {
    const page = await scriptPage([script(content), script('true', SEGMENT, 'Safe sibling')]);
    expect(page.records).toHaveLength(2);
    expect(page.blockedInputs).toEqual([]);
    expect(page.redactions).toEqual([{ externalId: `${ORG}:scripts:${DEVICE}`, count: 1, fieldPaths: ['content'] }]);
    expect(JSON.stringify(page)).not.toContain(PLAIN);
    expect(JSON.stringify(page)).toContain(WITHHELD);
  });

  it('syncs a policy with the credential value withheld and names the path (issue 112)', async () => {
    const secretValue = token(48, 11);
    const policy = {
      ...base, siteId: null, sourceScope: 'organization', name: 'Standard buildout', description: null,
      status: 'active', features: [
        { id: SEGMENT, type: 'patch', policyId: null, settings: { rebootPolicy: 'if_required' } },
        { id: SEGMENT, type: 'backup', policyId: null, settings: { destination: { secretAccessKey: secretValue, bucket: 'nightly' } } },
      ],
    };
    const page = await withheldPolicyPage(policy);
    expect(page.records).toHaveLength(1);
    expect(page.blockedInputs).toEqual([]);
    expect(page.redactions).toEqual([{
      externalId: `${ORG}:configuration-policies:${DEVICE}`,
      count: 1,
      fieldPaths: ['features[1].settings.destination.secretAccessKey'],
    }]);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain(secretValue);
    expect(serialized).toContain('if_required');
    expect(serialized).toContain('nightly');
  });

  const withheldPolicyPage = async (policy: Record<string, unknown>) => {
    const client = {
      testConnection: jest.fn(), listOrganizations: jest.fn(),
      fetchPage: jest.fn().mockResolvedValue({
        schemaVersion: '1', snapshotAt: '2026-07-14T12:00:00.000Z', data: [policy],
        nextCursor: null, hasMore: false,
      }),
    };
    return new BreezeDriver(client).fetchRecords(
      { ...ctx('configuration-policies'), mode: 'full', updatedSince: null }, null,
    );
  };
  const policyWithSettings = (settings: Record<string, unknown>, name = 'Standard buildout') => ({
    ...base, siteId: null, sourceScope: 'organization', name, description: null,
    status: 'active', features: [{ id: SEGMENT, type: 'settings', policyId: null, settings }],
  });

  it('withholds a key that carries an assignment and does not show it in the path', async () => {
    const page = await withheldPolicyPage(policyWithSettings({ options: { [`password=${PLAIN}`]: 'on' } }));
    expect(page.records).toHaveLength(1);
    expect(page.redactions).toEqual([expect.objectContaining({
      fieldPaths: ['features[0].settings.options.[redacted]'],
    })]);
    expect(JSON.stringify(page)).not.toContain(PLAIN);
  });

  it('does not treat a credential-named object with keys as empty', async () => {
    const tokenKey = token(48, 11);
    const page = await withheldPolicyPage(policyWithSettings({ providerConfig: { [tokenKey]: true } }));
    expect(page.records).toHaveLength(1);
    expect(page.redactions).toEqual([expect.objectContaining({
      fieldPaths: ['features[0].settings.providerConfig'],
    })]);
    expect(JSON.stringify(page)).not.toContain(tokenKey);
  });

  it('bounds a long redacted path and keeps its end, which names the field', async () => {
    let settings: Record<string, unknown> = { secretAccessKey: 'abc' };
    for (let level = 0; level < 12; level += 1) settings = { [`nestedSection${level}Settings`]: settings };
    const page = await withheldPolicyPage(policyWithSettings(settings));
    const path = page.redactions?.[0]?.fieldPaths[0] ?? '';
    expect(path.length).toBeLessThanOrEqual(200);
    expect(path.endsWith('.secretAccessKey')).toBe(true);
    expect(path.startsWith('…')).toBe(true);
  });

  it('withholds a record name that itself looks like a credential and keeps the record', () => {
    const secretName = token(48, 11);
    const result = transformWithRedactions('configuration-policies', {
      ...base, siteId: null, sourceScope: 'organization', name: secretName, description: null,
      status: 'active', features: [],
    });
    expect(result.records).toHaveLength(1);
    expect(result.text).not.toContain(secretName);
    expect(result.redactions[0]).toMatchObject({ fieldPaths: ['name'] });
  });

  it('keeps maximum automation dependency fan-out lossless within 10,000-record continuation pages', async () => {
    const uuid = (value: number) =>
      `${value.toString(16).padStart(8, '0')}-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
    const parents = Array.from({ length: 21 }, (_, parentIndex) => ({
      ...base,
      id: uuid(parentIndex + 1),
      siteId: null,
      sourceScope: 'organization',
      name: `Automation ${parentIndex + 1}`,
      description: null,
      enabled: true,
      trigger: { type: 'manual' },
      conditions: null,
      actions: [],
      onFailure: 'stop',
      notificationTargets: null,
      dependencies: Array.from({ length: 500 }, (_, dependencyIndex) => ({
        resource: 'scripts' as const,
        id: uuid(10_000 + dependencyIndex + 1),
      })),
    }));
    const client = {
      testConnection: jest.fn(), listOrganizations: jest.fn(),
      fetchPage: jest.fn()
        .mockResolvedValueOnce({
          schemaVersion: '1', snapshotAt: '2026-07-14T12:00:00.000Z', data: parents.slice(0, 20),
          nextCursor: 'automation-page-2', hasMore: true,
        })
        .mockResolvedValueOnce({
          schemaVersion: '1', snapshotAt: '2026-07-14T12:00:00.000Z', data: parents.slice(20),
          nextCursor: null, hasMore: false,
        }),
    };
    const driver = new BreezeDriver(client);
    const fullContext = { ...ctx('automation-relations'), mode: 'full' as const, updatedSince: null };
    const first = await driver.fetchRecords(fullContext, null);
    const second = await driver.fetchRecords(
      { ...fullContext, snapshotAt: first.snapshotAt ?? null }, first.cursor ?? null,
    );
    const identities = [...first.records, ...second.records].map(
      (record) => record.reconstructionInput?.externalId,
    );
    expect(first.records).toHaveLength(10_000);
    expect(second.records).toHaveLength(500);
    expect(new Set(identities).size).toBe(10_500);
    expect(client.fetchPage).toHaveBeenNthCalledWith(
      2, expect.anything(), expect.objectContaining({ cursor: 'automation-page-2' }),
    );
  });

  it('quarantines one oversized legal article and continues its safe page sibling', async () => {
    const oversizedName = 'Oversized procedure sentinel';
    const oversized = {
      ...base, siteId: null, sourceScope: 'organization', name: oversizedName, description: null,
      enabled: true, trigger: { type: 'manual' }, conditions: null,
      actions: Array.from({ length: 500 }, (_, index) => ({ type: 'step', index, instructions: 'x'.repeat(1_100) })),
      onFailure: 'stop', notificationTargets: null, dependencies: [],
    };
    const safe = { ...oversized, id: SEGMENT, name: 'Safe sibling', actions: [{ type: 'reboot' }] };
    const client = {
      testConnection: jest.fn(), listOrganizations: jest.fn(),
      fetchPage: jest.fn().mockResolvedValue({
        schemaVersion: '1', snapshotAt: '2026-07-14T12:00:00.000Z', data: [oversized, safe],
        nextCursor: null, hasMore: false,
      }),
    };
    const page = await new BreezeDriver(client).fetchRecords(
      { ...ctx('automations'), mode: 'full', updatedSince: null }, null,
    );
    expect(page.records).toHaveLength(1);
    expect(page.blockedInputs).toEqual([expect.objectContaining({
      kind: 'validation', externalId: `${ORG}:automations:${DEVICE}`,
      details: expect.objectContaining({ reasonCode: 'bounded_input', sourceId: DEVICE }),
    })]);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain(oversizedName);
    expect(serialized).not.toContain('x'.repeat(1_100));
  });

  it('reports an inspection-bounded definition as validation instead of a secret block', async () => {
    const oversized = {
      ...base, siteId: null, sourceScope: 'organization', name: 'Large benign policy',
      description: null, status: 'active',
      features: [{
        id: SEGMENT, type: 'settings', policyId: null,
        settings: { documentation: 'x'.repeat(12_289) },
      }],
    };
    const safe = {
      ...oversized, id: SEGMENT, name: 'Safe sibling',
      features: [{ ...oversized.features[0], settings: { documentation: 'Routine policy' } }],
    };
    const client = {
      testConnection: jest.fn(), listOrganizations: jest.fn(),
      fetchPage: jest.fn().mockResolvedValue({
        schemaVersion: '1', snapshotAt: '2026-07-14T12:00:00.000Z', data: [oversized, safe],
        nextCursor: null, hasMore: false,
      }),
    };

    const page = await new BreezeDriver(client).fetchRecords(
      { ...ctx('configuration-policies'), mode: 'full', updatedSince: null }, null,
    );

    expect(page.records).toHaveLength(1);
    expect(page.blockedInputs).toEqual([expect.objectContaining({
      kind: 'validation',
      externalId: `${ORG}:configuration-policies:${DEVICE}`,
      details: expect.objectContaining({ reasonCode: 'bounded_input', sourceId: DEVICE }),
    })]);
    expect(page.blockedInputs).not.toEqual([
      expect.objectContaining({ kind: 'secret_blocked' }),
    ]);
  });

  it('withholds an inline secret span and syncs every record of the page', async () => {
    const secret = token(48, 11);
    const page = await scriptPage([script(`echo ${secret}`, DEVICE, 'Unsafe'), script('true', SEGMENT, 'Safe')]);
    expect(page.records).toHaveLength(2);
    expect(page.blockedInputs).toEqual([]);
    expect(page.redactions).toEqual([{ externalId: `${ORG}:scripts:${DEVICE}`, count: 1, fieldPaths: ['content'] }]);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain(`echo ${WITHHELD}`);
  });

  it('keeps 21 maximum-cardinality fan-out parents within two bounded lossless pages', async () => {
    const uuid = (value: number) =>
      `${value.toString(16).padStart(8, '0')}-0000-4000-8000-${value
        .toString(16)
        .padStart(12, '0')}`;
    const parents = Array.from({ length: 21 }, (_, parentIndex) => {
      const siteId = uuid(parentIndex + 1);
      return {
        ...siteInventory,
        id: siteId,
        siteId,
        siteSubjectId: siteId,
        networkEquipment: Array.from({ length: 500 }, (_, childIndex) => {
          const value = (parentIndex + 1) * 1_000 + childIndex + 1;
          return {
            id: uuid(value),
            type: 'switch' as const,
            name: `Switch ${value}`,
            address: '10.20.0.2',
            macAddress: null,
            manufacturer: null,
            model: null,
          };
        }),
        networkSegments: [],
        collections: {
          networkEquipment: { total: 500, included: 500, complete: true, reason: null },
          networkSegments: { total: 0, included: 0, complete: true, reason: null },
        },
      };
    });
    const client = {
      testConnection: jest.fn(),
      listOrganizations: jest.fn(),
      fetchPage: jest
        .fn()
        .mockResolvedValueOnce({
          schemaVersion: '1',
          snapshotAt: '2026-07-14T12:00:00.000Z',
          data: parents.slice(0, 20),
          nextCursor: 'fanout-page-2',
          hasMore: true,
        })
        .mockResolvedValueOnce({
          schemaVersion: '1',
          snapshotAt: '2026-07-14T12:00:00.000Z',
          data: parents.slice(20),
          nextCursor: null,
          hasMore: false,
        }),
    };
    const driver = new BreezeDriver(client);
    const fullContext = { ...ctx('network-equipment'), mode: 'full' as const, updatedSince: null };

    const first = await driver.fetchRecords(fullContext, null);
    const second = await driver.fetchRecords(
      { ...fullContext, snapshotAt: first.snapshotAt ?? null },
      first.cursor ?? null,
    );
    const identities = [...first.records, ...second.records].map((record) =>
      'externalId' in record ? record.externalId : record.reconstructionInput.externalId,
    );

    expect(first.records).toHaveLength(10_000);
    expect(second.records).toHaveLength(500);
    expect(Math.max(first.records.length, second.records.length)).toBeLessThanOrEqual(10_000);
    expect(new Set(identities).size).toBe(10_500);
    expect(client.fetchPage).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ resource: 'network-equipment', cursor: null }),
    );
    expect(client.fetchPage).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ resource: 'network-equipment', cursor: 'fanout-page-2' }),
    );
  });

  it('deduplicates the same UUID-backed native source emitted by multiple parent rows', async () => {
    const secondDevice = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const client = {
      testConnection: jest.fn(),
      listOrganizations: jest.fn(),
      fetchPage: jest.fn().mockResolvedValue({
        schemaVersion: '1',
        snapshotAt: '2026-07-14T12:00:00.000Z',
        data: [deviceInventory, { ...deviceInventory, id: secondDevice, deviceId: secondDevice }],
        nextCursor: null,
        hasMore: false,
      }),
    };
    const page = await new BreezeDriver(client).fetchRecords(ctx('subnets'), null);
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({
      reconstructionInput: { externalId: `${ORG}:subnets:${STATIC_ADDRESS}` },
    });
  });

  it('merges a site segment and compatible device static network independent of input order', async () => {
    const fetch = async (data: unknown[]) => {
      const client = {
        testConnection: jest.fn(),
        listOrganizations: jest.fn(),
        fetchPage: jest.fn().mockResolvedValue({
          schemaVersion: '1',
          snapshotAt: '2026-07-14T12:00:00.000Z',
          data,
          nextCursor: null,
          hasMore: false,
        }),
      };
      return new BreezeDriver(client).fetchRecords(
        { ...ctx('subnets'), mode: 'full', updatedSince: null },
        null,
      );
    };

    const latestDevice = {
      ...deviceInventory,
      sourceUpdatedAt: '2026-07-14T11:30:00.000Z',
      revision: 'b'.repeat(64),
    };
    const forward = await fetch([siteInventory, latestDevice]);
    const reverse = await fetch([latestDevice, siteInventory]);

    expect(forward.records).toEqual(reverse.records);
    expect(forward.records).toHaveLength(2);
    expect(forward.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reconstructionInput: expect.objectContaining({
            externalId: `${ORG}:subnets:${SEGMENT}`,
            cidr: '10.20.0.0/24',
            gateway: '10.20.0.1',
            source: expect.objectContaining({ sourceId: SEGMENT }),
          }),
        }),
        expect.objectContaining({
          reconstructionInput: expect.objectContaining({
            externalId: `${ORG}:subnets:${STATIC_ADDRESS}`,
            cidr: '10.20.0.0/24',
            gateway: '10.20.0.1',
            source: expect.objectContaining({ sourceId: STATIC_ADDRESS }),
          }),
        }),
      ]),
    );
  });

  it('retains convergent reservation source UUIDs independent of input order', async () => {
    const secondDevice = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const fetch = async (data: unknown[]) => {
      const client = {
        testConnection: jest.fn(),
        listOrganizations: jest.fn(),
        fetchPage: jest.fn().mockResolvedValue({
          schemaVersion: '1',
          snapshotAt: '2026-07-14T12:00:00.000Z',
          data,
          nextCursor: null,
          hasMore: false,
        }),
      };
      return new BreezeDriver(client).fetchRecords(ctx('ip-reservations'), null);
    };
    const secondAddress = '15151515-1515-4515-8515-151515151515';
    const duplicate = {
      ...deviceInventory,
      id: secondDevice,
      deviceId: secondDevice,
      addresses: deviceInventory.addresses.map((address, index) =>
        index === 0 ? { ...address, id: secondAddress } : address,
      ),
    };

    const forward = await fetch([deviceInventory, duplicate]);
    const reverse = await fetch([duplicate, deviceInventory]);

    expect(forward.records).toEqual(reverse.records);
    expect(forward.records).toHaveLength(2);
    expect(forward.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reconstructionInput: expect.objectContaining({
            externalId: `${ORG}:ip-reservations:${STATIC_ADDRESS}`,
            ipAddress: '10.20.0.50',
          }),
        }),
        expect.objectContaining({
          reconstructionInput: expect.objectContaining({
            externalId: `${ORG}:ip-reservations:${secondAddress}`,
            ipAddress: '10.20.0.50',
          }),
        }),
      ]),
    );
  });

  const pageOf = async (resource: string, data: unknown[], blocked?: unknown[]) => {
    const client = {
      testConnection: jest.fn(),
      listOrganizations: jest.fn(),
      fetchPage: jest.fn().mockResolvedValue({
        schemaVersion: '1', snapshotAt: '2026-07-14T12:00:00.000Z', data,
        nextCursor: null, hasMore: false, ...(blocked ? { blocked } : {}),
      }),
    };
    return new BreezeDriver(client).fetchRecords({ ...ctx(resource), mode: 'full', updatedSince: null }, null);
  };
  const otherDevice = {
    ...deviceInventory,
    id: '12121212-1212-4212-8212-121212121212',
    deviceId: '12121212-1212-4212-8212-121212121212',
    addresses: [{
      ...deviceInventory.addresses[0]!,
      id: '13131313-1313-4313-8313-131313131313',
      address: '10.40.0.50',
      gateway: '10.40.0.1',
    }],
    collections: { ...deviceInventory.collections, addresses: completeCollection },
  };

  it('skips duplicate stable identities with conflicting facts as record gaps and keeps the rest', async () => {
    const page = await pageOf('subnets', [
      deviceInventory,
      {
        ...deviceInventory,
        addresses: deviceInventory.addresses.map((address, index) =>
          index === 0 ? { ...address, gateway: '10.20.0.3' } : address,
        ),
      },
      otherDevice,
    ]);
    // Only the conflicting identity is skipped; the other device's network syncs.
    expect(page.records.map((record) => record.reconstructionInput?.externalId)).toEqual([
      `${ORG}:subnets:13131313-1313-4313-8313-131313131313`,
    ]);
    expect(page.blockedInputs).toEqual([expect.objectContaining({
      kind: 'validation',
      externalId: `${ORG}:subnets:${STATIC_ADDRESS}`,
      details: expect.objectContaining({ reasonCode: 'conflicting_duplicate_identity', sourceResource: 'subnets' }),
    })]);
  });

  it('skips every record of a network reported with two gateways and keeps the rest', async () => {
    const twin = {
      ...otherDevice,
      id: '15151515-1515-4515-8515-151515151515',
      deviceId: '15151515-1515-4515-8515-151515151515',
      addresses: [{ ...otherDevice.addresses[0]!, id: '16161616-1616-4616-8616-161616161616', address: '10.40.0.51', gateway: '10.40.0.2' }],
    };
    const page = await pageOf('subnets', [deviceInventory, otherDevice, twin]);
    expect(page.records.map((record) => record.reconstructionInput?.externalId)).toEqual([
      `${ORG}:subnets:${STATIC_ADDRESS}`,
    ]);
    expect(page.blockedInputs).toEqual([
      expect.objectContaining({
        kind: 'validation', externalId: `${ORG}:subnets:13131313-1313-4313-8313-131313131313`,
        details: expect.objectContaining({ reasonCode: 'conflicting_subnet_gateways' }),
      }),
      expect.objectContaining({
        kind: 'validation', externalId: `${ORG}:subnets:16161616-1616-4616-8616-161616161616`,
        details: expect.objectContaining({ reasonCode: 'conflicting_subnet_gateways' }),
      }),
    ]);
  });

  it('skips one record with an invalid gateway as a gap and syncs its page siblings', async () => {
    const broken = {
      ...otherDevice,
      addresses: [{ ...otherDevice.addresses[0]!, gateway: 'not-an-ip' }],
    };
    const page = await pageOf('subnets', [deviceInventory, broken]);
    expect(page.records).toHaveLength(1);
    expect(page.blockedInputs).toEqual([expect.objectContaining({
      kind: 'validation',
      externalId: `${ORG}:subnets:${otherDevice.id}`,
      details: expect.objectContaining({ reasonCode: 'invalid_static_gateway', sourceId: otherDevice.id }),
    })]);
    expect(JSON.stringify(page.blockedInputs)).not.toContain('not-an-ip');
  });

  it('turns an unreadable or other-resource withheld notice into a gap, not a failed page', async () => {
    const page = await pageOf('devices', [device], [
      { resource: 'devices', orgId: ORG, reason: 'secret_detected' },
      { resource: 'sites', id: SITE, orgId: ORG, reason: 'secret_detected', fieldPaths: [] },
    ]);
    expect(page.records).toHaveLength(1);
    expect(page.blockedInputs).toEqual([
      expect.objectContaining({ kind: 'validation', externalId: null,
        details: expect.objectContaining({ reasonCode: 'unreadable_blocked_notice' }) }),
      expect.objectContaining({ kind: 'validation', externalId: null,
        details: expect.objectContaining({ reasonCode: 'blocked_notice_other_resource' }) }),
    ]);
  });

  it('passes incremental metadata and returns safe blocked gaps plus terminal high-water metadata', async () => {
    const client = {
      testConnection: jest.fn(),
      listOrganizations: jest.fn(),
      fetchPage: jest.fn().mockResolvedValue({
        schemaVersion: '1',
        snapshotAt: '2026-07-14T12:00:00.000Z',
        data: [device],
        nextCursor: null,
        hasMore: false,
        blocked: [
          {
            resource: 'devices',
            id: DEVICE,
            orgId: ORG,
            reason: 'secret_detected',
            fieldPaths: ['hardwareIdentity.serialNumber'],
          },
        ],
      }),
    };
    const page = await new BreezeDriver(client).fetchRecords(ctx(), null);
    expect(client.fetchPage).toHaveBeenCalledWith(expect.anything(), {
      resource: 'devices',
      externalOrgId: ORG,
      cursor: null,
      updatedSince: UPDATED_SINCE,
      acceptedSchemaVersion: null,
      acceptAnySchemaVersion: false,
    });
    expect(page).toMatchObject({
      schemaVersion: '1',
      snapshotAt: '2026-07-14T12:00:00.000Z',
      hasMore: false,
      cursor: null,
      terminal: true,
      sourceHighWater: '2026-07-14T12:00:00.000Z',
      blockedInputs: [
        {
          kind: 'secret_blocked',
          externalId: `${ORG}:devices:${DEVICE}`,
          message: expect.stringMatching(/^Breeze withheld a devices record/),
          details: {
            reasonCode: 'secret_detected',
            fieldPaths: ['hardwareIdentity.serialNumber'],
            sourceResource: 'devices',
            sourceOrgId: ORG,
            sourceId: DEVICE,
          },
        },
      ],
    });
    expect(JSON.stringify(page)).not.toContain('top-secret');
  });

  it('passes no updatedSince for full mode and rejects unknown resources before client I/O', async () => {
    const client = {
      testConnection: jest.fn(),
      listOrganizations: jest.fn(),
      fetchPage: jest.fn(),
    };
    await expect(
      new BreezeDriver(client).fetchRecords({ ...ctx('unknown'), mode: 'full' }, null),
    ).rejects.toThrow(/resource/i);
    expect(client.fetchPage).not.toHaveBeenCalled();
  });

  it('rejects cross-organization blocked metadata', async () => {
    const client = {
      testConnection: jest.fn(),
      listOrganizations: jest.fn(),
      fetchPage: jest.fn().mockResolvedValue({
        schemaVersion: '1',
        snapshotAt: '2026-07-14T12:00:00.000Z',
        data: [],
        nextCursor: null,
        hasMore: false,
        blocked: [
          {
            resource: 'devices',
            id: DEVICE,
            orgId: '44444444-4444-4444-8444-444444444444',
            reason: 'secret_detected',
            fieldPaths: ['hardwareIdentity.serialNumber'],
          },
        ],
      }),
    };
    await expect(new BreezeDriver(client).fetchRecords(ctx(), null)).rejects.toThrow(
      /organization/i,
    );
  });

  it.each([
    {
      name: 'future record',
      updatedSince: UPDATED,
      data: [{ ...device, sourceUpdatedAt: '2026-07-14T12:00:00.001Z' }],
    },
    {
      name: 'record equal to updatedSince',
      updatedSince: UPDATED,
      data: [device],
    },
    {
      name: 'out-of-order incremental page',
      updatedSince: '2026-07-14T10:00:00.000Z',
      data: [{ ...device, sourceUpdatedAt: '2026-07-14T11:30:00.000Z' }, device],
    },
  ])('accepts $name and checkpoints at the snapshot', async ({ updatedSince, data }) => {
    const client = {
      testConnection: jest.fn(),
      listOrganizations: jest.fn(),
      fetchPage: jest.fn().mockResolvedValue({
        schemaVersion: '1',
        snapshotAt: '2026-07-14T12:00:00.000Z',
        data,
        nextCursor: null,
        hasMore: false,
      }),
    };
    // Ordering and clock skew are Breeze's concern. The checkpoint is the
    // snapshot, so neither can move it past a change Weavestream has not seen.
    const page = await new BreezeDriver(client).fetchRecords({ ...ctx(), updatedSince }, null);
    expect(page.records.length).toBeGreaterThan(0);
    expect(page).toMatchObject({ sourceHighWater: '2026-07-14T12:00:00.000Z', blockedInputs: [] });
  });

  it('accepts full pages ordered by UUID rather than sourceUpdatedAt', async () => {
    const client = {
      testConnection: jest.fn(),
      listOrganizations: jest.fn(),
      fetchPage: jest.fn().mockResolvedValue({
        schemaVersion: '1',
        snapshotAt: '2026-07-14T12:00:00.000Z',
        data: [
          {
            ...device,
            id: '00000000-0000-4000-8000-000000000001',
            sourceUpdatedAt: '2026-07-14T11:30:00.000Z',
          },
          {
            ...device,
            id: '00000000-0000-4000-8000-000000000002',
            sourceUpdatedAt: '2026-07-14T11:00:00.000Z',
          },
        ],
        nextCursor: null,
        hasMore: false,
      }),
    };
    const page = await new BreezeDriver(client).fetchRecords({ ...ctx(), mode: 'full' }, null);
    expect(page).toMatchObject({ sourceHighWater: null });
    expect(page.records).toHaveLength(2);
  });

  it('bootstraps an incremental run without updatedSince from a UUID-ordered page', async () => {
    // Breeze picks its traversal mode from the presence of `updatedSince`
    // alone, so the first incremental run after a full traversal receives a
    // full-mode (UUID-ordered) page. It must be accepted and must seed the
    // high water from the snapshot so the next run is truly incremental.
    const snapshotAt = '2026-07-14T12:00:00.000Z';
    const client = {
      testConnection: jest.fn(),
      listOrganizations: jest.fn(),
      fetchPage: jest.fn().mockResolvedValue({
        schemaVersion: '1',
        snapshotAt,
        data: [
          {
            ...device,
            id: '00000000-0000-4000-8000-000000000001',
            sourceUpdatedAt: '2026-07-14T11:30:00.000Z',
          },
          {
            ...device,
            id: '00000000-0000-4000-8000-000000000002',
            sourceUpdatedAt: '2026-07-14T11:00:00.000Z',
          },
        ],
        nextCursor: null,
        hasMore: false,
      }),
    };
    const page = await new BreezeDriver(client).fetchRecords(
      { ...ctx(), mode: 'incremental', updatedSince: null },
      null,
    );
    expect(client.fetchPage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ updatedSince: null }),
    );
    expect(page.records).toHaveLength(2);
    expect(page).toMatchObject({ sourceHighWater: snapshotAt, terminal: true });
  });

  it('emits the snapshot as incremental high-water without retaining failed traversal state', async () => {
    const newer = { ...device, sourceUpdatedAt: '2026-07-14T11:30:00.000Z' };
    const client = {
      testConnection: jest.fn(),
      listOrganizations: jest.fn(),
      fetchPage: jest
        .fn()
        .mockResolvedValueOnce({
          schemaVersion: '1',
          snapshotAt: '2026-07-14T12:00:00.000Z',
          data: [newer],
          nextCursor: 'cursor-1',
          hasMore: true,
        })
        .mockRejectedValueOnce(new Error('failed page'))
        .mockResolvedValueOnce({
          schemaVersion: '1',
          snapshotAt: '2026-07-14T12:00:00.000Z',
          data: [device],
          nextCursor: null,
          hasMore: false,
        })
        .mockResolvedValueOnce({
          schemaVersion: '1',
          snapshotAt: '2026-07-14T12:00:00.000Z',
          data: [device],
          nextCursor: null,
          hasMore: false,
        }),
    };
    const driver = new BreezeDriver(client);
    await expect(driver.fetchRecords(ctx(), null)).resolves.toMatchObject({
      sourceHighWater: '2026-07-14T12:00:00.000Z',
    });
    await expect(
      driver.fetchRecords({ ...ctx(), snapshotAt: '2026-07-14T12:00:00.000Z' }, 'cursor-1'),
    ).rejects.toThrow('failed page');
    await expect(driver.fetchRecords(ctx(), null)).resolves.toMatchObject({
      sourceHighWater: '2026-07-14T12:00:00.000Z',
    });
    await expect(driver.fetchRecords({ ...ctx(), mode: 'full' }, null)).resolves.toMatchObject({
      sourceHighWater: null,
    });
  });

  it('delegates connection and organization discovery without name mapping', async () => {
    const client = {
      testConnection: jest.fn().mockResolvedValue({ schemaVersion: '1' }),
      listOrganizations: jest.fn().mockResolvedValue([
        {
          ...base,
          id: ORG,
          orgId: ORG,
          siteId: null,
          name: 'Acme',
          slug: 'acme',
          type: 'customer',
        },
      ]),
      fetchPage: jest.fn(),
    };
    const driver = new BreezeDriver(client);
    await expect(driver.testConnection(ctx() as IntegrationContext)).resolves.toEqual({
      ok: true,
      details: 'Reached Breeze Partner API (partner API schema version 1).',
    });
    await expect(driver.listSourceOrgs(ctx() as IntegrationContext)).resolves.toEqual([
      { externalId: ORG, name: 'Acme', hint: 'customer' },
    ]);
    client.testConnection.mockResolvedValueOnce({ schemaVersion: '2' });
    await expect(driver.testConnection(ctx() as IntegrationContext)).resolves.toEqual({
      ok: true,
      details: expect.stringContaining('schema version 2, which Weavestream does not know yet. Sync is paused'),
    });
  });

  it('names the Breeze release in the test result, and a failed release read never fails the test', async () => {
    const client = {
      testConnection: jest.fn().mockResolvedValue({ schemaVersion: '1' }),
      readServerVersion: jest.fn().mockResolvedValue('0.126.0'),
      listOrganizations: jest.fn(),
      fetchPage: jest.fn(),
    };
    const driver = new BreezeDriver(client);
    await expect(driver.testConnection(ctx() as IntegrationContext)).resolves.toEqual({
      ok: true,
      details: 'Reached Breeze Partner API (Breeze 0.126.0, partner API schema version 1).',
    });
    client.readServerVersion.mockRejectedValueOnce(new Error('health unreachable'));
    await expect(driver.testConnection(ctx() as IntegrationContext)).resolves.toEqual({
      ok: true,
      details: 'Reached Breeze Partner API (partner API schema version 1).',
    });
    // A rejected partner API call still fails the test.
    client.testConnection.mockRejectedValueOnce(new Error('Breeze partner API credentials were rejected.'));
    await expect(driver.testConnection(ctx() as IntegrationContext)).rejects.toThrow('credentials were rejected');
  });

  it('reads the source version for a run and turns each failed half into null', async () => {
    const client = {
      testConnection: jest.fn().mockResolvedValue({ schemaVersion: '1' }),
      readServerVersion: jest.fn().mockResolvedValue('0.126.0'),
      listOrganizations: jest.fn(),
      fetchPage: jest.fn(),
    };
    const driver = new BreezeDriver(client);
    await expect(driver.readSourceVersion(ctx() as IntegrationContext)).resolves.toEqual({
      serverVersion: '0.126.0',
      schemaVersion: '1',
    });
    client.readServerVersion.mockRejectedValueOnce(new Error('timeout'));
    await expect(driver.readSourceVersion(ctx() as IntegrationContext)).resolves.toEqual({
      serverVersion: null,
      schemaVersion: '1',
    });
    client.testConnection.mockRejectedValueOnce(new Error('Breeze partner API request failed.'));
    await expect(driver.readSourceVersion(ctx() as IntegrationContext)).resolves.toEqual({
      serverVersion: '0.126.0',
      schemaVersion: null,
    });
    // A client that cannot read the release reports none.
    const bare = new BreezeDriver({ ...client, readServerVersion: undefined });
    await expect(bare.readSourceVersion(ctx() as IntegrationContext)).resolves.toEqual({
      serverVersion: null,
      schemaVersion: '1',
    });
  });

  it('passes the accepted schema version and an accepting run to the client', async () => {
    const client = {
      testConnection: jest.fn(), listOrganizations: jest.fn(),
      fetchPage: jest.fn().mockResolvedValue({
        schemaVersion: '2', snapshotAt: '2026-07-14T12:00:00.000Z', data: [], nextCursor: null, hasMore: false,
      }),
    };
    const page = await new BreezeDriver(client).fetchRecords(
      { ...ctx(), acceptedSourceVersion: '2', acceptAnySourceVersion: true }, null,
    );
    expect(client.fetchPage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      acceptedSchemaVersion: '2', acceptAnySchemaVersion: true,
    }));
    expect(page.schemaVersion).toBe('2');
  });
});

describe('Breeze scalar custom-field value contract', () => {
  const definitionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const valueId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const definition = {
    ...base,
    id: definitionId,
    siteId: null,
    sourceScope: 'partner' as const,
    name: 'Rack',
    fieldKey: 'rack',
    type: 'text' as const,
    options: null,
    required: false,
    defaultValue: null,
    deviceTypes: ['server'],
  };
  const scalarValue = {
    ...base,
    id: valueId,
    siteId: null,
    deviceId: DEVICE,
    definitionId,
    target: { type: 'device' as const, id: DEVICE },
    name: 'Rack',
    fieldKey: 'rack',
    type: 'text' as const,
    value: 'DC1-R07',
  };

  it('keeps definition and scalar endpoints separate while preserving value and device identities', () => {
    const resources = new BreezeDriver().descriptor.resources;
    expect(resources.find(({ key }) => key === 'custom-fields')).toMatchObject({
      targetConfig: { sourceEndpoint: '/custom-fields' },
    });
    expect(resources.find(({ key }) => key === 'custom-field-values')).toMatchObject({
      targetConfig: {
        sourceEndpoint: '/custom-field-values',
        bindingResourceKey: 'devices',
      },
    });
    expect(resources.some(({ key }) => key === 'custom-field-value-relations')).toBe(false);
    expect(new BreezeDriver().recommendedDestinations?.['custom-field-values']?.fields).toEqual([]);

    const [definitionRecord] = transformBreezeRecord('custom-fields', definition) as Array<{
      reconstructionInput: Record<string, unknown>;
    }>;
    expect(definitionRecord?.reconstructionInput).toMatchObject({
      targetKind: 'article',
      externalId: `${ORG}:custom-fields:${definitionId}`,
    });

    const first = transformBreezeRecord('custom-field-values', scalarValue);
    const repeated = transformBreezeRecord('custom-field-values', scalarValue);
    expect(repeated).toEqual(first);
    expect(first).toEqual([
      expect.objectContaining({
        externalId: valueId,
        mappingSourceField: definitionId,
        bindingRef: {
          resourceKey: 'devices',
          externalId: `${ORG}:devices:${DEVICE}`,
        },
        fields: { [definitionId]: 'DC1-R07' },
      }),
    ]);
    expect(JSON.stringify(first)).not.toMatch(/fieldName|fieldType|"value":/u);
  });

  it('walks more than 500 definition and scalar rows with independent cursors', async () => {
    const uuid = (prefix: string, index: number) =>
      `${prefix}0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    const definitions = Array.from({ length: 501 }, (_, index) => ({
      ...definition,
      id: uuid('1', index),
      name: `Field ${index}`,
      fieldKey: `field_${index}`,
    }));
    const values = Array.from({ length: 501 }, (_, index) => ({
      ...scalarValue,
      id: uuid('2', index),
      definitionId: definitions[index]!.id,
      name: definitions[index]!.name,
      fieldKey: definitions[index]!.fieldKey,
      value: `value-${index}`,
    }));
    const client = {
      testConnection: jest.fn(),
      listOrganizations: jest.fn(),
      fetchPage: jest.fn(async (_context: unknown, input: { resource: string; cursor: string | null }) => {
        const isDefinition = input.resource === 'custom-fields';
        const data = isDefinition ? definitions : values;
        const expectedCursor = isDefinition ? 'definition-cursor-1' : 'value-cursor-1';
        const secondPage = input.cursor === expectedCursor;
        return {
          schemaVersion: '1' as const,
          snapshotAt: '2026-07-14T12:00:00.000Z',
          data: secondPage ? data.slice(500) : data.slice(0, 500),
          nextCursor: secondPage ? null : expectedCursor,
          hasMore: !secondPage,
        };
      }),
    };
    const driver = new BreezeDriver(client);
    const definitionFirst = await driver.fetchRecords(ctx('custom-fields'), null);
    const definitionSecond = await driver.fetchRecords(
      { ...ctx('custom-fields'), snapshotAt: definitionFirst.snapshotAt ?? null },
      definitionFirst.cursor ?? null,
    );
    const valueFirst = await driver.fetchRecords(ctx('custom-field-values'), null);
    const valueSecond = await driver.fetchRecords(
      { ...ctx('custom-field-values'), snapshotAt: valueFirst.snapshotAt ?? null },
      valueFirst.cursor ?? null,
    );

    expect([...definitionFirst.records, ...definitionSecond.records]).toHaveLength(501);
    const emittedValues = [...valueFirst.records, ...valueSecond.records];
    expect(emittedValues).toHaveLength(501);
    expect(new Set(emittedValues.map(({ externalId }) => externalId)).size).toBe(501);
    expect(client.fetchPage.mock.calls.map(([, input]) => [input.resource, input.cursor])).toEqual([
      ['custom-fields', null],
      ['custom-fields', 'definition-cursor-1'],
      ['custom-field-values', null],
      ['custom-field-values', 'value-cursor-1'],
    ]);
  });

  it('strips unknown scalar keys and withholds a credential-named scalar value, keeping the record', async () => {
    expect(JSON.stringify(transformBreezeRecord('custom-field-values', {
      ...scalarValue,
      providerConfig: { accessToken: 'must-never-enter-weavestream' },
    }))).not.toMatch(/providerConfig|must-never-enter-weavestream/u);
    // The binding comes from `deviceId` alone; Breeze's `target` echo is not read.
    expect(transformBreezeRecord('custom-field-values', {
      ...scalarValue,
      target: { type: 'device', id: SITE },
    })).toEqual([expect.objectContaining({
      bindingRef: { resourceKey: 'devices', externalId: `${ORG}:devices:${DEVICE}` },
    })]);

    const secret = 'must-never-enter-weavestream';
    const client = {
      testConnection: jest.fn(),
      listOrganizations: jest.fn(),
      fetchPage: jest.fn().mockResolvedValue({
        schemaVersion: '1',
        snapshotAt: '2026-07-14T12:00:00.000Z',
        data: [{
          ...scalarValue,
          name: 'Local admin password',
          fieldKey: 'local_admin_password',
          value: secret,
        }],
        nextCursor: null,
        hasMore: false,
      }),
    };
    const page = await new BreezeDriver(client).fetchRecords(ctx('custom-field-values'), null);
    expect(page.records).toHaveLength(1);
    expect(page.blockedInputs).toEqual([]);
    expect(page.redactions).toEqual([
      { externalId: `${ORG}:custom-field-values:${valueId}`, count: 1, fieldPaths: ['value'] },
    ]);
    expect(JSON.stringify(page)).not.toContain(secret);
  });
});

// Breeze adds fields within schemaVersion "1" (Weavestream/Weavestream#47).
// These payloads mirror Breeze v0.121's partner API contract.
describe('Breeze upgrade tolerance', () => {
  const memoryModule = {
    id: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd', locator: 'DIMM_A1', bankLabel: 'BANK 0',
    populated: true, capacityMb: 16384, memoryType: 'DDR5', formFactor: 'DIMM',
    speedMts: 4800, configuredSpeedMts: 4800, manufacturer: 'Samsung',
    partNumber: 'M323R2GA3BB0', serialNumber: 'S-1',
  };
  const v121Inventory = {
    ...deviceInventory,
    hardware: {
      ...deviceInventory.hardware,
      memory: { totalMb: 32768, slotsTotal: 4, maxCapacityMb: 131072, soldered: false },
    },
    memoryModules: [memoryModule],
    collections: { ...deviceInventory.collections, memoryModules: completeCollection },
  };

  it('reads v0.118+ device inventory and drops the memory-module fields it does not use', () => {
    const before = transformBreezeRecord('device-inventory', deviceInventory);
    const after = transformBreezeRecord('device-inventory', v121Inventory);
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toMatch(/memoryModules|slotsTotal|DIMM_A1/u);
    expect(transformBreezeRecord('virtual-machines', v121Inventory).length)
      .toBe(transformBreezeRecord('virtual-machines', deviceInventory).length);
  });

  it('reads v0.111+ configuration policies that carry parentPolicyId', () => {
    const policy = {
      ...base, siteId: null, sourceScope: 'organization', name: 'Child policy', description: null,
      status: 'active', parentPolicyId: SEGMENT,
      features: [{ id: SOFTWARE, type: 'patching', policyId: null, settings: { window: 'nightly' } }],
    };
    const [article] = transformBreezeRecord('configuration-policies', policy) as Array<{
      reconstructionInput: { markdown: string };
    }>;
    expect(article!.reconstructionInput.markdown).toContain('Child policy');
  });

  it('reads backup configurations that send completenessGaps and no restore block', () => {
    const records = transformBreezeRecord('backup-configurations', {
      ...base, siteId: null, kind: 'destination', sourceScope: 'organization', name: 'Offsite',
      type: 'file', provider: 's3', compression: true, encryption: true, active: true, default: true,
      schedule: null, retention: null, exclusions: [],
      completenessGaps: [{ code: 'restore_procedure_unavailable' }],
    });
    expect(records).toHaveLength(1);
    const [record] = records as Array<{ reconstructionInput: { markdown: string } }>;
    expect(record!.reconstructionInput.markdown).not.toContain('Restore capabilities');
    expect(record!.reconstructionInput.markdown).not.toContain('restore_procedure_unavailable');
  });

  it('ignores a restore block from an older Breeze release', () => {
    const [record] = transformBreezeRecord('backup-configurations', {
      ...base, siteId: null, kind: 'destination', sourceScope: 'organization', name: 'Offsite',
      type: 'file', provider: 's3', compression: true, encryption: true, active: true, default: true,
      schedule: null, retention: null, exclusions: [],
      restore: { types: ['full'], notes: 'Restore from the vault.' },
    }) as Array<{ reconstructionInput: { markdown: string } }>;
    expect(record!.reconstructionInput.markdown).not.toContain('Restore capabilities');
    expect(record!.reconstructionInput.markdown).not.toContain('Restore from the vault.');
  });

  it('skips record variants and relationship endpoints it does not model', () => {
    expect(transformBreezeRecord('device-inventory', { ...deviceInventory, subjectType: 'cloud_account' }))
      .toEqual([]);
    expect(transformBreezeRecord('backup-configurations', { ...base, kind: 'replication_job', name: 'x' }))
      .toEqual([]);
  });

  it('accepts new enum values as text and missing optional fields as null', () => {
    const [record] = transformBreezeRecord('devices', {
      ...device,
      type: { os: 'freebsd', role: 'appliance', virtual: true, virtualizationPlatform: 'bhyve' },
      operatingSystem: undefined,
      stableIdentifiers: undefined,
    }) as Array<{ fields: Record<string, unknown> }>;
    expect(record!.fields).toMatchObject({
      deviceType: 'freebsd', virtualizationRole: 'bhyve', osEdition: null, assetTag: null,
    });
  });

  it('syncs the rest of a page and reports an unreadable record without its values', async () => {
    const unreadableId = 'efefefef-efef-4fef-8fef-efefefefefef';
    const client = {
      testConnection: jest.fn(),
      listOrganizations: jest.fn(),
      fetchPage: jest.fn().mockResolvedValue({
        schemaVersion: '1',
        snapshotAt: '2026-07-14T12:00:00.000Z',
        data: [device, { ...device, id: unreadableId, hostname: { value: 'unexpected-shape' } }],
        nextCursor: null,
        hasMore: false,
      }),
    };
    const page = await new BreezeDriver(client).fetchRecords(ctx(), null);
    expect(page.records).toHaveLength(1);
    expect(page.blockedInputs).toEqual([
      expect.objectContaining({
        kind: 'validation',
        externalId: `${ORG}:devices:${unreadableId}`,
        details: expect.objectContaining({
          reasonCode: 'unreadable_source_record',
          fieldPaths: ['hostname'],
          sourceId: unreadableId,
        }),
      }),
    ]);
    expect(JSON.stringify(page.blockedInputs)).not.toContain('unexpected-shape');
  });

  const automation = {
    ...base, siteId: null, sourceScope: 'organization', name: 'Nightly', description: null,
    enabled: true, trigger: { type: 'schedule' }, conditions: null, actions: [{ type: 'run_script' }],
    onFailure: 'stop', notificationTargets: null, dependencies: [],
  };
  const nested = (depth: number): unknown => (depth === 0 ? 'leaf' : { next: nested(depth - 1) });
  const pageOf = (data: unknown[]) => ({
    testConnection: jest.fn(),
    listOrganizations: jest.fn(),
    fetchPage: jest.fn().mockResolvedValue({
      schemaVersion: '1', snapshotAt: '2026-07-14T12:00:00.000Z', data, nextCursor: null, hasMore: false,
    }),
  });

  it('reports a missing discriminator as unreadable but skips a named unknown variant', async () => {
    const missingId = 'abcdabcd-abcd-4bcd-8bcd-abcdabcdabcd';
    const { subjectType: _subjectType, ...withoutSubject } = deviceInventory;
    const page = await new BreezeDriver(pageOf([
      deviceInventory,
      { ...withoutSubject, id: missingId },
      { ...deviceInventory, id: SEGMENT, subjectType: 'cloud_account' },
    ])).fetchRecords(ctx('device-inventory'), null);
    expect(page.records).toHaveLength(1);
    // The unreadable gap keeps the traversal non-authoritative, so the stale
    // sweep cannot archive what this record synced before.
    expect(page.blockedInputs).toEqual([
      expect.objectContaining({
        kind: 'validation',
        externalId: `${ORG}:device-inventory:${missingId}`,
        details: expect.objectContaining({ reasonCode: 'unreadable_source_record', fieldPaths: ['subjectType'] }),
      }),
    ]);
  });

  it.each([
    ['blank', ''],
    ['whitespace', '  '],
    ['malformed', 'device site'],
    ['non-text', 7],
  ])('reports a %s discriminator as unreadable instead of skipping it', async (_label, value) => {
    const inventoryId = 'abcdabcd-abcd-4bcd-8bcd-abcdabcdabcd';
    const backupId = 'bcdebcde-bcde-4cde-8cde-bcdebcdebcde';
    const inventory = await new BreezeDriver(pageOf([{ ...deviceInventory, id: inventoryId, subjectType: value }]))
      .fetchRecords(ctx('device-inventory'), null);
    const backups = await new BreezeDriver(pageOf([{ ...base, id: backupId, siteId: null, kind: value, name: 'x' }]))
      .fetchRecords(ctx('backup-configurations'), null);
    for (const [page, id, resource] of [
      [inventory, inventoryId, 'device-inventory'],
      [backups, backupId, 'backup-configurations'],
    ] as const) {
      expect(page.records).toEqual([]);
      expect(page.blockedInputs).toEqual([
        expect.objectContaining({
          kind: 'validation',
          externalId: `${ORG}:${resource}:${id}`,
          details: expect.objectContaining({ reasonCode: 'unreadable_source_record' }),
        }),
      ]);
    }
  });

  it('reports an over-long list instead of truncating it', () => {
    const actions = Array.from({ length: 1_001 }, (_, index) => ({ type: 'run_script', step: index }));
    expect(() => transformBreezeRecord('automations', { ...automation, actions }))
      .toThrow(expect.objectContaining({ name: 'BreezeUnreadableRecordError', fieldPaths: ['actions'] }));
    expect(transformBreezeRecord('automations', { ...automation, actions: actions.slice(0, 1_000) }))
      .toHaveLength(1);
  });

  it('ignores a deeply nested unknown field and isolates a too-deep field it reads', async () => {
    expect(transformBreezeRecord('automations', { ...automation, addedLater: nested(40) })).toHaveLength(1);
    const tooDeepId = 'dcbadcba-dcba-4cba-8cba-dcbadcbadcba';
    const page = await new BreezeDriver(pageOf([
      automation,
      { ...automation, id: tooDeepId, trigger: nested(40) },
    ])).fetchRecords(ctx('automations'), null);
    expect(page.records).toHaveLength(1);
    expect(page.blockedInputs).toEqual([
      expect.objectContaining({
        kind: 'validation',
        externalId: `${ORG}:automations:${tooDeepId}`,
        details: expect.objectContaining({ reasonCode: 'unreadable_source_record', fieldPaths: ['(record)'] }),
      }),
    ]);
  });

  it('still rejects a record for a different organization', async () => {
    const client = {
      testConnection: jest.fn(),
      listOrganizations: jest.fn(),
      fetchPage: jest.fn().mockResolvedValue({
        schemaVersion: '1',
        snapshotAt: '2026-07-14T12:00:00.000Z',
        data: [{ ...device, orgId: SITE }],
        nextCursor: null,
        hasMore: false,
      }),
    };
    await expect(new BreezeDriver(client).fetchRecords(ctx(), null)).rejects.toThrow(/organization/i);
  });
});

describe('BreezeDriver field-presence report', () => {
  it('reports key presence from the raw records, per variant, with no values', async () => {
    const OTHER = '12121212-1212-4212-8212-121212121212';
    const renamed = {
      ...deviceInventory,
      id: OTHER, deviceId: OTHER, disks: [], interfaces: [], virtualMachines: [],
      // Breeze renamed `assignment` on this device's addresses.
      addresses: deviceInventory.addresses.map(({ assignment: _assignment, ...rest }, index) => ({
        ...rest, id: `${OTHER.slice(0, -2)}${String(index).padStart(2, '0')}`, mode: 'static',
      })),
    };
    const client = {
      testConnection: jest.fn(), listOrganizations: jest.fn(),
      fetchPage: jest.fn().mockResolvedValue({
        schemaVersion: '1', snapshotAt: '2026-07-14T12:00:00.000Z',
        data: [deviceInventory, renamed, siteInventory], nextCursor: null, hasMore: false,
      }),
    };
    const page = await new BreezeDriver(client).fetchRecords(
      { ...ctx('device-inventory'), mode: 'full', updatedSince: null }, null,
    );
    const addressCount = deviceInventory.addresses.length;
    expect(page.observedFields).toContainEqual({
      path: 'addresses[].assignment', variant: 'device', present: addressCount, objects: addressCount * 2,
    });
    expect(page.observedFields).toContainEqual({ path: 'deviceId', variant: 'device', present: 2, objects: 2 });
    expect(page.observedFields).toContainEqual({ path: 'siteSubjectId', variant: 'site', present: 1, objects: 1 });
    // The renamed key is not declared, so it is never reported.
    expect(page.observedFields?.some((field) => field.path.endsWith('.mode'))).toBe(false);
    const serialized = JSON.stringify(page.observedFields);
    expect(serialized).not.toContain('Intel Xeon');
    expect(serialized).not.toContain(DEVICE);
  });
});
