import type { FetchRecordsContext, IntegrationContext } from '../integration-driver.js';
import { driverDescriptorSchema } from '@weavestream/shared';
import { BreezeDriver } from './breeze.driver.js';
import { transformBreezeRecord } from './breeze.transforms.js';
import { TextStrategy, TextareaStrategy } from '../../../field-types/strategies/text.strategy.js';

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
        dependsOnResourceKeys: [
          'sites',
          'devices',
          'site-inventory',
          'device-inventory',
          'device-software',
          'network-equipment',
          'virtual-machines',
          'subnets',
          'ip-reservations',
          'configuration-policies',
          'configuration-assignments',
          'configuration-assignment-relations',
          'scripts',
          'automations',
          'automation-relations',
          'backup-configurations',
          'backup-configuration-relations',
          'custom-fields',
          'custom-field-values',
        ],
        targetConfig: { sourceEndpoint: '/device-relationships' },
      },
    ]);
  });

  it('recommends deterministic site/device destinations without status or last-seen fields', () => {
    const recommendations = new BreezeDriver().recommendedDestinations;
    expect(recommendations?.sites?.layout.slug).toBe('breeze-sites');
    expect(recommendations?.devices?.layout.slug).toBe('breeze-devices');
    expect(recommendations?.['device-inventory']?.layout.slug).toBe('breeze-devices');
    const serialized = JSON.stringify(recommendations).toLowerCase();
    expect(serialized).not.toMatch(
      /live.?status|last.?seen|heartbeat|uptime|alert|vulnerab|patch|metric|session|command/,
    );
    expect(recommendations?.devices?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'breeze-id' }),
        expect.objectContaining({ slug: 'hostname' }),
        expect.objectContaining({ slug: 'warranty-ends-on', options: { isExpiry: true } }),
        expect.objectContaining({ slug: 'installed-software' }),
      ]),
    );
    expect(recommendations?.['device-inventory']?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'warranty-subscription', fieldType: 'BOOLEAN' }),
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
        expect.objectContaining({ slug: 'rct-enabled', fieldType: 'BOOLEAN' }),
        expect.objectContaining({ slug: 'passthrough-disks', fieldType: 'BOOLEAN' }),
      ]),
    );
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
      exclusions: ['/var/cache'], restore: { types: ['full', 'selective', 'bare_metal'], notes: null },
    });
    expect(backup.markdown).toContain('Provider: s3');
    expect(backup.markdown).toContain('bare_metal');
    expect(JSON.stringify(backup)).not.toMatch(/providerConfig|encryptionKey|restoreJobs/);

    const profile = article('backup-configurations', {
      ...base, id: SEGMENT, siteId: null, kind: 'profile', sourceScope: 'partner', name: 'File profile',
      description: 'Selected files', active: true, selections: { paths: ['/srv/data'] },
      destinationId: destinationId, schedule: null, retention: null, exclusions: ['*.tmp'],
      restore: { types: ['selective'], notes: 'Choose the required paths.' },
    });
    expect(profile.markdown).toContain('## Selections');
    expect(profile.markdown).toContain('Choose the required paths.');
    const policyBackupId = 'abababab-abab-4bab-8bab-abababababab';
    const policyBackup = article('backup-configurations', {
      ...base, id: policyBackupId, siteId: null, kind: 'policy', sourceScope: 'organization',
      name: 'Server backup', enabled: true, destinationId, targets: { roles: ['server'] },
      schedule: { cron: '0 1 * * *' }, retention: { daily: 14 }, exclusions: [],
      restore: { types: ['full'], notes: null }, gfs: { monthly: 12 }, legalHold: true,
      legalHoldReason: 'Case 42', bandwidthLimitMbps: 100, backupWindowStart: '01:00',
      backupWindowEnd: '05:00', priority: 5,
    });
    expect(policyBackup.markdown).toContain('Legal hold: yes');
    expect(policyBackup.markdown).toContain('## Targets');
    const backupRelations = transformBreezeRecord('backup-configuration-relations', {
      ...base, id: policyBackupId, siteId: null, kind: 'policy', sourceScope: 'organization',
      name: 'Server backup', enabled: true, destinationId, targets: { roles: ['server'] },
      schedule: null, retention: null, exclusions: [], restore: { types: ['full'], notes: null },
      gfs: null, legalHold: false, legalHoldReason: null, bandwidthLimitMbps: null,
      backupWindowStart: null, backupWindowEnd: null, priority: null,
    }) as Array<{ reconstructionInput: Record<string, any> }>;
    expect(backupRelations[0]!.reconstructionInput).toMatchObject({
      relationType: 'backup_destination',
      targetRef: { resourceKey: 'backup-configurations', externalId: `${ORG}:backup-configurations:${destinationId}` },
    });

    for (const rendered of [policy, assignment, script, automation, backup]) {
      expect(rendered.slug.length).toBeLessThanOrEqual(80);
      expect(rendered.markdown.length).toBeLessThanOrEqual(1_000_000);
    }
  });

  it('strictly rejects unreviewed desired-configuration keys and malicious inline secrets', () => {
    const safeScript = {
      ...base, siteId: null, sourceScope: 'organization', name: 'Install', description: null,
      category: null, osTypes: ['linux'], language: 'bash', content: 'true', parameters: null,
      timeoutSeconds: 30, runAs: 'system', version: 1, exitCodeSeverityMapping: null,
    };
    expect(() => transformBreezeRecord('scripts', { ...safeScript, providerConfig: {} })).toThrow();
    expect(() => transformBreezeRecord('scripts', { ...safeScript, content: 'export TOKEN=hunter2' }))
      .toThrow(/blocked|secret|sensitive/i);
    const policy = (settings: Record<string, unknown>) => ({
      ...base, siteId: null, sourceScope: 'organization', name: 'Safe policy', description: null,
      status: 'active', features: [{ id: SEGMENT, type: 'settings', policyId: null, settings }],
    });
    expect(() => transformBreezeRecord('configuration-policies', policy({
      tokenize: true, secretary: 'Alice', policyEnabled: true,
    }))).not.toThrow();
    expect(() => transformBreezeRecord('configuration-policies', policy({ passwordPolicyEnabled: true })))
      .toThrow(/blocked|secret|sensitive/i);
    expect(() => transformBreezeRecord('configuration-policies', policy({ providerConfig: {} })))
      .toThrow(/blocked|secret|sensitive/i);
    expect(() => transformBreezeRecord('configuration-policies', policy({ nested: { accessToken: 'ordinary' } })))
      .toThrow(/blocked|secret|sensitive/i);
    const highEntropy = 'JBSWY3DPEHPK3PXP'.repeat(3);
    expect(() => transformBreezeRecord('configuration-policies', policy({ value: highEntropy })))
      .toThrow(/blocked|secret|sensitive/i);
  });

  it.each([
    'password=hunter2',
    'set "PASSWORD=hunter2"',
    'setx /M DB_PASSWORD hunter2',
    'tool --password hunter2 --mode rebuild',
    "tool --mode rebuild --access-token 'ordinary-value'",
    '{"password":"hunter2"}',
    '{"user":"admin","password":"hunter2","mode":"rebuild"}',
    'RECOVERY_KEY=1234-5678-9012',
    'BitLockerRecoveryKey: "1234-5678-9012"',
    'PASSWORD_VALUE=hunter2',
    'TOKEN_BACKUP=ordinary-value',
    'tool "PASSWORD=hunter2"',
    'postgresql://operator:hunter2@database.example/rebuild',
    "$Password = 'Summer2026!'",
    "ConvertTo-SecureString -AsPlainText -Force 'Summer2026!'",
  ])('blocks adjacent low-entropy credential syntax without leaking it: %s', (content) => {
    const input = {
      ...base, siteId: null, sourceScope: 'organization', name: 'Unsafe rebuild', description: null,
      category: 'build', osTypes: ['windows'], language: 'powershell', content, parameters: null,
      timeoutSeconds: 300, runAs: 'system', version: 1, exitCodeSeverityMapping: null,
    };
    expect(() => transformBreezeRecord('scripts', input)).toThrow(/blocked|secret|sensitive/i);
  });

  it.each([
    'tool --password-policy enabled --mode rebuild',
    'echo secretary tokenize ordinary prose',
    'postgresql://database.example/rebuild',
  ])('allows nearby benign reconstruction script text: %s', (content) => {
    expect(() => transformBreezeRecord('scripts', {
      ...base, siteId: null, sourceScope: 'organization', name: 'Safe rebuild', description: null,
      category: 'build', osTypes: ['linux'], language: 'bash', content, parameters: null,
      timeoutSeconds: 300, runAs: 'system', version: 1, exitCodeSeverityMapping: null,
    })).not.toThrow();
  });

  it('does not apply content-only identifier quarantine to ordinary descriptive fields', () => {
    expect(() => transformBreezeRecord('scripts', {
      ...base, siteId: null, sourceScope: 'organization', name: 'Credential policy documentation',
      description: 'Usage documentation mentions tool --password without carrying a value.',
      category: 'documentation', osTypes: ['linux'], language: 'bash', content: 'echo safe',
      parameters: null, timeoutSeconds: 300, runAs: 'system', version: 1,
      exitCodeSeverityMapping: null,
    })).not.toThrow();
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
      bindingRef: { resourceKey: 'devices', externalId: `${ORG}:devices:${DEVICE}` },
      fields: expect.objectContaining({ definitionId, deviceId: DEVICE }),
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
    expect(automation!.reconstructionInput.markdown.length).toBeLessThanOrEqual(500_000);

    const features = Array.from({ length: 500 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      type: 'feature', policyId: null, settings: { enabled: true, index },
    }));
    const [policy] = transformBreezeRecord('configuration-policies', {
      ...base, siteId: null, sourceScope: 'organization', name: 'Maximum policy', description: null,
      status: 'active', features,
    }) as Array<{ reconstructionInput: Record<string, any> }>;
    expect(policy!.reconstructionInput.markdown).toContain(features[499]!.id);
    expect(policy!.reconstructionInput.markdown.length).toBeLessThanOrEqual(500_000);

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
    const projected = (valid as unknown as { fields: { value: string[] } }).fields.value;
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
        disks: expect.stringContaining(DISK),
        interfaces: expect.stringContaining('00:11:22:33:44:55'),
        networkAddresses: expect.stringContaining('10.20.0.99'),
        gateways: expect.stringContaining('10.20.0.1'),
        dnsServers: expect.stringContaining('1.1.1.1'),
        warrantyStatus: 'active',
        warrantyEndsOn: '2028-01-01',
        virtualMachines: expect.stringContaining(VM),
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
        installedSoftware: expect.stringContaining(SOFTWARE),
        softwareCompleteness: 'software: 1/1 complete',
      }),
    });

    const renamed = transformBreezeRecord('device-software', {
      ...softwareRecord,
      software: [{ ...softwareRecord.software[0], name: 'Renamed Agent' }],
    });
    expect(renamed[0]).toMatchObject({ externalId: DEVICE });
    expect(JSON.stringify(renamed[0])).toContain(SOFTWARE);
  });

  it('maps site inventory, canonical subnets, and only eligible current static reservations', () => {
    const [site] = transformBreezeRecord('site-inventory', siteInventory);
    expect(site).toMatchObject({
      externalId: SITE,
      fields: expect.objectContaining({
        breezeId: SITE,
        networkEquipment: expect.stringContaining(EQUIPMENT),
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

  it('fails closed on same-record same-CIDR gateway conflicts independent of address order', () => {
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

    expect(() =>
      transformBreezeRecord(
        'subnets',
        makeInput([deviceInventory.addresses[0]!, conflicting]),
      ),
    ).toThrow(/gateway|conflict|duplicate/i);
    expect(() =>
      transformBreezeRecord(
        'subnets',
        makeInput([conflicting, deviceInventory.addresses[0]!]),
      ),
    ).toThrow(/gateway|conflict|duplicate/i);
  });

  it.each(['not-an-ip', '10.30.0.1'])(
    'fails closed on a malformed or out-of-subnet static gateway: %s',
    (gateway) => {
      expect(() =>
        transformBreezeRecord('subnets', {
          ...deviceInventory,
          addresses: [{ ...deviceInventory.addresses[0], gateway }],
          collections: {
            ...deviceInventory.collections,
            addresses: completeCollection,
          },
        }),
      ).toThrow(/gateway/i);
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
    expect(informational.toLowerCase()).toContain('assignment');
    expect(transformBreezeRecord('ip-reservations', input)).toHaveLength(1);

    expect(() =>
      transformBreezeRecord('device-inventory', {
        ...deviceInventory,
        openPorts: [22, 3389],
      }),
    ).toThrow();
    expect(() =>
      transformBreezeRecord('network-equipment', {
        ...siteInventory,
        networkEquipment: [{ ...siteInventory.networkEquipment[0], type: 'client' }],
      }),
    ).toThrow();
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

    expect(() =>
      transformBreezeRecord('device-relationships', {
        ...relationships,
        edges: [
          {
            key: 'invented-edge',
            type: 'configuration_assignment',
            from: { type: 'device', id: DEVICE },
            to: { type: 'device', id: DEVICE },
            metadata: {},
          },
        ],
        collection: completeCollection,
      }),
    ).toThrow();
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
      { ...base, siteId: null, kind: 'profile', sourceScope: 'organization', name: 'Backup', description: null, active: true, selections: {}, destinationId: null, schedule: null, retention: null, exclusions: [], restore: { types: [], notes: null } },
    ],
    ['backup-configuration-relations', { ...base, siteId: null, kind: 'profile', sourceScope: 'organization', name: 'Backup', description: null, active: true, selections: {}, destinationId: null, schedule: null, retention: null, exclusions: [], restore: { types: [], notes: null } }],
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
      name: `Package ${index}`,
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
  it.each([
    'Usage: tool --password',
    '{"password":""}',
    'set PASSWORD=',
    'TODO rotate DB_PASSWORD later',
    'Help: provide credential before running',
    'ConvertTo-SecureString hunter2 -AsPlainText -Force',
    'ConvertTo-SecureString -String hunter2 -AsPlainText -Force',
  ])('quarantines credential-semantic script syntax, continues a safe sibling, and leaks nothing: %s', async (content) => {
    const unsafeName = 'Unsafe syntax sentinel';
    const unsafe = {
      ...base, siteId: null, sourceScope: 'organization', name: unsafeName, description: null,
      category: null, osTypes: ['windows'], language: 'powershell', content, parameters: null,
      timeoutSeconds: 30, runAs: 'system', version: 1, exitCodeSeverityMapping: null,
    };
    const safe = { ...unsafe, id: SEGMENT, name: 'Safe sibling', content: 'tool --password-policy enabled' };
    const client = {
      testConnection: jest.fn(), listOrganizations: jest.fn(),
      fetchPage: jest.fn().mockResolvedValue({
        schemaVersion: '1', snapshotAt: '2026-07-14T12:00:00.000Z', data: [unsafe, safe],
        nextCursor: null, hasMore: false,
      }),
    };
    const page = await new BreezeDriver(client).fetchRecords(
      { ...ctx('scripts'), mode: 'full', updatedSince: null }, null,
    );
    expect(page.records).toHaveLength(1);
    expect(page.blockedInputs).toEqual([expect.objectContaining({
      kind: 'secret_blocked', externalId: `${ORG}:scripts:${DEVICE}`,
      details: expect.objectContaining({ reasonCode: 'secret_detected', sourceId: DEVICE }),
    })]);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain(content);
    expect(serialized).not.toContain(unsafeName);
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

  it('converts a malicious inline definition to a safe blocked input and continues safe records', async () => {
    const secret = 'JBSWY3DPEHPK3PXP'.repeat(3);
    const unsafe = {
      ...base, siteId: null, sourceScope: 'organization', name: 'Unsafe', description: null,
      category: null, osTypes: ['linux'], language: 'bash', content: `echo ${secret}`,
      parameters: null, timeoutSeconds: 30, runAs: 'system', version: 1,
      exitCodeSeverityMapping: null,
    };
    const safe = { ...unsafe, id: SEGMENT, name: 'Safe', content: 'true' };
    const client = {
      testConnection: jest.fn(), listOrganizations: jest.fn(),
      fetchPage: jest.fn().mockResolvedValue({
        schemaVersion: '1', snapshotAt: '2026-07-14T12:00:00.000Z', data: [unsafe, safe],
        nextCursor: null, hasMore: false,
      }),
    };
    const page = await new BreezeDriver(client).fetchRecords(
      { ...ctx('scripts'), mode: 'full', updatedSince: null }, null,
    );
    expect(page.records).toHaveLength(1);
    expect(page.blockedInputs).toEqual([expect.objectContaining({
      kind: 'secret_blocked', externalId: `${ORG}:scripts:${DEVICE}`,
      details: expect.objectContaining({ reasonCode: 'secret_detected', sourceId: DEVICE }),
    })]);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('echo JBSWY');
    expect(serialized).not.toContain('Unsafe');
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

  it('fails closed when duplicate stable native identities carry conflicting facts', async () => {
    const client = {
      testConnection: jest.fn(),
      listOrganizations: jest.fn(),
      fetchPage: jest.fn().mockResolvedValue({
        schemaVersion: '1',
        snapshotAt: '2026-07-14T12:00:00.000Z',
        data: [
          deviceInventory,
          {
            ...deviceInventory,
            addresses: deviceInventory.addresses.map((address, index) =>
              index === 0 ? { ...address, gateway: '10.20.0.3' } : address,
            ),
          },
        ],
        nextCursor: null,
        hasMore: false,
      }),
    };

    await expect(new BreezeDriver(client).fetchRecords(ctx('subnets'), null)).rejects.toThrow(
      /duplicate.*identity/i,
    );
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
    });
    expect(page).toMatchObject({
      schemaVersion: '1',
      snapshotAt: '2026-07-14T12:00:00.000Z',
      hasMore: false,
      cursor: null,
      terminal: true,
      sourceHighWater: UPDATED,
      blockedInputs: [
        {
          kind: 'secret_blocked',
          externalId: `${ORG}:devices:${DEVICE}`,
          message: 'Breeze withheld a record because secret material was detected.',
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
  ])('rejects $name before emitting records', async ({ updatedSince, data }) => {
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
    await expect(
      new BreezeDriver(client).fetchRecords({ ...ctx(), updatedSince }, null),
    ).rejects.toThrow(/sourceUpdatedAt|incremental|order|snapshot/i);
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

  it('emits per-page incremental high-water without retaining failed traversal state', async () => {
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
      sourceHighWater: '2026-07-14T11:30:00.000Z',
    });
    await expect(
      driver.fetchRecords({ ...ctx(), snapshotAt: '2026-07-14T12:00:00.000Z' }, 'cursor-1'),
    ).rejects.toThrow('failed page');
    await expect(driver.fetchRecords(ctx(), null)).resolves.toMatchObject({
      sourceHighWater: UPDATED,
    });
    await expect(driver.fetchRecords({ ...ctx(), mode: 'full' }, null)).resolves.toMatchObject({
      sourceHighWater: null,
    });
  });

  it('delegates connection and organization discovery without name mapping', async () => {
    const client = {
      testConnection: jest.fn().mockResolvedValue(undefined),
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
      details: 'Reached Breeze Partner API.',
    });
    await expect(driver.listSourceOrgs(ctx() as IntegrationContext)).resolves.toEqual([
      { externalId: ORG, name: 'Acme', hint: 'customer' },
    ]);
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
        bindingRef: {
          resourceKey: 'devices',
          externalId: `${ORG}:devices:${DEVICE}`,
        },
        fields: expect.objectContaining({
          breezeId: valueId,
          orgId: ORG,
          deviceId: DEVICE,
          definitionId,
          target: { type: 'device', id: DEVICE },
          value: 'DC1-R07',
        }),
      }),
    ]);
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

  it('fails closed on unknown scalar keys and blocks secret-semantic scalar values safely', async () => {
    expect(() =>
      transformBreezeRecord('custom-field-values', {
        ...scalarValue,
        providerConfig: { accessToken: 'must-never-enter-weavestream' },
      }),
    ).toThrow();
    expect(() =>
      transformBreezeRecord('custom-field-values', {
        ...scalarValue,
        target: { type: 'device', id: SITE },
      }),
    ).toThrow(/target|device/i);

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
    expect(page.records).toEqual([]);
    expect(page.blockedInputs).toEqual([
      expect.objectContaining({
        kind: 'secret_blocked',
        externalId: `${ORG}:custom-field-values:${valueId}`,
      }),
    ]);
    expect(JSON.stringify(page)).not.toContain(secret);
  });
});
