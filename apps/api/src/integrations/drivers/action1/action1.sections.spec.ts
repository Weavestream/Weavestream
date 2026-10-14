import { integrationSectionSchema, type IntegrationSection } from '@weavestream/shared';
import { parseRecordSection } from '../../integration-sync-runner.service.js';
import { SECTION_TITLE, buildEndpointSection } from './action1.sections.js';

/** A full endpoint, shaped like `/endpoints/managed/{orgId}?fields=*` after date normalisation. */
function endpoint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'e-42',
    type: 'Endpoint',
    self: '/API/endpoints/managed/o-1/e-42',
    organization_id: 'o-1',
    name: 'WS-042',
    device_name: 'DESKTOP-7QK2',
    address: '10.0.0.42',
    MAC: 'AA:BB:CC:DD:EE:FF',
    OS: 'Windows 11 (24H2)',
    platform: 'Windows',
    architecture: 'x64',
    agent_version: '5.300.1.1',
    agent_install_date: '2025-02-03T09:10:11Z',
    last_seen: '2026-10-14T11:58:00Z',
    last_boot_time: '2026-10-09T07:00:00Z',
    subscription_status: 'Active',
    user: 'CORP\\jdoe',
    CPU_model: 'Intel64 Family 6 Model 158 Stepping 10',
    CPU_name: 'Intel Core i7-8700',
    CPU_size: '3.2 GHz, 6/12 Cores',
    RAM: '32Gb DDR4',
    disk: '954Gb SSD',
    video: 'Intel UHD Graphics 630',
    NIC: 'Intel Ethernet Connection I219-LM',
    WiFi: 'Intel Wireless-AC 9560',
    manufacturer: 'Dell Inc. OptiPlex 7070',
    serial: 'ABC123',
    comment: 'Front desk',
    status: 'Connected',
    online_status: 'SUCCESS',
    reboot_required: 'Yes',
    update_status: 'ERROR',
    missing_updates: { critical: 2, other: 5 },
    vulnerability_status: 'WARNING',
    vulnerabilities: { critical: 0, other: 3 },
    AD_organization_unit: 'OU=Workstations,DC=corp,DC=example',
    AD_security_groups: ['Domain Computers', 'Front Desk PCs'],
    custom: [{ name: 'Asset tag', value: 'TAG-9' }],
    ...overrides,
  };
}

function build(overrides: Record<string, unknown> = {}): IntegrationSection {
  const section = buildEndpointSection(endpoint(overrides));
  expect(section).toBeDefined();
  return section!;
}

function rowsOf(section: IntegrationSection, key: string) {
  return section.groups.find((g) => g.key === key)?.rows ?? [];
}

function row(section: IntegrationSection, key: string, label: string) {
  return rowsOf(section, key).find((r) => r.label === label);
}

describe('buildEndpointSection', () => {
  it('passes the shared schema and the sync runner, in the agreed group order', () => {
    const section = build();
    expect(integrationSectionSchema.parse(section)).toEqual(section);
    expect(parseRecordSection(section)).toEqual(section);
    expect(section.title).toBe(SECTION_TITLE);
    expect(section.icon).toBe('action1');
    expect(section.groups.map((g) => g.key)).toEqual(['status', 'security', 'updates', 'hardware', 'directory']);
    expect(section.groups[0]!.icon).toBe('action1');
  });

  it('shows the live state in Status', () => {
    const section = build();
    expect(rowsOf(section, 'status')).toEqual([
      { kind: 'badge', label: 'Agent', value: 'Connected', tone: 'success' },
      { kind: 'badge', label: 'Check-in', value: 'Within 7 days', tone: 'success' },
      { kind: 'datetime', label: 'Last seen', value: '2026-10-14T11:58:00.000Z' },
      { kind: 'datetime', label: 'Last boot', value: '2026-10-09T07:00:00.000Z' },
      { kind: 'badge', label: 'Reboot pending', value: 'Yes', tone: 'warning' },
      { kind: 'text', label: 'Logged-in user', value: 'CORP\\jdoe' },
      { kind: 'text', label: 'Agent version', value: '5.300.1.1' },
      { kind: 'date', label: 'Agent installed', value: '2025-02-03' },
      { kind: 'text', label: 'Device name', value: 'DESKTOP-7QK2' },
    ]);
  });

  it('leaves out the mapped facts, internal ids and the comment', () => {
    const json = JSON.stringify(build());
    for (const value of [
      '10.0.0.42',
      'AA:BB:CC:DD:EE:FF',
      'Windows 11',
      'Intel Core i7-8700',
      '3.2 GHz',
      '32Gb DDR4',
      '954Gb SSD',
      'ABC123',
      'Dell Inc.',
      'Stepping 10',
      'Front desk',
      'TAG-9',
      'o-1',
      'e-42',
    ]) {
      expect(json).not.toContain(value);
    }
  });

  it.each([
    ['Connected', 'Connected', 'success'],
    ['Disconnected', 'Disconnected', 'neutral'],
    ['Pending Uninstall', 'Pending uninstall', 'warning'],
    ['Quarantined', 'Quarantined', 'neutral'],
  ])('shows agent status %s as %s (%s)', (status, value, tone) => {
    expect(row(build({ status }), 'status', 'Agent')).toEqual({ kind: 'badge', label: 'Agent', value, tone });
  });

  it.each([
    ['SUCCESS', 'Within 7 days', 'success'],
    ['WARNING', '8 to 30 days ago', 'warning'],
    ['ERROR', 'Over 30 days ago', 'danger'],
    ['STALE_AGENT', 'Stale agent', 'neutral'],
  ])('shows check-in %s as %s (%s)', (online_status, value, tone) => {
    expect(row(build({ online_status }), 'status', 'Check-in')).toEqual({ kind: 'badge', label: 'Check-in', value, tone });
  });

  it('shows no reboot pending as good, and an inactive subscription as a warning', () => {
    const section = build({ reboot_required: 'No', subscription_status: 'Inactive' });
    expect(row(section, 'status', 'Reboot pending')).toEqual({ kind: 'badge', label: 'Reboot pending', value: 'No', tone: 'success' });
    expect(row(section, 'status', 'Subscription')).toEqual({ kind: 'badge', label: 'Subscription', value: 'Inactive', tone: 'warning' });
    // Active is the normal state and is not shown.
    expect(row(build(), 'status', 'Subscription')).toBeUndefined();
  });

  it('shows the device name only when it differs from the endpoint name', () => {
    expect(row(build({ device_name: 'ws-042' }), 'status', 'Device name')).toBeUndefined();
    expect(row(build({ device_name: undefined }), 'status', 'Device name')).toBeUndefined();
  });

  it.each([
    [{ critical: 2, other: 5 }, '2 critical, 5 other', 'danger'],
    [{ critical: 0, other: 5 }, '0 critical, 5 other', 'warning'],
    [{ critical: 0, other: 0 }, '0 critical, 0 other', 'success'],
    [{ critical: '1', other: '4' }, '1 critical, 4 other', 'danger'],
  ])('tones the missing update counts %j', (missing_updates, value, tone) => {
    expect(rowsOf(build({ missing_updates }), 'updates')).toEqual([{ kind: 'badge', label: 'Missing updates', value, tone }]);
  });

  it.each([
    [{ other: 0 }],
    [{ critical: 0 }],
    [{ critical: -1, other: 0 }],
    [{ critical: 1.5, other: 0 }],
    [{ critical: 'many', other: 0 }],
  ])('never reads incomplete counts %j as zero: the status stands in', (counts) => {
    const section = build({ missing_updates: counts, update_status: 'ERROR', vulnerabilities: counts, vulnerability_status: 'ERROR' });
    expect(rowsOf(section, 'updates')).toEqual([{ kind: 'badge', label: 'Missing updates', value: 'Critical missing', tone: 'danger' }]);
    expect(rowsOf(section, 'security')).toEqual([{ kind: 'badge', label: 'Vulnerabilities', value: 'Critical found', tone: 'danger' }]);
    // With no usable status either, nothing is claimed.
    const unknown = build({ missing_updates: counts, update_status: 'UNDEFINED', vulnerabilities: counts, vulnerability_status: undefined });
    expect(rowsOf(unknown, 'updates')).toEqual([]);
    expect(rowsOf(unknown, 'security')).toEqual([]);
  });

  it('tones the vulnerability counts', () => {
    expect(rowsOf(build(), 'security')).toEqual([
      { kind: 'badge', label: 'Vulnerabilities', value: '0 critical, 3 other', tone: 'warning' },
    ]);
    expect(rowsOf(build({ vulnerabilities: { critical: 1, other: 0 } }), 'security')[0]).toMatchObject({ tone: 'danger' });
  });

  it('falls back to the summary status without counts, and drops UNDEFINED', () => {
    const section = build({ missing_updates: undefined, vulnerabilities: undefined });
    expect(rowsOf(section, 'updates')).toEqual([{ kind: 'badge', label: 'Missing updates', value: 'Critical missing', tone: 'danger' }]);
    expect(rowsOf(section, 'security')).toEqual([
      { kind: 'badge', label: 'Vulnerabilities', value: 'Non-critical found', tone: 'warning' },
    ]);
    const undefinedStatus = build({
      missing_updates: undefined,
      vulnerabilities: undefined,
      update_status: 'UNDEFINED',
      vulnerability_status: 'UNDEFINED',
    });
    expect(undefinedStatus.groups.map((g) => g.key)).toEqual(['status', 'hardware', 'directory']);
  });

  it('shows hardware detail and Active Directory', () => {
    const section = build();
    expect(rowsOf(section, 'hardware')).toEqual([
      { kind: 'text', label: 'Architecture', value: 'x64' },
      { kind: 'text', label: 'Video card', value: 'Intel UHD Graphics 630' },
      { kind: 'text', label: 'Network adapter', value: 'Intel Ethernet Connection I219-LM' },
      { kind: 'text', label: 'Wi-Fi adapter', value: 'Intel Wireless-AC 9560' },
    ]);
    expect(rowsOf(section, 'directory')).toEqual([
      { kind: 'text', label: 'Organizational unit', value: 'OU=Workstations,DC=corp,DC=example' },
      { kind: 'list', label: 'Security groups', value: ['Domain Computers', 'Front Desk PCs'] },
    ]);
  });

  it('ignores odd or missing shapes without throwing', () => {
    const odd = {
      status: 7,
      online_status: { x: 1 },
      last_seen: 'not a date',
      last_boot_time: 12,
      reboot_required: true,
      user: ['CORP\\jdoe'],
      missing_updates: 'many',
      vulnerabilities: [1, 2],
      update_status: null,
      vulnerability_status: 3,
      architecture: { arch: 'x64' },
      AD_security_groups: 'Domain Computers',
      AD_organization_unit: '   ',
    };
    expect(() => buildEndpointSection(odd)).not.toThrow();
    expect(buildEndpointSection(odd)).toBeUndefined();
    expect(buildEndpointSection({})).toBeUndefined();
    expect(buildEndpointSection({ id: 'e-1', name: 'x' })).toBeUndefined();
  });

  it('keeps a section with only some values valid', () => {
    const section = buildEndpointSection({ status: 'Disconnected', AD_security_groups: ['A', 7, null] })!;
    expect(integrationSectionSchema.parse(section)).toEqual(section);
    expect(rowsOf(section, 'directory')).toEqual([{ kind: 'list', label: 'Security groups', value: ['A'] }]);
  });

  it('cleans markup and control characters out of upstream text', () => {
    const section = build({ video: '<script>alert(1)</script>\u0007GPU', user: 'CORP\\<b>x</b>' });
    expect(integrationSectionSchema.safeParse(section).success).toBe(true);
    expect(parseRecordSection(section)).not.toBe('invalid');
    expect(row(section, 'hardware', 'Video card')).toEqual({ kind: 'text', label: 'Video card', value: '< script>alert(1)< /script>GPU' });
  });
});
