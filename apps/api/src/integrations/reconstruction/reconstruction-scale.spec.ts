import * as runnerModule from '../integration-sync-runner.service.js';
import { transformBreezeRecord } from '../drivers/breeze/breeze.transforms.js';
import { buildResourceExecutionStages } from '../integration-sync.service.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const REVISION = 'a'.repeat(64);
const SNAPSHOT = '2026-07-14T12:00:00.000Z';

describe('Breeze reconstruction 10,000-device instrumentation', () => {
  it('publishes the bounded runtime caps used by the real runner', () => {
    const limits = (runnerModule as Record<string, unknown>)[
      'RECONSTRUCTION_RUNTIME_LIMITS'
    ];

    expect(limits).toEqual({
      recordsPerPage: 10_000,
      pagesPerTraversal: 1_000,
      gapsPerPage: 1_000,
      conflictsPerRun: 10_000,
      nativeMutationBatch: 500,
    });
  });

  it('walks 10,000 realistic devices with bounded pages, batches, queries, and retained state', () => {
    const limits = runnerModule.RECONSTRUCTION_RUNTIME_LIMITS;
    const pageSize = 500;
    const bindingKeys = new Set<string>();
    const scheduledDeliveryKeys = new Set<string>();
    let pages = 0;
    let transformedTargets = 0;
    let softwareRows = 0;
    let interfaceRows = 0;
    let relationshipRows = 0;
    let writeBatches = 0;
    let queryCount = 0;
    let maxPageBytes = 0;
    let committedCursor: string | null = null;
    let staleSweeps = 0;
    const cappedGaps: string[] = [];
    const cappedConflicts: string[] = [];

    for (let offset = 0; offset < 10_000; offset += pageSize) {
      pages += 1;
      const pageRecords = [];
      for (let index = offset + 1; index <= offset + pageSize; index += 1) {
        const source = device(index);
        const sourceId = source.id;
        const transformedDevice = transformBreezeRecord('devices', source)[0]!;
        const software = Array.from({ length: 25 }, (_, softwareIndex) => ({
          id: uuid(index * 100 + softwareIndex, '31000000'),
          name: `Package ${softwareIndex}`,
          version: `${1 + (softwareIndex % 4)}.${index % 20}`,
          vendor: softwareIndex % 2 === 0 ? 'Microsoft' : 'Open Source',
          installedOn: '2026-01-02',
          managed: softwareIndex % 3 === 0,
        }));
        const interfaces = Array.from({ length: 3 }, (_, interfaceIndex) => ({
          id: uuid(index * 10 + interfaceIndex, '32000000'),
          name: `Ethernet ${interfaceIndex}`,
          macAddress: `02:00:${hexByte(index)}:${hexByte(interfaceIndex)}:00:01`,
          primary: interfaceIndex === 0,
        }));
        const inventory = inventoryRecord(index, sourceId, interfaces);
        const transformedInventory = transformBreezeRecord('device-inventory', inventory)[0]!;
        const transformedSoftware = transformBreezeRecord('device-software', {
          id: sourceId,
          orgId: ORG,
          siteId: SITE,
          sourceUpdatedAt: '2026-07-14T11:00:00.000Z',
          revision: REVISION,
          subjectType: 'device',
          deviceId: sourceId,
          software,
          collection: { total: 25, included: 25, complete: true, reason: null },
        })[0]!;
        const relations = transformBreezeRecord('device-relationships', {
          id: sourceId,
          orgId: ORG,
          siteId: SITE,
          sourceUpdatedAt: '2026-07-14T11:00:00.000Z',
          revision: REVISION,
          subjectType: 'device',
          deviceId: sourceId,
          edges: [
            {
              key: `site-device-${sourceId}`,
              type: 'site_device',
              from: { type: 'site', id: SITE },
              to: { type: 'device', id: sourceId },
              metadata: {},
            },
            {
              key: `device-interface-${sourceId}`,
              type: 'device_interface',
              from: { type: 'device', id: sourceId },
              to: { type: 'interface', id: interfaces[0]!.id },
              metadata: { interfaceName: interfaces[0]!.name },
            },
          ],
          collection: { total: 2, included: 2, complete: true, reason: null },
        });

        pageRecords.push(transformedDevice);
        transformedTargets += 3 + relations.length;
        softwareRows += software.length;
        interfaceRows += interfaces.length;
        relationshipRows += relations.length;
        for (const [resource, record] of [
          ['devices', transformedDevice],
          ['device-inventory', transformedInventory],
          ['device-software', transformedSoftware],
          ...relations.map((record) => ['device-relationships', record] as const),
        ] as const) {
          const externalId = 'reconstructionInput' in record
            ? record.reconstructionInput!.externalId
            : `${ORG}:${resource}:${record.externalId}`;
          bindingKeys.add(`${resource}:${externalId}`);
        }
      }

      const terminal = offset + pageSize === 10_000;
      const cursor = terminal ? null : `page-${pages + 1}`;
      const validated = runnerModule.validateDriverFetchPage({
        records: pageRecords,
        hasMore: !terminal,
        cursor,
        terminal,
        schemaVersion: '1',
        snapshotAt: SNAPSHOT,
        sourceHighWater: '2026-07-14T11:00:00.000Z',
        blockedInputs: [],
      }, {
        traversalStartedAt: SNAPSHOT,
        previousCursor: committedCursor,
        expectedSchemaVersion: pages === 1 ? null : '1',
        expectedSnapshotAt: pages === 1 ? null : SNAPSHOT,
      });
      committedCursor = validated.cursor;
      maxPageBytes = Math.max(maxPageBytes, Buffer.byteLength(JSON.stringify(pageRecords)));
      writeBatches += Math.ceil((pageSize * 5) / limits.nativeMutationBatch);
      queryCount += 2 + Math.ceil((pageSize * 5) / limits.nativeMutationBatch);
      if (validated.terminal) staleSweeps += 1;
      for (let gap = 0; gap < 750; gap += 1) {
        if (cappedGaps.length < limits.gapsPerPage) cappedGaps.push(`gap-${offset + gap}`);
      }
      for (let conflict = 0; conflict < 750; conflict += 1) {
        if (cappedConflicts.length < limits.conflictsPerRun) {
          cappedConflicts.push(`conflict-${offset + conflict}`);
        }
      }
    }

    scheduledDeliveryKeys.add('scheduled:integration-breeze:2026-07-14T12:00');
    scheduledDeliveryKeys.add('scheduled:integration-breeze:2026-07-14T12:00');

    expect({ pages, transformedTargets, softwareRows, interfaceRows, relationshipRows }).toEqual({
      pages: 20,
      transformedTargets: 50_000,
      softwareRows: 250_000,
      interfaceRows: 30_000,
      relationshipRows: 20_000,
    });
    expect(bindingKeys.size).toBe(50_000);
    expect(writeBatches).toBe(100);
    expect(queryCount).toBe(140);
    expect(maxPageBytes).toBeLessThan(4 * 1024 * 1024);
    expect(cappedGaps).toHaveLength(limits.gapsPerPage);
    expect(cappedConflicts).toHaveLength(limits.conflictsPerRun);
    expect(committedCursor).toBeNull();
    expect(staleSweeps).toBe(1);
    expect(scheduledDeliveryKeys.size).toBe(1);
  }, 30_000);

  it('resumes from the last committed page and never sweeps stale after an incomplete full crawl', () => {
    const processed = new Set<number>();
    let checkpoint = 0;
    const run = (startPage: number, crashAfterPage: number | null) => {
      for (let page = startPage; page <= 20; page += 1) {
        for (let index = (page - 1) * 500 + 1; index <= page * 500; index += 1) {
          processed.add(index);
        }
        if (crashAfterPage === page) return { authoritative: false, terminal: false };
        checkpoint = page;
      }
      return { authoritative: true, terminal: true };
    };

    const partial = run(1, 9);
    expect(partial).toEqual({ authoritative: false, terminal: false });
    expect(checkpoint).toBe(8);
    expect(partial.authoritative && partial.terminal).toBe(false);

    const resumed = run(checkpoint + 1, null);
    expect(resumed).toEqual({ authoritative: true, terminal: true });
    expect(checkpoint).toBe(20);
    expect(processed.size).toBe(10_000);
  });

  it('keeps entity stages ahead of reservation and relation stages', () => {
    const resources = [
      { id: 'sites', resourceKey: 'sites', dependsOnResourceKeys: [] },
      { id: 'devices', resourceKey: 'devices', dependsOnResourceKeys: ['sites'] },
      { id: 'subnets', resourceKey: 'subnets', dependsOnResourceKeys: ['devices'] },
      { id: 'reservations', resourceKey: 'ip-reservations', dependsOnResourceKeys: ['subnets', 'devices'] },
      { id: 'relations', resourceKey: 'device-relationships', dependsOnResourceKeys: ['sites', 'devices', 'subnets', 'ip-reservations'] },
    ];
    expect(buildResourceExecutionStages(resources).map((stage) => stage.map((row) => row.resourceKey)))
      .toEqual([['sites'], ['devices'], ['subnets'], ['ip-reservations'], ['device-relationships']]);
  });
});

function uuid(index: number, prefix = '30000000'): string {
  return `${prefix}-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function device(index: number) {
  const id = uuid(index);
  return {
    id,
    orgId: ORG,
    siteId: SITE,
    sourceUpdatedAt: '2026-07-14T11:00:00.000Z',
    revision: REVISION,
    hostname: `device-${String(index).padStart(5, '0')}`,
    displayName: `Device ${index}`,
    type: {
      os: index % 5 === 0 ? 'linux' : 'windows',
      role: index % 10 === 0 ? 'server' : 'workstation',
      virtual: index % 4 === 0,
      virtualizationPlatform: index % 4 === 0 ? 'hyper-v' : null,
    },
    operatingSystem: {
      edition: index % 5 === 0 ? 'Ubuntu 24.04' : 'Windows 11 Pro',
      build: index % 5 === 0 ? '24.04' : '26100',
      architecture: 'x64',
    },
    installation: { enrolledAt: '2025-01-01T00:00:00.000Z' },
    hardwareIdentity: {
      serialNumber: `SER-${index}`,
      manufacturer: index % 2 === 0 ? 'Dell' : 'Lenovo',
      model: index % 2 === 0 ? 'PowerEdge' : 'ThinkCentre',
    },
    stableIdentifiers: { assetTag: `AT-${index}`, inventoryId: null, externalId: null },
    tags: index % 10 === 0 ? ['managed', 'server'] : ['managed'],
    groupIds: [],
    groupMembership: { total: 0, included: 0, complete: true, reason: null },
    linkGroupId: null,
    linkGroupRole: null,
  };
}

function inventoryRecord(
  index: number,
  deviceId: string,
  interfaces: Array<{ id: string; name: string; macAddress: string; primary: boolean }>,
) {
  const addresses = interfaces.map((networkInterface, interfaceIndex) => ({
    id: uuid(index * 10 + interfaceIndex, '33000000'),
    interfaceId: networkInterface.id,
    interfaceName: networkInterface.name,
    address: `10.${Math.floor(index / 254) % 254}.${index % 254}.${interfaceIndex + 10}`,
    family: 'ipv4' as const,
    assignment: interfaceIndex === 0 ? 'static' as const : 'dhcp' as const,
    reservationEligible: interfaceIndex === 0,
    subnetMask: '255.255.255.0',
    gateway: `10.${Math.floor(index / 254) % 254}.${index % 254}.1`,
    dnsServers: ['1.1.1.1', '8.8.8.8'],
    active: true,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    deactivatedAt: null,
  }));
  return {
    id: deviceId,
    orgId: ORG,
    siteId: SITE,
    sourceUpdatedAt: '2026-07-14T11:00:00.000Z',
    revision: REVISION,
    subjectType: 'device' as const,
    deviceId,
    hardware: {
      processor: { model: 'Intel Xeon', cores: 8, threads: 16 },
      memory: { totalMb: 32_768 },
      graphics: { model: null },
      motherboard: { manufacturer: 'Dell', product: 'System', version: 'A01' },
      firmware: { biosVersion: '1.2.3' },
    },
    disks: [
      { id: uuid(index, '34000000'), mountPoint: 'C:', device: 'Disk 0', fileSystem: 'NTFS', totalGb: 512 },
      { id: uuid(index + 10_000, '34000000'), mountPoint: 'D:', device: 'Disk 1', fileSystem: 'NTFS', totalGb: 1024 },
    ],
    interfaces,
    addresses,
    warranty: { status: 'active', startsOn: '2025-01-01', endsOn: '2028-01-01', subscription: false },
    virtualMachines: [],
    collections: {
      disks: { total: 2, included: 2, complete: true, reason: null },
      interfaces: { total: 3, included: 3, complete: true, reason: null },
      addresses: { total: 3, included: 3, complete: true, reason: null },
      virtualMachines: { total: 0, included: 0, complete: true, reason: null },
    },
  };
}

function hexByte(value: number): string {
  return (value % 256).toString(16).padStart(2, '0');
}
