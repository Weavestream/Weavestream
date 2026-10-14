import { INTEGRATION_SECTION_LIMITS, integrationSectionSchema, type IntegrationSection } from '@weavestream/shared';
import { parseRecordSection } from '../../integration-sync-runner.service.js';
import type { Lookup } from '../section-rows.js';
import {
  LIST_PREVIEW,
  buildDeviceSection,
  byDeviceId,
  epochMs,
  type ByDevice,
  type DeviceLookups,
} from './ninjaone.sections.js';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const DAY_S = 86_400;
const nowS = NOW / 1000;

const ok = (rows: Record<string, unknown>[]): Lookup<ByDevice> => ({ ok: true, value: byDeviceId(rows) });
const missing = (reason: string): Lookup<ByDevice> => ({ ok: false, reason });

/** A full agent device, shaped like `/v2/devices-detailed`. */
function agentDevice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    deviceType: 'AgentDevice',
    nodeClass: 'WINDOWS_WORKSTATION',
    approvalStatus: 'APPROVED',
    offline: false,
    systemName: 'WS-042',
    dnsName: 'ws-042.corp.example',
    netbiosName: 'WS-042',
    lastContact: nowS - 120,
    lastLoggedInUser: 'CORP\\jdoe',
    publicIP: '203.0.113.7',
    ipAddresses: ['10.0.0.42', 'fde1::1|fe80::1'],
    macAddresses: ['AA:BB:CC:DD:EE:FF'],
    tags: ['vip', 'finance'],
    notes: [{ text: 'Docking station replaced 2026-09' }],
    maintenance: { status: 'IN_MAINTENANCE', end: nowS + 3600, reasonMessage: 'Patch window' },
    os: { name: 'Windows 11 Pro', lastBootTime: nowS - 5 * DAY_S, needsReboot: true },
    system: {
      manufacturer: 'Dell Inc.',
      model: 'Latitude 7440',
      serialNumber: 'ABC123',
      biosSerialNumber: 'ABC123',
      assetSerialNumber: 'TAG-9',
      domain: 'corp.example',
      domainRole: 'MemberWorkstation',
      chassisType: 'LAPTOP',
      virtualMachine: false,
    },
    processors: [{ name: 'Intel Core i7-1365U', numCores: 10, numLogicalCores: 12, maxClockSpeed: 1_800_000_000 }],
    volumes: [
      {
        driveLetter: 'C:',
        capacity: 512e9,
        freeSpace: 128e9,
        bitLockerStatus: { conversionStatus: 'FULLY_ENCRYPTED', protectionStatus: 'PROTECTED' },
      },
      { name: '\\\\?\\Volume{x}\\', capacity: 0, freeSpace: 0 },
    ],
    references: {
      location: { name: 'HQ' },
      policy: { name: 'Workstations - Standard' },
      warranty: { startDate: nowS - 400 * DAY_S, endDate: nowS + 30 * DAY_S },
      assignedOwner: { firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', phone: '+15551234567' },
      backupUsage: { revisionsTotalSize: 0, cloudTotalSize: 0, localTotalSize: 0 },
    },
    ...overrides,
  };
}

function fullLookups(): DeviceLookups {
  return {
    health: ok([
      {
        deviceId: 42,
        healthStatus: 'NEEDS_ATTENTION',
        pendingRebootReason: 'Windows Update',
        pendingOSPatchesCount: 3,
        failedOSPatchesCount: 1,
        pendingSoftwarePatchesCount: 0,
        failedSoftwarePatchesCount: 0,
        activeThreatsCount: 0,
        quarantinedThreatsCount: 2,
        criticalVulnerabilityCount: 0,
        highVulnerabilityCount: 4,
      },
    ]),
    alerts: ok([
      { uid: 'a1', deviceId: 42, severity: 'MAJOR', subject: 'Disk C: below 10% free', createTime: nowS - 3600 },
    ]),
    osPatches: ok([
      { deviceId: 42, name: '2026-09 Cumulative Update', kbNumber: '5030219', severity: 'CRITICAL', status: 'FAILED' },
      { deviceId: 42, name: 'Defender platform update', kbNumber: 'KB4052623', status: 'PENDING' },
      { deviceId: 42, name: 'Driver nobody wants', status: 'REJECTED' },
    ]),
    softwarePatches: ok([{ deviceId: 42, title: 'Google Chrome 130', impact: 'CRITICAL', status: 'PENDING' }]),
    antivirus: ok([{ deviceId: 42, productName: 'Microsoft Defender', productState: 'ON', definitionStatus: 'UP_TO_DATE' }]),
    networkInterfaces: ok([
      { deviceId: 42, interfaceName: 'Ethernet', ipAddress: ['10.0.0.42'], macAddress: ['AA:BB:CC:DD:EE:FF'], defaultGateway: '10.0.0.1', dnsServers: '10.0.0.2', linkSpeed: '1 Gbps', status: 'Up' },
      { deviceId: 42, interfaceName: 'Bluetooth', ipAddress: [], macAddress: ['11:22:33:44:55:66'] },
    ]),
    disks: ok([{ deviceId: 42, model: 'Samsung PM9A1', mediaType: 'SSD', interfaceType: 'NVMe', size: 512_110_190_592, status: 'OK' }]),
  };
}

function groupOf(section: IntegrationSection, key: string) {
  return section.groups.find((g) => g.key === key);
}

function rowOf(section: IntegrationSection, key: string, label: string) {
  return groupOf(section, key)?.rows.find((r) => r.label === label);
}

describe('NinjaOne section', () => {
  it('builds a schema-valid section the sync runner accepts, in the card order', () => {
    const section = buildDeviceSection({ device: agentDevice(), lookups: fullLookups(), nowMs: NOW });
    expect(integrationSectionSchema.safeParse(section).success).toBe(true);
    // The runner also scans for credential-shaped text; ordinary device data must pass.
    expect(parseRecordSection(section)).toEqual(section);
    expect(section.title).toBe('NinjaOne');
    expect(section.icon).toBe('ninjaone');
    expect(section.groups.map((g) => g.key)).toEqual([
      'status', 'storage', 'security', 'patches', 'alerts', 'network', 'warranty', 'hardware', 'tags', 'notes',
    ]);
    expect(section.groups.length).toBeLessThanOrEqual(INTEGRATION_SECTION_LIMITS.groups);
    expect(groupOf(section, 'status')?.icon).toBe('ninjaone');
  });

  it('leaves out the facts operators map to layout fields', () => {
    const json = JSON.stringify(buildDeviceSection({ device: agentDevice(), lookups: fullLookups(), nowMs: NOW }));
    for (const fact of ['Windows 11 Pro', 'Latitude 7440', 'Dell Inc.', 'ABC123']) expect(json).not.toContain(fact);
  });

  it('shows status, health, reboot and maintenance with tones', () => {
    const section = buildDeviceSection({ device: agentDevice(), lookups: fullLookups(), nowMs: NOW });
    expect(rowOf(section, 'status', 'Health')).toEqual({ kind: 'badge', label: 'Health', value: 'Needs attention', tone: 'warning' });
    expect(rowOf(section, 'status', 'Status')).toMatchObject({ value: 'Online', tone: 'success' });
    expect(rowOf(section, 'status', 'Reboot pending')).toMatchObject({ value: 'Yes', tone: 'warning' });
    expect(rowOf(section, 'status', 'Reboot reason')).toMatchObject({ value: 'Windows Update' });
    expect(rowOf(section, 'status', 'Maintenance')).toMatchObject({ value: 'In maintenance', tone: 'neutral' });
    expect(rowOf(section, 'status', 'Location')).toMatchObject({ value: 'HQ' });
    expect(rowOf(section, 'status', 'Device class')).toMatchObject({ value: 'Windows workstation' });
    // Approved is normal and is not shown.
    expect(rowOf(section, 'status', 'Approval')).toBeUndefined();
  });

  it('flags a device that is not approved, and shows an unknown health value as neutral text', () => {
    const lookups = { ...fullLookups(), health: ok([{ deviceId: 42, healthStatus: 'SOMETHING_NEW' }]) };
    const section = buildDeviceSection({ device: agentDevice({ approvalStatus: 'PENDING' }), lookups, nowMs: NOW });
    expect(rowOf(section, 'status', 'Approval')).toMatchObject({ value: 'Pending', tone: 'warning' });
    expect(rowOf(section, 'status', 'Health')).toMatchObject({ value: 'Something new', tone: 'neutral' });
  });

  it('draws one usage bar per sized volume', () => {
    const section = buildDeviceSection({ device: agentDevice(), lookups: fullLookups(), nowMs: NOW });
    expect(groupOf(section, 'storage')?.rows).toEqual([
      { kind: 'meter', label: 'C:', used: 384e9, total: 512e9, unit: 'bytes' },
    ]);
  });

  it('shows antivirus, threats, vulnerabilities and BitLocker', () => {
    const section = buildDeviceSection({ device: agentDevice(), lookups: fullLookups(), nowMs: NOW });
    expect(rowOf(section, 'security', 'Antivirus')).toMatchObject({ value: 'Microsoft Defender, On' });
    expect(rowOf(section, 'security', 'Definitions')).toMatchObject({ value: 'Up to date', tone: 'success' });
    expect(rowOf(section, 'security', 'Active threats')).toMatchObject({ value: '0', tone: 'success' });
    expect(rowOf(section, 'security', 'Quarantined threats')).toMatchObject({ value: 2 });
    expect(rowOf(section, 'security', 'Vulnerabilities')).toMatchObject({ value: '0 critical, 4 high', tone: 'warning' });
    expect(rowOf(section, 'security', 'BitLocker')).toEqual({ kind: 'list', label: 'BitLocker', value: ['C:: Fully encrypted, Protected'] });
  });

  it('never reads "not up to date" definitions as up to date', () => {
    for (const [status, tone] of [['Not up to date', 'warning'], ['OUT_OF_DATE', 'warning'], ['Current', 'success'], ['Broken', 'neutral']]) {
      const lookups = { ...fullLookups(), antivirus: ok([{ deviceId: 42, productName: 'AV', definitionStatus: status }]) };
      const section = buildDeviceSection({ device: agentDevice(), lookups, nowMs: NOW });
      expect(rowOf(section, 'security', 'Definitions')).toMatchObject({ tone });
    }
  });

  it('lists failed and pending patches, never rejected ones', () => {
    const section = buildDeviceSection({ device: agentDevice(), lookups: fullLookups(), nowMs: NOW });
    expect(rowOf(section, 'patches', 'OS patches pending')).toMatchObject({ value: '3', tone: 'warning' });
    expect(rowOf(section, 'patches', 'OS patches failed')).toMatchObject({ value: '1', tone: 'danger' });
    expect(rowOf(section, 'patches', 'Software patches pending')).toMatchObject({ value: '0', tone: 'success' });
    expect(rowOf(section, 'patches', 'Failed OS patches')).toMatchObject({ value: ['Critical: 2026-09 Cumulative Update (KB5030219)'] });
    expect(rowOf(section, 'patches', 'Pending OS patches')).toMatchObject({ value: ['Defender platform update (KB4052623)'] });
    expect(rowOf(section, 'patches', 'Pending software patches')).toMatchObject({ value: ['Google Chrome 130 (Critical)'] });
    expect(JSON.stringify(groupOf(section, 'patches'))).not.toContain('Driver nobody wants');
  });

  it('caps a long patch list and says so', () => {
    const many = Array.from({ length: LIST_PREVIEW + 5 }, (_, i) => ({ deviceId: 42, name: `Update ${i}`, status: 'PENDING' }));
    const section = buildDeviceSection({ device: agentDevice(), lookups: { ...fullLookups(), osPatches: ok(many) }, nowMs: NOW });
    const row = groupOf(section, 'patches')?.rows.find((r) => r.label.startsWith('First'));
    expect(row).toMatchObject({ label: `First ${LIST_PREVIEW} pending os patches` });
    expect(row?.kind === 'list' && row.value).toHaveLength(LIST_PREVIEW);
  });

  it('lists active alerts with the worst severity as the tone', () => {
    const section = buildDeviceSection({ device: agentDevice(), lookups: fullLookups(), nowMs: NOW });
    expect(rowOf(section, 'alerts', 'Active alerts')).toMatchObject({ value: '1', tone: 'danger' });
    expect(rowOf(section, 'alerts', 'Active')).toMatchObject({ value: ['Major: Disk C: below 10% free (since 2026-10-14 11:00 UTC)'] });
  });

  it('splits packed addresses and skips interfaces without an address', () => {
    const section = buildDeviceSection({ device: agentDevice(), lookups: fullLookups(), nowMs: NOW });
    expect(rowOf(section, 'network', 'IP addresses')).toMatchObject({ value: ['10.0.0.42', 'fde1::1', 'fe80::1'] });
    expect(rowOf(section, 'network', 'Ethernet')).toMatchObject({
      value: ['MAC AA:BB:CC:DD:EE:FF', 'IP 10.0.0.42', 'Gateway 10.0.0.1', 'DNS 10.0.0.2', 'Link 1 Gbps', 'Status Up'],
    });
    expect(rowOf(section, 'network', 'Bluetooth')).toBeUndefined();
  });

  it('shows the warranty state and only the owner name', () => {
    const section = buildDeviceSection({ device: agentDevice(), lookups: fullLookups(), nowMs: NOW });
    expect(rowOf(section, 'warranty', 'Warranty')).toMatchObject({ value: 'Ends in 30 days', tone: 'warning' });
    expect(rowOf(section, 'warranty', 'Assigned owner')).toMatchObject({ value: 'Jane Doe' });
    const json = JSON.stringify(section);
    expect(json).not.toContain('jane@example.com');
    expect(json).not.toContain('+15551234567');

    const expired = buildDeviceSection({
      device: agentDevice({ references: { warranty: { endDate: nowS - DAY_S } } }),
      lookups: {},
      nowMs: NOW,
    });
    expect(rowOf(expired, 'warranty', 'Warranty')).toMatchObject({ value: 'Expired', tone: 'danger' });
  });

  it('summarises disk health so a failing disk is visible', () => {
    const lookups = { ...fullLookups(), disks: ok([{ deviceId: 42, model: 'WD Blue', status: 'Pred Fail' }, { deviceId: 42, model: 'X', status: 'OK' }]) };
    const section = buildDeviceSection({ device: agentDevice(), lookups, nowMs: NOW });
    expect(rowOf(section, 'hardware', 'Disk status')).toMatchObject({ value: '1 not OK', tone: 'warning' });
    expect(rowOf(section, 'hardware', 'Processors')).toMatchObject({ value: ['Intel Core i7-1365U (10 cores, 12 threads, 1.80 GHz)'] });
    // Same as the serial: not repeated.
    expect(rowOf(section, 'hardware', 'BIOS serial number')).toBeUndefined();
  });

  it('turns an unavailable report into a note and keeps the rest', () => {
    const lookups: DeviceLookups = {
      ...fullLookups(),
      health: missing('your NinjaOne API client or plan does not include this data.'),
      antivirus: missing('NinjaOne did not return this data. It is retried on the next sync.'),
    };
    const section = buildDeviceSection({ device: agentDevice(), lookups, nowMs: NOW });
    expect(rowOf(section, 'status', 'Health')).toMatchObject({
      kind: 'text',
      value: 'Not available: your NinjaOne API client or plan does not include this data.',
    });
    expect(rowOf(section, 'security', 'Antivirus')).toMatchObject({ kind: 'text', value: expect.stringMatching(/^Not available: /) });
    expect(rowOf(section, 'alerts', 'Active alerts')).toBeDefined();
  });

  it('shows no note for a report that is not loaded for this kind of device', () => {
    const switchDevice = { id: 7, deviceType: 'NMSTarget', nodeClass: 'NMS_SWITCH', offline: true, ipAddresses: ['10.0.0.250'] };
    const section = buildDeviceSection({ device: switchDevice, lookups: { health: ok([]), alerts: ok([]) }, nowMs: NOW });
    expect(section.groups.map((g) => g.key)).toEqual(['status', 'alerts', 'network']);
    expect(JSON.stringify(section)).not.toContain('Not available');
  });

  it('ignores missing and unexpected shapes instead of failing', () => {
    const odd = {
      id: '42',
      offline: 'no',
      volumes: 'C:',
      processors: [null, 5, { name: 7 }],
      references: [],
      maintenance: { status: 12 },
      tags: [1, { name: 'kept' }],
      notes: 'free text',
      ipAddresses: null,
      lastContact: 'yesterday',
      system: { virtualMachine: 'yes' },
    };
    const section = buildDeviceSection({ device: odd, lookups: { health: ok([{ deviceId: 'x' }]), alerts: ok([]) }, nowMs: NOW });
    expect(integrationSectionSchema.safeParse(section).success).toBe(true);
    expect(rowOf(section, 'tags', 'Tags')).toMatchObject({ value: ['kept'] });
    expect(groupOf(section, 'storage')).toBeUndefined();
  });

  it('shows VM guest and host detail, and flags snapshots', () => {
    const guest = buildDeviceSection({
      device: { id: 5, deviceType: 'VMGuest', powerState: 'PoweredOn', guestOSFullName: 'Ubuntu 24.04', toolStatus: 'RUNNING', toolsVersion: '12.4', snapshotCount: 2, snapshotTotalSize: 10_737_418_240 },
      lookups: {},
      nowMs: NOW,
    });
    expect(rowOf(guest, 'virtualization', 'Power state')).toMatchObject({ value: 'PoweredOn', tone: 'success' });
    expect(rowOf(guest, 'virtualization', 'Snapshots')).toMatchObject({ value: '2', tone: 'warning' });
    expect(rowOf(guest, 'virtualization', 'Snapshot size')).toEqual({ kind: 'bytes', label: 'Snapshot size', value: 10_737_418_240 });
    expect(rowOf(guest, 'virtualization', 'Guest tools')).toMatchObject({ value: 'Running, 12.4' });

    const off = buildDeviceSection({ device: { id: 6, deviceType: 'VMGuest', powerState: 'NotRunning' }, lookups: {}, nowMs: NOW });
    expect(rowOf(off, 'virtualization', 'Power state')).toMatchObject({ tone: 'neutral' });

    const host = buildDeviceSection({
      device: { id: 8, deviceType: 'VMHost', vendor: 'VMware', releaseName: 'ESXi 8.0', buildNumber: '22380479', cpuModel: 'Xeon Gold', cpuPackages: 2, cpuCores: 32, cpuThreads: 64, serviceTag: 'HOST01' },
      lookups: {},
      nowMs: NOW,
    });
    expect(rowOf(host, 'virtualization', 'Hypervisor')).toMatchObject({ value: 'VMware ESXi 8.0 build 22380479' });
    expect(rowOf(host, 'virtualization', 'Host CPU')).toMatchObject({ value: '2x Xeon Gold (32 cores, 64 threads)' });
  });

  it('shows backup only when NinjaOne Backup is in use', () => {
    expect(groupOf(buildDeviceSection({ device: agentDevice(), lookups: {}, nowMs: NOW }), 'backup')).toBeUndefined();
    const withBackup = buildDeviceSection({
      device: agentDevice({ references: { backupUsage: { lastSuccessfulBackupJob: nowS - 3600, cloudTotalSize: 2e9, localTotalSize: 0 } } }),
      lookups: {},
      nowMs: NOW,
    });
    expect(rowOf(withBackup, 'backup', 'Cloud backup size')).toEqual({ kind: 'bytes', label: 'Cloud backup size', value: 2e9 });
  });

  it('reads NinjaOne epoch seconds and groups report rows by device', () => {
    expect(epochMs(1714000000.5)).toBe(1714000000500);
    expect(epochMs(1714000000500)).toBe(1714000000500);
    expect(epochMs(0)).toBeUndefined();
    expect(epochMs('x')).toBeUndefined();
    const grouped = byDeviceId([{ deviceId: 1 }, { device: { id: 2 } }, { deviceId: 1 }, { other: true }]);
    expect([...grouped.entries()].map(([id, rows]) => [id, rows.length])).toEqual([[1, 2], [2, 1]]);
  });
});
