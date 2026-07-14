import type { FetchRecordsContext, IntegrationContext } from '../integration-driver.js';
import { driverDescriptorSchema } from '@weavestream/shared';
import { BreezeDriver } from './breeze.driver.js';
import { transformBreezeRecord } from './breeze.transforms.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const REVISION = 'a'.repeat(64);
const UPDATED = '2026-07-14T11:00:00.000Z';

const base = { id: DEVICE, orgId: ORG, siteId: SITE, sourceUpdatedAt: UPDATED, revision: REVISION };
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
    updatedSince: UPDATED,
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
        key: 'subnets',
        targetKind: 'subnet',
        dependsOnResourceKeys: ['devices'],
        targetConfig: { sourceEndpoint: '/device-inventory', normalization: 'cidr' },
      },
      {
        key: 'ip-reservations',
        targetKind: 'ip_reservation',
        dependsOnResourceKeys: ['subnets', 'devices'],
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
          'device-inventory',
          'device-software',
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
      /status|last.?seen|heartbeat|uptime|alert|vulnerab|patch|metric|session|command/,
    );
    expect(recommendations?.devices?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'breeze-id' }),
        expect.objectContaining({ slug: 'hostname' }),
        expect.objectContaining({ slug: 'warranty-expiry', options: { isExpiry: true } }),
        expect.objectContaining({ slug: 'support-expiry', options: { isExpiry: true } }),
        expect.objectContaining({ slug: 'installed-software' }),
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
      fields: expect.objectContaining({ hostname: 'ws-01', breezeId: DEVICE }),
    });
    const serialized = JSON.stringify(record).toLowerCase();
    expect(serialized).not.toContain('\\u0000');
    expect(serialized).not.toMatch(
      /status|lastseen|heartbeat|uptime|alert|vulnerab|patch|metric|session|command/,
    );
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
    [
      'device-inventory',
      {
        ...base,
        deviceId: DEVICE,
        cpu: [],
        memoryBytes: 1024,
        firmware: [],
        disks: [],
        interfaces: [],
        subnets: [],
        reservations: [],
        warrantyExpiry: null,
        supportExpiry: null,
      },
    ],
    ['device-software', { ...base, deviceId: DEVICE, software: [] }],
    [
      'subnets',
      {
        ...base,
        deviceId: DEVICE,
        cpu: [],
        memoryBytes: null,
        firmware: [],
        disks: [],
        interfaces: [],
        subnets: [
          {
            id: 'lan',
            name: 'LAN',
            cidr: '192.0.2.0/24',
            vlanId: 10,
            gateway: '192.0.2.1',
            dhcpRangeStart: null,
            dhcpRangeEnd: null,
            description: null,
          },
        ],
        reservations: [],
        warrantyExpiry: null,
        supportExpiry: null,
      },
    ],
    [
      'ip-reservations',
      {
        ...base,
        deviceId: DEVICE,
        cpu: [],
        memoryBytes: null,
        firmware: [],
        disks: [],
        interfaces: [],
        subnets: [],
        reservations: [
          {
            id: 'printer',
            subnetId: 'lan',
            ipAddress: '192.0.2.20',
            label: 'Printer',
            notes: null,
          },
        ],
        warrantyExpiry: null,
        supportExpiry: null,
      },
    ],
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
        relationships: [
          {
            id: 'site-device',
            sourceResourceKey: 'sites',
            sourceId: SITE,
            targetResourceKey: 'devices',
            targetId: DEVICE,
            type: 'contains',
          },
        ],
      },
    ],
  ] as const)('has a fail-closed transform for %s', (resource, input) => {
    expect(() => transformBreezeRecord(resource, input)).not.toThrow();
  });

  it('fails closed on unknown resources', () => {
    expect(() => transformBreezeRecord('unknown' as 'sites', device)).toThrow(/resource/i);
  });

  it('accepts the schema maximum software rows within the guarded response bound', () => {
    const software = Array.from({ length: 2_000 }, (_, index) => ({
      name: `Package ${index}`,
      version: null,
      publisher: null,
      installedAt: null,
    }));
    expect(
      transformBreezeRecord('device-software', {
        ...base,
        deviceId: DEVICE,
        software,
      }),
    ).toHaveLength(1);
  });
});

describe('BreezeDriver transport delegation', () => {
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
      updatedSince: UPDATED,
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

  it('uses only a terminal incremental page for high-water and never retains failed traversal state', async () => {
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
      sourceHighWater: null,
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
      listOrganizations: jest
        .fn()
        .mockResolvedValue([
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
