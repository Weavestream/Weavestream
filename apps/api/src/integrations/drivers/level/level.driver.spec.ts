import { driverDescriptorSchema, driverResourceDescriptorSchema, integrationSectionSchema, type IntegrationSection } from '@weavestream/shared';
import {
  DriverAuthError,
  DriverRateLimitError,
  type FetchRecordsContext,
  type IntegrationContext,
  type LegacyDriverRecord,
} from '../integration-driver.js';
import {
  LEVEL_RECOMMENDED_DESTINATIONS,
  byDevice,
  LevelDriver,
  __resetLevelRunCacheForTests,
} from './level.driver.js';
import { LEVEL_SETUP_GUIDE } from './level.setup-guide.js';
import { deviceStandardFields, formatDiskSize, formatRam, privateIpv4 } from './level.sections.js';
import { setDefaultFetchForTests, setDefaultResolveForTests } from '../../../common/egress/safe-fetch.js';

const API = 'https://api.level.io/v2';
const KEY = 'level-test-key';
const ROOT = 'grp-root-1';
const SNAPSHOT = '2026-10-08T12:00:00.000Z';

type Reply = { status?: number; body: unknown } | ((url: string) => { status?: number; body: unknown });

interface Call {
  url: string;
  method: string;
  headers?: Record<string, string>;
}

/**
 * Scripted fetch table: the longest key that prefixes the URL answers it;
 * an unscripted URL throws. DNS is stubbed to a public IP so the egress
 * guard stays on but never touches the network.
 */
function installFetchTable(table: Record<string, Reply>) {
  const calls: Call[] = [];
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  setDefaultFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers as Record<string, string> | undefined });
    const key = keys.find((k) => url.startsWith(k));
    if (!key) throw new Error(`Level driver test: unscripted fetch to ${url}`);
    const entry = table[key]!;
    const reply = typeof entry === 'function' ? entry(url) : entry;
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);
  setDefaultResolveForTests(async () => ['1.2.3.4']);
  return calls;
}

let seq = 0;
function makeCtx(secret: Record<string, unknown> = { apiKey: KEY }): IntegrationContext {
  seq += 1;
  return {
    config: {},
    secret,
    integrationId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    correlationId: 'corr-1',
    http: { timeoutMs: 5_000, maxRetries: 0, backoffMs: 1 },
  };
}

function fetchCtx(base: IntegrationContext, externalOrgId = ROOT): FetchRecordsContext {
  return { ...base, externalOrgId, resourceKey: 'devices', filter: {}, mode: 'full', updatedSince: null, snapshotAt: SNAPSHOT };
}

const GROUPS = {
  [`${API}/groups?`]: {
    body: {
      data: [
        { id: ROOT, name: 'Example Co', parent_id: null, child_ids: ['grp-child'], device_count: 1, descendent_device_count: 3 },
        { id: 'grp-root-2', name: 'Other Co', parent_id: null, child_ids: [] },
        // A nested group the server should not return; the driver drops it anyway.
        { id: 'grp-child', name: 'Nested', parent_id: ROOT, child_ids: [] },
      ],
      has_more: false,
    },
  },
};

const LAPTOP = {
  id: 'dev-1', hostname: 'ws-01', nickname: 'Front desk', serial_number: 'SN-001', group_id: 'grp-child', group_name: 'Nested',
  role: 'workstation', platform: 'Windows', online: true, last_seen_at: '2026-10-08T11:00:00Z', last_reboot_time: '2026-10-01T06:00:00Z',
  last_logged_in_user: 'EXAMPLE\\user1', maintenance_mode: false, city: 'Example City', country: 'US',
  manufacturer: 'Example Corp', model: 'Book 14', architecture: 'x64', total_memory: 17_179_869_184, memory_slots: 2, cpu_cores: 8,
  security_score: 82, notes: 'Front desk PC', tags: ['vip', 'office'], public_ip_address: '203.0.113.10', private_ip_addresses: ['10.0.0.10'],
  full_operating_system: 'Windows 10 Pro 22H2',
  operating_system: { full_operating_system: 'Windows 10 Pro 22H2', major_version: 10, minor_version: 0, end_of_life: true, install_date: '2022-01-05T00:00:00Z' },
  cpus: [{ model: 'Example CPU 8000', cores: 8, clock_speed: 3000 }],
  memory: [{ size: 8_589_934_592, memory_type: 'DDR4', form_factor: 'SODIMM', location: 'DIMM0' }],
  disks: [{ model: 'Example SSD', disk_type: 'SSD', size: 512_110_190_592, serial_number: 'D1' }],
  disk_partitions: [
    { mount_point: 'C:', label: 'OS', size: 1_000, free_space: 250, encrypted: true, primary: true },
    { label: 'Data', size: 2_000, free_space: 2_000 },
    { mount_point: 'Z:', size: 0, free_space: 0 },
  ],
  motherboard: { manufacturer: 'Example Corp', model: 'MB-1', bios_version: '1.2.3' },
  network_interfaces: [
    { label: 'Bluetooth', mac_address: '00:11:22:33:44:00', ip_addresses: [] },
    { label: 'Ethernet', mac_address: '00:11:22:33:44:55', ip_addresses: ['10.0.0.10', 'fe80::1'], gateway: '10.0.0.1', dns_servers: ['10.0.0.53'] },
  ],
  security: { risk: 'high', patch_compliance: 75, antivirus_provider: 'Example AV', antivirus_status: 'up to date', firewall_enabled: true, primary_partition_encrypted: true, admin_accounts_count: 2 },
};
const VM = { id: 'dev-2', hostname: 'vm-01', nickname: null, serial_number: null, group_id: ROOT, online: false };
const UNGROUPED = { id: 'dev-3', hostname: 'loose', group_id: null };

const ALERTS = {
  data: [
    { id: 'a1', device_id: 'dev-1', severity: 'critical', name: 'Disk almost full', started_at: '2026-10-08T10:00:00Z' },
    { id: 'a2', device_id: 'dev-elsewhere', severity: 'warning', name: 'Other' },
  ],
  has_more: false,
};
const UPDATES = {
  data: [
    { id: 'u1', device_id: 'dev-1', name: 'Cumulative update', category: 'Security', is_available: true },
    { id: 'u2', device_id: 'dev-1', name: 'Driver update', category: 'Drivers', is_available: true },
  ],
  has_more: false,
};

function table(overrides: Record<string, Reply> = {}): Record<string, Reply> {
  return {
    ...GROUPS,
    [`${API}/devices?`]: (url) =>
      new URL(url).searchParams.get('starting_after') === 'dev-2'
        ? { body: { data: [UNGROUPED], has_more: false } }
        : { body: { data: [LAPTOP, VM], has_more: true } },
    [`${API}/alerts?`]: { body: ALERTS },
    [`${API}/updates?`]: { body: UPDATES },
    ...overrides,
  };
}

function sectionOf(rec: LegacyDriverRecord): IntegrationSection {
  const parsed = integrationSectionSchema.safeParse(rec.section);
  if (!parsed.success) throw new Error(`invalid section: ${parsed.error.message}`);
  return parsed.data;
}

function row(section: IntegrationSection, group: string, label: string) {
  const g = section.groups.find((candidate) => candidate.key === group);
  if (!g) throw new Error(`missing group ${group}`);
  return g.rows.find((r) => r.label === label);
}

beforeEach(() => __resetLevelRunCacheForTests());
afterEach(() => {
  setDefaultFetchForTests(null);
  setDefaultResolveForTests(null);
});

describe('LevelDriver descriptor', () => {
  const driver = new LevelDriver();

  it('validates against the shared schema with an API key, a setup guide and match hints', () => {
    const parsed = driverDescriptorSchema.parse(driver.descriptor);
    expect(parsed.secretFields).toEqual([expect.objectContaining({ key: 'apiKey', kind: 'password', required: true })]);
    expect(parsed.setupGuide?.map((s) => s.id)).toEqual(LEVEL_SETUP_GUIDE.map((s) => s.id));
    const [devices] = parsed.resources;
    expect(devices).toMatchObject({ key: 'devices', targetKind: 'asset', minimalFields: ['name', 'serialNumber'] });
    expect(devices!.matchSuggestions).toMatchObject({ sourceField: 'serialNumber', fieldHints: ['serial', 'serial_number', 'serial_no'] });
  });

  it('recommends a new layout with the minimal fields only', () => {
    expect(LEVEL_RECOMMENDED_DESTINATIONS.devices!.fields.map((f) => f.sourceField)).toEqual(['name', 'serialNumber']);
  });
});

describe('LevelDriver connection', () => {
  it('sends the raw API key without a Bearer prefix', async () => {
    const calls = installFetchTable(GROUPS);
    await expect(new LevelDriver().testConnection(makeCtx())).resolves.toEqual({ ok: true, details: 'Connected to Level (2 top-level groups).' });
    expect(calls[0]!.headers).toMatchObject({ Authorization: KEY });
    // Level reads parent_id=null as an id (404), so the filter must never be sent.
    expect(new URL(calls[0]!.url).searchParams.has('parent_id')).toBe(false);
  });

  it('lists only root groups as source orgs', async () => {
    installFetchTable(GROUPS);
    await expect(new LevelDriver().listSourceOrgs(makeCtx())).resolves.toEqual([
      { externalId: ROOT, name: 'Example Co', hint: null },
      { externalId: 'grp-root-2', name: 'Other Co', hint: null },
    ]);
  });

  it('walks group pages through starting_after and has_more', async () => {
    const calls = installFetchTable({
      [`${API}/groups?`]: (url) =>
        new URL(url).searchParams.get('starting_after') === 'g100'
          ? { body: { data: [{ id: 'g101', name: 'Last', parent_id: null }], has_more: false } }
          : { body: { data: Array.from({ length: 100 }, (_, i) => ({ id: `g${i + 1}`, name: `G${i + 1}`, parent_id: null })), has_more: true } },
    });
    const orgs = await new LevelDriver().listSourceOrgs(makeCtx());
    expect(orgs).toHaveLength(101);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]!.url).searchParams.get('limit')).toBe('100');
  });

  it('maps 401 to DriverAuthError without Level error text', async () => {
    installFetchTable({ [`${API}/groups?`]: { status: 401, body: { error: 'raw provider text' } } });
    const error = await new LevelDriver().testConnection(makeCtx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DriverAuthError);
    expect((error as Error).message).not.toMatch(/raw provider text/);
  });

  it('maps 429 to DriverRateLimitError', async () => {
    installFetchTable({ [`${API}/groups?`]: { status: 429, body: {} } });
    await expect(new LevelDriver().testConnection(makeCtx())).rejects.toBeInstanceOf(DriverRateLimitError);
  });

  it('asks for a key when none is saved, before any request', async () => {
    const calls = installFetchTable(GROUPS);
    await expect(new LevelDriver().testConnection(makeCtx({}))).rejects.toBeInstanceOf(DriverAuthError);
    expect(calls).toHaveLength(0);
  });
});

describe('LevelDriver devices', () => {
  it('refuses to fetch for a group that is not a root group of this account', async () => {
    const calls = installFetchTable(table());
    for (const org of ['grp-child', 'grp-unknown']) {
      await expect(new LevelDriver().fetchRecords(fetchCtx(makeCtx(), org), null)).rejects.toBeInstanceOf(DriverAuthError);
    }
    expect(calls.some((c) => c.url.startsWith(`${API}/devices`))).toBe(false);
  });

  it('pages devices with includes, skips ungrouped devices and lists alerts and updates once per org', async () => {
    const calls = installFetchTable(table());
    const driver = new LevelDriver();
    const ctx = makeCtx();

    const first = await driver.fetchRecords(fetchCtx(ctx), null);
    expect(first.hasMore).toBe(true);
    expect(JSON.parse(Buffer.from(first.cursor!, 'base64').toString('utf8'))).toEqual({ startingAfter: 'dev-2' });
    const deviceUrl = new URL(calls.find((c) => c.url.startsWith(`${API}/devices`))!.url);
    expect(deviceUrl.searchParams.get('ancestor_group_id')).toBe(ROOT);
    for (const flag of ['include_operating_system', 'include_disks', 'include_disk_partitions', 'include_memory', 'include_security']) {
      expect(deviceUrl.searchParams.get(flag)).toBe('true');
    }

    const [laptop, vm] = first.records as LegacyDriverRecord[];
    expect(laptop).toMatchObject({ externalId: 'dev-1', displayName: 'Front desk', fields: { name: 'Front desk', serialNumber: 'SN-001' } });
    expect(vm!.fields).toEqual({ name: 'vm-01', serialNumber: null, hostname: 'vm-01' });
    expect(laptop!.fields).toEqual({
      name: 'Front desk', serialNumber: 'SN-001', hostname: 'ws-01', manufacturer: 'Example Corp', model: 'Book 14',
      operating_system: 'Windows 10 Pro 22H2', cpu: 'Example CPU 8000 (8 cores)', ram: '16 GB',
      storage: '512 GB SSD (Example SSD)', mac_address: '00:11:22:33:44:55', ip_address: '10.0.0.10', role: 'Workstation',
    });

    const second = await driver.fetchRecords(fetchCtx(ctx), first.cursor);
    expect(second).toMatchObject({ hasMore: false, cursor: null, records: [] });
    expect(new URL(calls.filter((c) => c.url.startsWith(`${API}/devices`))[1]!.url).searchParams.get('starting_after')).toBe('dev-2');

    // One listing each for the whole org, never one per device.
    expect(calls.filter((c) => c.url.startsWith(`${API}/alerts`))).toHaveLength(1);
    expect(calls.filter((c) => c.url.startsWith(`${API}/updates`))).toHaveLength(1);
    expect(new URL(calls.find((c) => c.url.startsWith(`${API}/alerts`))!.url).searchParams.get('status')).toBe('active');
    expect(new URL(calls.find((c) => c.url.startsWith(`${API}/updates`))!.url).searchParams.get('status')).toBe('available');
  });

  it('builds a valid section with partition meters, EOL badge, alerts and patches', async () => {
    installFetchTable(table());
    const page = await new LevelDriver().fetchRecords(fetchCtx(makeCtx()), null);
    const s = sectionOf(page.records[0] as LegacyDriverRecord);
    expect(s.title).toBe('Level RMM');
    expect(s.groups.map((g) => g.key)).toEqual(['status', 'storage', 'network', 'security', 'patches', 'alerts', 'hardware', 'tags', 'notes']);
    expect(s.groups.find((g) => g.key === 'status')!.rows.map((r) => r.label)).toEqual(
      ['Status', 'Last seen', 'Last reboot', 'Logged-in user', 'Maintenance mode', 'Platform', 'Group', 'Location (from IP)'],
    );
    // Standard facts live in layout fields, never again in the block.
    expect(s.groups.find((g) => g.key === 'hardware')!.rows.map((r) => r.label)).toEqual(['Memory modules', 'Disks']);
    const labels = s.groups.flatMap((g) => g.rows.map((r) => r.label));
    for (const gone of ['Hostname', 'Manufacturer', 'Model', 'CPU', 'Memory', 'Role', 'Name', 'Version']) expect(labels).not.toContain(gone);
    expect(row(s, 'status', 'Status')).toMatchObject({ kind: 'badge', value: 'Online', tone: 'success' });
    expect(row(s, 'status', 'Group')).toMatchObject({ value: 'Nested' });
    expect(row(s, 'status', 'Location (from IP)')).toMatchObject({ value: 'Example City, US' });
    expect(row(s, 'hardware', 'Memory modules')).toMatchObject({ value: ['8.0 GB DDR4 SODIMM (DIMM0)'] });
    expect(row(s, 'hardware', 'Disks')).toMatchObject({ value: ['Example SSD, SSD, 477 GB'] });
    expect(row(s, 'storage', 'C:')).toEqual({ kind: 'meter', label: 'C:', used: 750, total: 1_000, unit: 'bytes' });
    expect(row(s, 'storage', 'Data')).toMatchObject({ used: 0, total: 2_000 });
    expect(row(s, 'storage', 'Z:')).toBeUndefined();
    expect(row(s, 'security', 'OS end of life')).toEqual({ kind: 'badge', label: 'OS end of life', value: 'Yes', tone: 'danger' });
    expect(row(s, 'network', 'Public IP')).toMatchObject({ value: '203.0.113.10' });
    expect(row(s, 'network', 'Ethernet')).toMatchObject({ value: ['MAC 00:11:22:33:44:55', 'IP 10.0.0.10', 'IP fe80::1', 'Gateway 10.0.0.1', 'DNS 10.0.0.53'] });
    expect(row(s, 'security', 'Risk')).toMatchObject({ value: 'High', tone: 'danger' });
    expect(row(s, 'security', 'Patch compliance')).toMatchObject({ kind: 'meter', used: 75, total: 100, higherIsBetter: true });
    expect(row(s, 'patches', 'Available updates')).toMatchObject({ value: '2', tone: 'warning' });
    expect(row(s, 'patches', 'Available')).toMatchObject({ value: ['Cumulative update (Security)', 'Driver update (Drivers)'] });
    expect(row(s, 'alerts', 'Active alerts')).toMatchObject({ value: '1', tone: 'danger' });
    expect(row(s, 'alerts', 'Active')).toMatchObject({ value: ['Critical: Disk almost full (since 2026-10-08 10:00 UTC)'] });
    expect(row(s, 'tags', 'Tags')).toMatchObject({ value: ['vip', 'office'] });

    const vm = sectionOf(page.records[1] as LegacyDriverRecord);
    expect(row(vm, 'status', 'Status')).toMatchObject({ value: 'Offline' });
    expect(row(vm, 'alerts', 'Active alerts')).toMatchObject({ value: '0', tone: 'success' });
  });

  it('still syncs devices with a note when alerts or updates are forbidden', async () => {
    installFetchTable(table({
      [`${API}/alerts?`]: { status: 403, body: {} },
      [`${API}/updates?`]: { status: 404, body: {} },
    }));
    const page = await new LevelDriver().fetchRecords(fetchCtx(makeCtx()), null);
    expect(page.records).toHaveLength(2);
    const s = sectionOf(page.records[0] as LegacyDriverRecord);
    expect(row(s, 'alerts', 'Alerts')).toMatchObject({ kind: 'text', value: expect.stringMatching(/^Not available: /) });
    expect(row(s, 'patches', 'Patches')).toMatchObject({ kind: 'text', value: expect.stringMatching(/^Not available: /) });
  });

  it('fails instead of ending the walk when a page says more follow but carries no ids', async () => {
    installFetchTable(table({ [`${API}/devices?`]: { body: { data: [{ hostname: 'no-id' }], has_more: true } } }));
    await expect(new LevelDriver().fetchRecords(fetchCtx(makeCtx()), null)).rejects.toThrow(/without ids/);
  });

  it('propagates a rate limit from optional data so the page is retried', async () => {
    installFetchTable(table({ [`${API}/updates?`]: { status: 429, body: {} } }));
    await expect(new LevelDriver().fetchRecords(fetchCtx(makeCtx()), null)).rejects.toBeInstanceOf(DriverRateLimitError);
  });

  it('never issues a non-GET request', async () => {
    const calls = installFetchTable(table());
    const driver = new LevelDriver();
    const ctx = makeCtx();
    await driver.testConnection(ctx);
    await driver.listSourceOrgs(ctx);
    const first = await driver.fetchRecords(fetchCtx(ctx), null);
    await driver.fetchRecords(fetchCtx(ctx), first.cursor);
    await driver.diagnose({ mode: 'connection', ctx });
    expect(calls.length).toBeGreaterThan(5);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});

describe('LevelDriver Check setup', () => {
  it('passes every step it can verify', async () => {
    installFetchTable(GROUPS);
    await expect(new LevelDriver().diagnose({ mode: 'connection', ctx: makeCtx() })).resolves.toEqual({
      ok: true, passedStepIds: ['api-key', 'credentials', 'organizations'], failures: [],
    });
  });

  it.each([
    [401, /mistyped or revoked/],
    [403, /no access/],
  ])('points HTTP %s at the API key step', async (status, message) => {
    installFetchTable({ [`${API}/groups?`]: { status, body: {} } });
    const check = await new LevelDriver().diagnose({ mode: 'connection', ctx: makeCtx() });
    expect(check.failures).toEqual([{ stepId: 'api-key', message: expect.stringMatching(message) }]);
  });

  it('asks to retry on a rate limit', async () => {
    installFetchTable({ [`${API}/groups?`]: { status: 429, body: {} } });
    const check = await new LevelDriver().diagnose({ mode: 'connection', ctx: makeCtx() });
    expect(check.failures).toEqual([{ stepId: null, message: expect.stringMatching(/rate limiting/) }]);
  });
});

describe('Level byDevice bucketing', () => {
  it('groups items per device in order, appending in place rather than copying the bucket', () => {
    const items = [
      { device_id: 'd1', n: 1 },
      { device_id: 'd2', n: 2 },
      { n: 3 },
      { device_id: 'd1', n: 4 },
      { device_id: 'd1', n: 5 },
    ];
    const set = jest.spyOn(Map.prototype, 'set');
    try {
      const out = byDevice(items);
      expect(out.get('d1')!.map((i) => i.n)).toEqual([1, 4, 5]);
      expect(out.get('d2')!.map((i) => i.n)).toEqual([2]);
      // One set per device: a copy-per-item bucket would set on every item.
      expect(set).toHaveBeenCalledTimes(2);
    } finally {
      set.mockRestore();
    }
  });
});

describe('Level standard fields', () => {
  it('describes Level RMM with valid standard fields that skip the match key', () => {
    const descriptor = new LevelDriver().descriptor;
    expect(descriptor.label).toBe('Level RMM');
    const devices = driverResourceDescriptorSchema.parse(descriptor.resources[0]);
    expect(devices.standardFields!.map((f) => f.sourceField)).toEqual(
      ['hostname', 'manufacturer', 'model', 'operating_system', 'cpu', 'ram', 'storage', 'mac_address', 'ip_address', 'role'],
    );
    expect(devices.standardFields!.find((f) => f.sourceField === 'operating_system')!.fieldHints).toEqual(['operating_system', 'os']);
  });

  it('summarizes multi-socket CPUs, several disks and picks the primary NIC', () => {
    expect(deviceStandardFields({
      cpus: [{ model: 'Example Xeon', cores: 16 }, { model: 'Example Xeon', cores: 16 }],
      disks: [{ size: 2_000_000_000_000, disk_type: 'NVMe', model: 'Disk A' }, { size: 480_000_000_000, model: 'Disk B' }],
      network_interfaces: [
        { mac_address: 'AA:00:00:00:00:01', ip_addresses: ['172.16.5.4'] },
        { mac_address: 'AA:00:00:00:00:02', ip_addresses: ['8.8.8.8'], gateway: '8.8.8.1' },
        { mac_address: 'AA:00:00:00:00:03', ip_addresses: ['192.168.1.20/24'], gateway: '192.168.1.1' },
      ],
    })).toEqual({
      cpu: '2x Example Xeon (32 cores)',
      storage: '2 TB NVMe (Disk A), 480 GB (Disk B)',
      mac_address: 'AA:00:00:00:00:03',
      ip_address: '192.168.1.20',
    });
  });

  it('falls back to the first NIC with a MAC and the device private IP list, and omits missing facts', () => {
    expect(deviceStandardFields({
      network_interfaces: [{ ip_addresses: ['10.1.1.1'] }, { mac_address: 'AA:00:00:00:00:09', ip_addresses: [] }],
      private_ip_addresses: ['203.0.113.7', '10.9.8.7'],
      total_memory: 16_900_000_000,
    })).toEqual({ mac_address: 'AA:00:00:00:00:09', ip_address: '10.9.8.7', ram: '16 GB' });
    expect(deviceStandardFields({})).toEqual({});
    expect(privateIpv4('172.32.0.1')).toBeUndefined();
    expect(formatRam(8 * 2 ** 30)).toBe('8 GB');
    expect(formatDiskSize(256_060_514_304)).toBe('256 GB');
  });
});
