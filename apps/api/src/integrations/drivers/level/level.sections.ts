import type { IntegrationSection, IntegrationSectionGroup } from '@weavestream/shared';
import { badge, bool, clean, datetime, group, list, num, text, toIso, type Lookup, type Row } from '../section-rows.js';

/**
 * Pure builders for Level device records. Standard facts (hostname, OS,
 * CPU, RAM, ...) go into layout fields through `deviceStandardFields`; the
 * section shown read-only on the asset page (integrationSectionSchema)
 * keeps only the extras a layout does not have. Every Level field is
 * optional and unknown shapes are ignored.
 */

export const SECTION_TITLE = 'Level RMM';
/** Available updates and active alerts listed per device (the count covers all). */
export const LIST_PREVIEW = 20;

type Obj = Record<string, unknown>;

export interface LevelDevice {
  id?: string;
  hostname?: string;
  nickname?: string | null;
  serial_number?: string | null;
  group_id?: string | null;
  [key: string]: unknown;
}

export interface LevelAlert {
  id?: string;
  device_id?: string;
  severity?: string;
  name?: string;
  started_at?: string;
}

export interface LevelUpdate {
  id?: string;
  device_id?: string;
  name?: string;
  category?: string;
}

const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj).filter((o): o is Obj => o !== undefined) : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const fin = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : str(obj(x)?.name) ?? str(obj(x)?.address))).filter((x): x is string => !!x) : [];

/** A label from upstream text: plain, non-empty, within the label cap. */
function upstreamLabel(value: string | undefined, fallback: string): string {
  const cleaned = value ? clean(value, 120).trim() : '';
  return cleaned || fallback;
}

/** A value of unknown type: a boolean, number or text row, whichever it is. */
function any(label: string, value: unknown): Row {
  if (typeof value === 'boolean') return bool(label, value);
  if (typeof value === 'number') return num(label, value);
  return text(label, str(value));
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function humanize(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function riskTone(risk: string): 'neutral' | 'success' | 'warning' | 'danger' {
  const r = risk.toLowerCase();
  if (/none|low|good|secure/.test(r)) return 'success';
  if (/medium|moderate|fair/.test(r)) return 'warning';
  if (/high|critical|severe|poor/.test(r)) return 'danger';
  return 'neutral';
}

function statusRows(d: LevelDevice): Row[] {
  const location = [str(d.city), str(d.country)].filter(Boolean).join(', ');
  return [
    typeof d.online === 'boolean' ? badge('Status', d.online ? 'Online' : 'Offline', d.online ? 'success' : 'neutral') : null,
    datetime('Last seen', str(d.last_seen_at)),
    datetime('Last reboot', str(d.last_reboot_time)),
    text('Logged-in user', str(d.last_logged_in_user)),
    bool('Maintenance mode', typeof d.maintenance_mode === 'boolean' ? d.maintenance_mode : undefined),
    text('Platform', str(d.platform)),
    // The Level group (site) and Level's IP-derived location, not the asset's own location.
    text('Group', str(d.group_name)),
    text('Location (from IP)', location),
  ];
}

/** Detail the layout fields summarize: each memory module and each disk model. */
function hardwareRows(d: LevelDevice): Row[] {
  const dimms = arr(d.memory).map((m) => {
    const size = fin(m.size);
    return [size !== undefined ? formatBytes(size) : undefined, str(m.memory_type), str(m.form_factor), str(m.location) && `(${str(m.location)})`]
      .filter(Boolean)
      .join(' ');
  }).filter(Boolean);
  const disks = arr(d.disks).map((disk) => {
    const size = fin(disk.size);
    return [str(disk.model), str(disk.disk_type), size !== undefined ? formatBytes(size) : undefined].filter(Boolean).join(', ');
  }).filter(Boolean);
  return [
    dimms.length > 0 ? list('Memory modules', dimms) : null,
    disks.length > 0 ? list('Disks', disks) : null,
  ];
}

function storageRows(d: LevelDevice): Row[] {
  return arr(d.disk_partitions).map((p): Row => {
    const size = fin(p.size);
    const free = fin(p.free_space);
    if (size === undefined || size <= 0 || free === undefined) return null;
    const used = Math.min(size, Math.max(0, size - free));
    return {
      kind: 'meter',
      label: upstreamLabel(str(p.mount_point) ?? str(p.label), 'Partition'),
      used,
      total: size,
      unit: 'bytes',
    };
  });
}

/** OS end of life, from the OS object or the security block. */
function osEndOfLife(d: LevelDevice): boolean | undefined {
  const os = obj(d.operating_system);
  if (typeof os?.end_of_life === 'boolean') return os.end_of_life;
  const flag = obj(d.security)?.os_end_of_life;
  return typeof flag === 'boolean' ? flag : undefined;
}

function networkRows(d: LevelDevice): Row[] {
  const rows: Row[] = [text('Public IP', str(d.public_ip_address))];
  const privateIps = strings(d.private_ip_addresses);
  if (privateIps.length > 0) rows.push(list('Private IPs', privateIps));
  for (const nic of arr(d.network_interfaces)) {
    const entries = [
      str(nic.mac_address) && `MAC ${str(nic.mac_address)}`,
      ...strings(nic.ip_addresses).map((ip) => `IP ${ip}`),
      str(nic.gateway) && `Gateway ${str(nic.gateway)}`,
      ...strings(nic.dns_servers).map((dns) => `DNS ${dns}`),
    ].filter((e): e is string => !!e);
    if (entries.length === 0) continue;
    rows.push(list(upstreamLabel(str(nic.label) ?? str(nic.interface) ?? str(nic.description), 'Interface'), entries));
  }
  return rows;
}

function securityRows(d: LevelDevice): Row[] {
  const s = obj(d.security) ?? {};
  const risk = str(s.risk);
  const compliance = fin(s.patch_compliance);
  const join = (...parts: unknown[]) => parts.map(str).filter(Boolean).join(', ');
  const eol = osEndOfLife(d);
  return [
    risk ? badge('Risk', humanize(risk)!, riskTone(risk)) : null,
    eol === undefined ? null : eol ? badge('OS end of life', 'Yes', 'danger') : badge('OS end of life', 'No', 'success'),
    num('Security score', fin(d.security_score) ?? fin(s.score)),
    compliance !== undefined && compliance >= 0 && compliance <= 100
      ? { kind: 'meter', label: 'Patch compliance', used: compliance, total: 100, unit: 'count', value: `${compliance}%`, higherIsBetter: true }
      : any('Patch compliance', s.patch_compliance),
    any('Patch security risk', s.patch_security_risk),
    text('Antivirus', join(s.antivirus_provider, s.antivirus_status)),
    typeof s.firewall_enabled === 'boolean' ? bool('Firewall enabled', s.firewall_enabled) : null,
    text('Firewall', join(s.firewall_provider, s.firewall_status)),
    any('Primary partition encrypted', s.primary_partition_encrypted),
    any('User account control', s.user_account_control_enabled),
    any('Automatic updates', s.auto_update),
    num('Admin accounts', fin(s.admin_accounts_count)),
  ];
}

function patchRows(updates: Lookup<ReadonlyMap<string, LevelUpdate[]>>, deviceId: string): Row[] {
  if (!updates.ok) return [text('Patches', `Not available: ${updates.reason}`)];
  const available = updates.value.get(deviceId) ?? [];
  const names = available.map((u) => [str(u.name), str(u.category) && `(${str(u.category)})`].filter(Boolean).join(' ')).filter(Boolean);
  return [
    badge('Available updates', String(available.length), available.length > 0 ? 'warning' : 'success'),
    names.length > 0 ? list(available.length > LIST_PREVIEW ? `First ${LIST_PREVIEW} available` : 'Available', names.slice(0, LIST_PREVIEW)) : null,
  ];
}

const SEVERE = new Set(['critical', 'emergency']);

function alertRows(alerts: Lookup<ReadonlyMap<string, LevelAlert[]>>, deviceId: string): Row[] {
  if (!alerts.ok) return [text('Alerts', `Not available: ${alerts.reason}`)];
  const active = alerts.value.get(deviceId) ?? [];
  const tone = active.length === 0 ? 'success' : active.some((a) => SEVERE.has((a.severity ?? '').toLowerCase())) ? 'danger' : 'warning';
  const lines = active.map((a) => {
    const started = toIso(str(a.started_at));
    const when = started ? ` (since ${started.slice(0, 16).replace('T', ' ')} UTC)` : '';
    return `${humanize(str(a.severity)) ?? 'Alert'}: ${str(a.name) ?? 'Unnamed alert'}${when}`;
  });
  return [
    badge('Active alerts', String(active.length), tone),
    lines.length > 0 ? list(active.length > LIST_PREVIEW ? `First ${LIST_PREVIEW} active` : 'Active', lines.slice(0, LIST_PREVIEW)) : null,
  ];
}

export interface DeviceSectionInput {
  device: LevelDevice;
  alerts: Lookup<ReadonlyMap<string, LevelAlert[]>>;
  updates: Lookup<ReadonlyMap<string, LevelUpdate[]>>;
}

export function buildDeviceSection({ device, alerts, updates }: DeviceSectionInput): IntegrationSection {
  const id = device.id ?? '';
  const tags = strings(device.tags);
  const groups: IntegrationSectionGroup[] = [
    group('status', 'Status', 'level', statusRows(device)),
    group('storage', 'Storage', undefined, storageRows(device)),
    group('network', 'Network', undefined, networkRows(device)),
    group('security', 'Security', undefined, securityRows(device)),
    group('patches', 'Patches', undefined, patchRows(updates, id)),
    group('alerts', 'Alerts', undefined, alertRows(alerts, id)),
    group('hardware', 'Hardware detail', undefined, hardwareRows(device)),
    group('tags', 'Tags', undefined, [tags.length > 0 ? list('Tags', tags) : null]),
    group('notes', 'Notes', undefined, [text('Notes', str(device.notes))]),
  ];
  return { title: SECTION_TITLE, groups: groups.filter((g) => g.rows.length > 0) };
}

// ---------------------------------------------------------------------
// Standard fields (layout fields, not the section)
// ---------------------------------------------------------------------

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** An RFC 1918 IPv4 address (a "/prefix" suffix is dropped). */
export function privateIpv4(value: string): string | undefined {
  const ip = value.trim().split('/')[0]!;
  return IPV4.test(ip) && PRIVATE_V4.test(ip) ? ip : undefined;
}

/** "16 GB": installed memory rounded to whole binary gigabytes. */
export function formatRam(bytes: number): string {
  const gb = Math.round(bytes / 2 ** 30);
  return gb >= 1 ? `${gb} GB` : formatBytes(bytes);
}

/** Disk capacity as sold (decimal): "512 GB", "2 TB", "1.9 TB". */
export function formatDiskSize(bytes: number): string {
  if (bytes >= 1e12) return `${Number((bytes / 1e12).toFixed(1))} TB`;
  return `${Math.round(bytes / 1e9)} GB`;
}

function cpuSummary(d: LevelDevice): string | undefined {
  const cpus = arr(d.cpus);
  const model = str(cpus[0]?.model);
  if (!model) return undefined;
  const perCpu = cpus.map((cpu) => fin(cpu.cores) ?? fin(cpu.number_of_cores)).filter((n): n is number => n !== undefined);
  const cores = fin(d.cpu_cores) ?? (perCpu.length > 0 ? perCpu.reduce((a, b) => a + b, 0) : undefined);
  const sockets = cpus.length > 1 ? `${cpus.length}x ` : '';
  return `${sockets}${model}${cores !== undefined && cores > 0 ? ` (${cores} cores)` : ''}`;
}

function storageSummary(d: LevelDevice): string | undefined {
  const disks = arr(d.disks).map((disk) => {
    const size = fin(disk.size);
    const model = str(disk.model);
    const head = [size !== undefined && size > 0 ? formatDiskSize(size) : undefined, str(disk.disk_type)].filter(Boolean).join(' ');
    if (!head) return model;
    return model ? `${head} (${model})` : head;
  }).filter((entry): entry is string => !!entry);
  return disks.length > 0 ? disks.join(', ') : undefined;
}

/** The NIC that carries a private IP and has a gateway, else the first with a MAC. */
function primaryNic(d: LevelDevice): Obj | undefined {
  const nics = arr(d.network_interfaces);
  const hasGateway = (nic: Obj) => !!str(nic.gateway) || strings(nic.gateways).length > 0;
  return (
    nics.find((nic) => hasGateway(nic) && strings(nic.ip_addresses).some((ip) => privateIpv4(ip))) ??
    nics.find((nic) => str(nic.mac_address))
  );
}

function primaryIp(d: LevelDevice, nic: Obj | undefined): string | undefined {
  const candidates = [...strings(nic?.ip_addresses), ...strings(d.private_ip_addresses)];
  for (const candidate of candidates) {
    const ip = privateIpv4(candidate);
    if (ip) return ip;
  }
  return undefined;
}

/**
 * Standard facts for the layout fields, keyed by the descriptor's
 * `standardFields` source keys. A missing value is left out, so the sync
 * never clears a field Level did not report.
 */
export function deviceStandardFields(d: LevelDevice): Record<string, string> {
  const os = obj(d.operating_system);
  const nic = primaryNic(d);
  const totalMemory = fin(d.total_memory);
  const values: Record<string, string | undefined> = {
    hostname: str(d.hostname),
    manufacturer: str(d.manufacturer),
    model: str(d.model),
    operating_system: str(os?.full_operating_system) ?? str(d.full_operating_system) ?? str(os?.name),
    cpu: cpuSummary(d),
    ram: totalMemory !== undefined && totalMemory > 0 ? formatRam(totalMemory) : undefined,
    storage: storageSummary(d),
    mac_address: str(nic?.mac_address),
    ip_address: primaryIp(d, nic),
    role: humanize(str(d.role)),
  };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) if (value) out[key] = clean(value, 1_000);
  return out;
}
