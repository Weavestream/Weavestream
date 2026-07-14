import type { FetchRecordsContext, IntegrationContext } from '../integration-driver.js';
import { driverDescriptorSchema } from '@weavestream/shared';
import { BreezeDriver } from './breeze.driver.js';
import { transformBreezeRecord } from './breeze.transforms.js';

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
        key: 'custom-fields',
        targetKind: 'asset',
        dependsOnResourceKeys: ['devices'],
        targetConfig: { sourceEndpoint: '/custom-fields', bindingResourceKey: 'devices' },
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
          'scripts',
          'automations',
          'backup-configurations',
          'custom-fields',
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
      externalId: `${ORG}:subnets:cidr:10.20.0.0/24`,
    });
    expect(derivedSubnet!.reconstructionInput).toMatchObject({
      targetKind: 'subnet',
      cidr: '10.20.0.0/24',
      externalId: siteSubnet!.reconstructionInput.externalId,
    });

    const reservations = transformBreezeRecord('ip-reservations', deviceInventory) as Array<{
      reconstructionInput: Record<string, unknown>;
    }>;
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.reconstructionInput).toMatchObject({
      targetKind: 'ip_reservation',
      ipAddress: '10.20.0.50',
      externalId: `${ORG}:ip-reservations:10.20.0.0/24:10.20.0.50`,
      subnetRef: {
        resourceKey: 'subnets',
        externalId: `${ORG}:subnets:cidr:10.20.0.0/24`,
      },
    });
    expect(JSON.stringify(reservations)).not.toContain('10.20.0.99');
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
      { ...base, name: 'Policy', description: null, content: 'Desired state' },
    ],
    ['scripts', { ...base, name: 'Install', description: null, content: 'Install safely' }],
    [
      'automations',
      { ...base, name: 'Onboard', description: null, content: 'Run install', scriptIds: [] },
    ],
    [
      'backup-configurations',
      { ...base, name: 'Backup', description: null, content: 'Nightly backup' },
    ],
    [
      'custom-fields',
      { ...base, deviceId: DEVICE, fields: [{ key: 'owner', label: 'Owner', value: 'IT' }] },
    ],
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
    expect(installedSoftware.length).toBeLessThanOrEqual(32_000);
    expect(installedSoftware).toContain('[structured output truncated');
  });
});

describe('BreezeDriver transport delegation', () => {
  it('deduplicates canonical native identities emitted by multiple source rows in one page', async () => {
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
      reconstructionInput: { externalId: `${ORG}:subnets:cidr:10.20.0.0/24` },
    });
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
