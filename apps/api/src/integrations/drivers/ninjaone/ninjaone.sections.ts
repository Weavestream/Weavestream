import type { IntegrationSection, IntegrationSectionGroup } from '@weavestream/shared';
import {
  arr,
  badge,
  bool,
  bytes,
  bytesMeter,
  date,
  datetime,
  enumLabel,
  fin,
  formatDiskSize,
  group,
  list,
  num,
  obj,
  str,
  strings,
  text,
  toIso,
  upstreamLabel,
  type Lookup,
  type Row,
} from '../section-rows.js';

/**
 * Pure builders for the NinjaOne section on the asset page
 * (integrationSectionSchema). NinjaOne keeps its own field mapping, so
 * the section leaves out the facts operators map to layout fields
 * (hostname, make, model, OS, CPU, RAM, primary IP and MAC) and shows
 * the live state around them.
 *
 * Every NinjaOne field is optional: a missing value drops its row, an
 * unknown shape is ignored, and an unknown enum value is shown as plain
 * text with a neutral tone. Report data from `/v2/queries/*` arrives as a
 * `Lookup`; an unavailable lookup becomes a note, an absent one (not
 * loaded for this kind of device) shows nothing.
 */

export const SECTION_TITLE = 'NinjaOne';
/** Patches and alerts listed per device (the count covers all). */
export const LIST_PREVIEW = 20;
/** A warranty ending within this many days is flagged. */
export const WARRANTY_WARN_DAYS = 90;
const DAY_MS = 86_400_000;

type Obj = Record<string, unknown>;
type Tone = 'neutral' | 'success' | 'warning' | 'danger';
/** Report rows by NinjaOne device id. */
export type ByDevice = ReadonlyMap<number, Obj[]>;

export interface DeviceLookups {
  health?: Lookup<ByDevice>;
  alerts?: Lookup<ByDevice>;
  osPatches?: Lookup<ByDevice>;
  softwarePatches?: Lookup<ByDevice>;
  antivirus?: Lookup<ByDevice>;
  networkInterfaces?: Lookup<ByDevice>;
  disks?: Lookup<ByDevice>;
}

export interface DeviceSectionInput {
  /** The raw `/v2/devices-detailed` record. */
  device: Obj;
  lookups: DeviceLookups;
  nowMs: number;
}

/** NinjaOne epoch seconds (with fractional ms) as epoch milliseconds. */
export function epochMs(value: unknown): number | undefined {
  const n = fin(value);
  if (n === undefined || n <= 0) return undefined;
  return n < 1e11 ? Math.round(n * 1000) : n;
}

/** Upper-case enums read as words; anything else is kept as sent. */
function word(value: unknown): string | undefined {
  const s = str(value);
  return s && s === s.toUpperCase() ? enumLabel(s) : s;
}

function rowsFor(lookup: Lookup<ByDevice> | undefined, id: number): Obj[] {
  return lookup?.ok ? (lookup.value.get(id) ?? []) : [];
}

function unavailable(label: string, lookup: Lookup<ByDevice> | undefined): Row {
  return lookup && !lookup.ok ? text(label, `Not available: ${lookup.reason}`) : null;
}

/** A count badge: zero is good, any other count takes `tone`. */
function countBadge(label: string, value: unknown, tone: Tone): Row {
  const n = fin(value);
  return n === undefined ? null : badge(label, String(n), n > 0 ? tone : 'success');
}

/** "First 20 pending" when the list is cut, else the plain label. */
function preview(label: string, lines: string[]): Row {
  if (lines.length === 0) return null;
  return list(lines.length > LIST_PREVIEW ? `First ${LIST_PREVIEW} ${label.toLowerCase()}` : label, lines.slice(0, LIST_PREVIEW));
}

const HEALTH_TONES: Readonly<Record<string, Tone>> = {
  HEALTHY: 'success',
  NEEDS_ATTENTION: 'warning',
  UNHEALTHY: 'danger',
};

function statusRows(d: Obj, health: Lookup<ByDevice> | undefined, id: number): Row[] {
  const h = rowsFor(health, id)[0];
  const os = obj(d.os);
  const refs = obj(d.references);
  const maintenance = obj(d.maintenance);
  const healthStatus = str(h?.healthStatus);
  const rebootReason = str(h?.pendingRebootReason);
  const needsReboot = os?.needsReboot === true || !!rebootReason;
  const maintenanceStatus = str(maintenance?.status);
  const approval = str(d.approvalStatus);
  return [
    healthStatus ? badge('Health', word(healthStatus)!, HEALTH_TONES[healthStatus] ?? 'neutral') : unavailable('Health', health),
    typeof d.offline === 'boolean' ? badge('Status', d.offline ? 'Offline' : 'Online', d.offline ? 'neutral' : 'success') : null,
    datetime('Last contact', epochMs(d.lastContact)),
    datetime('Last boot', epochMs(os?.lastBootTime ?? d.lastBootTime)),
    needsReboot ? badge('Reboot pending', 'Yes', 'warning') : os?.needsReboot === false ? badge('Reboot pending', 'No', 'success') : null,
    text('Reboot reason', rebootReason),
    text('Logged-in user', str(d.lastLoggedInUser)),
    maintenanceStatus ? badge('Maintenance', word(maintenanceStatus)!, maintenanceStatus === 'FAILED' ? 'danger' : 'neutral') : null,
    maintenanceStatus ? datetime('Maintenance until', epochMs(maintenance?.end)) : null,
    maintenanceStatus ? text('Maintenance reason', str(maintenance?.reasonMessage)) : null,
    // Approved is the normal state; only a device waiting or retired is called out.
    approval && approval !== 'APPROVED' ? badge('Approval', word(approval)!, 'warning') : null,
    text('Location', str(obj(refs?.location)?.name)),
    text('Policy', str(obj(refs?.policy)?.name) ?? str(obj(refs?.rolePolicy)?.name)),
    text('Device class', word(d.nodeClass)),
  ];
}

/** One usage bar per volume with a known size. */
function storageRows(d: Obj): Row[] {
  return arr(d.volumes).map((v): Row => {
    const capacity = fin(v.capacity);
    const free = fin(v.freeSpace);
    if (capacity === undefined || capacity <= 0 || free === undefined) return null;
    const label = upstreamLabel(str(v.driveLetter) ?? str(v.label) ?? str(v.name), 'Volume');
    return bytesMeter(label, Math.max(0, capacity - free), capacity);
  });
}

function definitionsTone(status: string): Tone {
  // Checked first: "Not up to date" must not read as up to date.
  if (/\b(not|out)[\s_-]?(up[\s_-]?to|of)[\s_-]?date\b|\b(old|expired|outdated)\b/i.test(status)) return 'warning';
  if (/\b(up[\s_-]?to[\s_-]?date|current|ok)\b/i.test(status)) return 'success';
  return 'neutral';
}

function vulnerabilityRow(h: Obj | undefined): Row {
  const critical = fin(h?.criticalVulnerabilityCount);
  const high = fin(h?.highVulnerabilityCount);
  if (critical === undefined && high === undefined) return null;
  const tone: Tone = (critical ?? 0) > 0 ? 'danger' : (high ?? 0) > 0 ? 'warning' : 'success';
  return badge('Vulnerabilities', `${critical ?? 0} critical, ${high ?? 0} high`, tone);
}

function bitLockerLines(d: Obj): string[] {
  return arr(d.volumes).map((v) => {
    const status = obj(v.bitLockerStatus);
    const parts = [word(status?.conversionStatus), word(status?.protectionStatus)].filter(Boolean);
    if (parts.length === 0) return undefined;
    return `${str(v.driveLetter) ?? str(v.label) ?? str(v.name) ?? 'Volume'}: ${parts.join(', ')}`;
  }).filter((line): line is string => !!line);
}

function securityRows(d: Obj, lookups: DeviceLookups, id: number): Row[] {
  const h = rowsFor(lookups.health, id)[0];
  const products = rowsFor(lookups.antivirus, id).flatMap((av): Row[] => {
    const name = [str(av.productName), word(av.productState)].filter(Boolean).join(', ');
    const definitions = str(av.definitionStatus);
    return [text('Antivirus', name), definitions ? badge('Definitions', word(definitions)!, definitionsTone(definitions)) : null];
  });
  const bitLocker = bitLockerLines(d);
  return [
    ...products,
    unavailable('Antivirus', lookups.antivirus),
    countBadge('Active threats', h?.activeThreatsCount, 'danger'),
    num('Quarantined threats', fin(h?.quarantinedThreatsCount)),
    num('Blocked threats', fin(h?.blockedThreatsCount)),
    vulnerabilityRow(h),
    bitLocker.length > 0 ? list('BitLocker', bitLocker) : null,
  ];
}

/** Status of a patch row, upper-cased for matching. */
const statusOf = (row: Obj) => (str(row.status) ?? '').toUpperCase();

function kb(value: unknown): string | undefined {
  const s = str(value);
  return s ? (/^kb/i.test(s) ? s.toUpperCase() : `KB${s}`) : undefined;
}

function osPatchLine(p: Obj): string {
  const head = [str(p.name) ?? 'Unnamed patch', kb(p.kbNumber) && `(${kb(p.kbNumber)})`].filter(Boolean).join(' ');
  const severity = word(p.severity);
  return severity ? `${severity}: ${head}` : head;
}

function softwarePatchLine(p: Obj): string {
  return [str(p.title) ?? str(p.productIdentifier) ?? 'Unnamed patch', word(p.impact) && `(${word(p.impact)})`].filter(Boolean).join(' ');
}

function patchRows(lookups: DeviceLookups, id: number): Row[] {
  const h = rowsFor(lookups.health, id)[0];
  const os = rowsFor(lookups.osPatches, id);
  const software = rowsFor(lookups.softwarePatches, id);
  // REJECTED patches were declined on purpose; they are not listed.
  const by = (rows: Obj[], status: string, line: (p: Obj) => string) => rows.filter((p) => statusOf(p) === status).map(line);
  return [
    countBadge('OS patches pending', h?.pendingOSPatchesCount, 'warning'),
    countBadge('OS patches failed', h?.failedOSPatchesCount, 'danger'),
    countBadge('Software patches pending', h?.pendingSoftwarePatchesCount, 'warning'),
    countBadge('Software patches failed', h?.failedSoftwarePatchesCount, 'danger'),
    preview('Failed OS patches', by(os, 'FAILED', osPatchLine)),
    preview('Pending OS patches', by(os, 'PENDING', osPatchLine)),
    unavailable('OS patch list', lookups.osPatches),
    preview('Failed software patches', by(software, 'FAILED', softwarePatchLine)),
    preview('Pending software patches', by(software, 'PENDING', softwarePatchLine)),
    unavailable('Software patch list', lookups.softwarePatches),
  ];
}

const SEVERE = new Set(['CRITICAL', 'MAJOR']);

function alertRows(alerts: Lookup<ByDevice> | undefined, id: number): Row[] {
  if (!alerts) return [];
  if (!alerts.ok) return [text('Alerts', `Not available: ${alerts.reason}`)];
  const active = alerts.value.get(id) ?? [];
  const tone: Tone = active.length === 0 ? 'success' : active.some((a) => SEVERE.has((str(a.severity) ?? '').toUpperCase())) ? 'danger' : 'warning';
  const lines = active.map((a) => {
    const started = toIso(epochMs(a.createTime));
    const when = started ? ` (since ${started.slice(0, 16).replace('T', ' ')} UTC)` : '';
    const what = str(a.subject) ?? str(a.message) ?? str(a.conditionName) ?? 'Unnamed alert';
    return `${word(a.severity) ?? 'Alert'}: ${what}${when}`;
  });
  return [badge('Active alerts', String(active.length), tone), preview('Active', lines)];
}

/** NinjaOne packs several addresses into one entry with "|". */
function addresses(value: unknown): string[] {
  return strings(value).flatMap((entry) => entry.split('|')).map((s) => s.trim()).filter(Boolean);
}

function networkRows(d: Obj, nics: Lookup<ByDevice> | undefined, id: number): Row[] {
  const system = obj(d.system);
  const ips = addresses(d.ipAddresses);
  const macs = addresses(d.macAddresses);
  const interfaces = rowsFor(nics, id).map((nic): Row => {
    const nicIps = addresses(nic.ipAddress);
    // Virtual and disconnected adapters carry no address; they are noise here.
    if (nicIps.length === 0) return null;
    const entries = [
      ...addresses(nic.macAddress).map((mac) => `MAC ${mac}`),
      ...nicIps.map((ip) => `IP ${ip}`),
      str(nic.defaultGateway) && `Gateway ${str(nic.defaultGateway)}`,
      str(nic.dnsServers) && `DNS ${str(nic.dnsServers)}`,
      str(nic.linkSpeed) && `Link ${str(nic.linkSpeed)}`,
      str(nic.status) && `Status ${word(nic.status)}`,
    ].filter((e): e is string => !!e);
    return list(upstreamLabel(str(nic.interfaceName) ?? str(nic.adapterName), 'Interface'), entries);
  });
  return [
    text('Public IP', str(d.publicIP)),
    ips.length > 0 ? list('IP addresses', ips) : null,
    macs.length > 0 ? list('MAC addresses', macs) : null,
    text('Domain', str(system?.domain)),
    text('Domain role', word(system?.domainRole)),
    text('DNS name', str(d.dnsName)),
    text('NetBIOS name', str(d.netbiosName)),
    ...interfaces,
    unavailable('Interfaces', nics),
  ];
}

function warrantyRows(d: Obj, nowMs: number): Row[] {
  const refs = obj(d.references);
  const warranty = obj(refs?.warranty);
  const owner = obj(refs?.assignedOwner);
  const end = epochMs(warranty?.endDate);
  let state: Row = null;
  if (end !== undefined) {
    const days = Math.ceil((end - nowMs) / DAY_MS);
    state = days < 0
      ? badge('Warranty', 'Expired', 'danger')
      : days <= WARRANTY_WARN_DAYS
        ? badge('Warranty', `Ends in ${days} ${days === 1 ? 'day' : 'days'}`, 'warning')
        : badge('Warranty', 'Active', 'success');
  }
  // The owner's name only: contact details stay in NinjaOne.
  const ownerName = [str(owner?.firstName), str(owner?.lastName)].filter(Boolean).join(' ');
  return [
    state,
    date('Warranty start', epochMs(warranty?.startDate)),
    date('Warranty end', end),
    date('Manufacturer fulfilment', epochMs(warranty?.manufacturerFulfillmentDate)),
    text('Assigned owner', ownerName),
  ];
}

function processorLine(p: Obj): string | undefined {
  const name = str(p.name);
  if (!name) return undefined;
  const cores = fin(p.numCores);
  const threads = fin(p.numLogicalCores);
  const hz = fin(p.maxClockSpeed) ?? fin(p.clockSpeed);
  const detail = [
    cores !== undefined && `${cores} cores`,
    threads !== undefined && `${threads} threads`,
    hz !== undefined && hz > 0 && `${(hz / 1e9).toFixed(2)} GHz`,
  ].filter(Boolean).join(', ');
  return detail ? `${name} (${detail})` : name;
}

const DISK_OK = /^(ok|healthy|good)$/i;

function diskRows(disks: Lookup<ByDevice> | undefined, id: number): Row[] {
  const rows = rowsFor(disks, id);
  const lines = rows.map((disk) => {
    const size = fin(disk.size);
    return [
      str(disk.model) ?? str(disk.name),
      [str(disk.mediaType), str(disk.interfaceType)].filter(Boolean).join(' / ') || undefined,
      size !== undefined && size > 0 ? formatDiskSize(size) : undefined,
      str(disk.status),
    ].filter(Boolean).join(', ');
  }).filter(Boolean);
  const statuses = rows.map((disk) => str(disk.status)).filter((s): s is string => !!s);
  const notOk = statuses.filter((s) => !DISK_OK.test(s)).length;
  return [
    // Summarised so a failing disk is visible without opening the list.
    statuses.length > 0 ? badge('Disk status', notOk > 0 ? `${notOk} not OK` : 'All OK', notOk > 0 ? 'warning' : 'success') : null,
    lines.length > 0 ? list('Disks', lines) : null,
    unavailable('Disks', disks),
  ];
}

function hardwareRows(d: Obj, disks: Lookup<ByDevice> | undefined, id: number): Row[] {
  const system = obj(d.system);
  const processors = arr(d.processors).map(processorLine).filter((line): line is string => !!line);
  const serial = str(system?.serialNumber);
  const bios = str(system?.biosSerialNumber);
  return [
    processors.length > 0 ? list('Processors', processors) : null,
    ...diskRows(disks, id),
    text('Chassis', word(system?.chassisType)),
    bool('Virtual machine', typeof system?.virtualMachine === 'boolean' ? system.virtualMachine : undefined),
    bios && bios !== serial ? text('BIOS serial number', bios) : null,
    text('Asset serial number', str(system?.assetSerialNumber)),
  ];
}

function virtualizationRows(d: Obj): Row[] {
  const type = str(d.deviceType);
  if (type === 'VMGuest') {
    const power = str(d.powerState);
    const tools = [word(d.toolStatus), str(d.toolsVersion)].filter(Boolean).join(', ');
    return [
      power ? badge('Power state', word(power)!, /^(powered[\s_-]?on|on|running)$/i.test(power) ? 'success' : 'neutral') : null,
      text('Guest OS', str(d.guestOSFullName)),
      text('Guest tools', tools),
      text('Guest tools version status', word(d.toolsVersionStatus)),
      num('CPU cores', fin(d.cpuCores)),
      // Snapshots left behind fill datastores; any count is worth a look.
      countBadge('Snapshots', d.snapshotCount, 'warning'),
      bytes('Snapshot size', fin(d.snapshotTotalSize)),
    ];
  }
  if (type === 'VMHost') {
    const cpuModel = str(d.cpuModel);
    const packages = fin(d.cpuPackages);
    const cpuDetail = [fin(d.cpuCores) !== undefined && `${fin(d.cpuCores)} cores`, fin(d.cpuThreads) !== undefined && `${fin(d.cpuThreads)} threads`]
      .filter(Boolean).join(', ');
    const cpu = cpuModel ? `${packages !== undefined && packages > 1 ? `${packages}x ` : ''}${cpuModel}${cpuDetail ? ` (${cpuDetail})` : ''}` : undefined;
    return [
      text('Hypervisor', [str(d.vendor), str(d.releaseName) ?? str(d.version), str(d.buildNumber) && `build ${str(d.buildNumber)}`].filter(Boolean).join(' ')),
      text('Host CPU', cpu),
      text('Service tag', str(d.serviceTag)),
    ];
  }
  return [];
}

function backupRows(d: Obj): Row[] {
  const usage = obj(obj(d.references)?.backupUsage);
  if (!usage) return [];
  const lastOk = epochMs(usage.lastSuccessfulBackupJob);
  const lastFailed = epochMs(usage.lastFailedBackupJob);
  const total = fin(usage.revisionsTotalSize);
  // NinjaOne returns an all-zero block for devices without NinjaOne Backup.
  if (lastOk === undefined && lastFailed === undefined && !(total && total > 0)) return [];
  return [
    datetime('Last successful backup', lastOk),
    datetime('Last failed backup', lastFailed),
    bytes('Cloud backup size', fin(usage.cloudTotalSize)),
    bytes('Local backup size', fin(usage.localTotalSize)),
  ];
}

function noteLines(d: Obj): string[] {
  return arr(d.notes).map((note) => str(note.text)).filter((note): note is string => !!note);
}

export function buildDeviceSection({ device, lookups, nowMs }: DeviceSectionInput): IntegrationSection {
  const id = fin(device.id) ?? -1;
  const tags = strings(device.tags);
  const notes = noteLines(device);
  const groups: IntegrationSectionGroup[] = [
    group('status', 'Status', 'ninjaone', statusRows(device, lookups.health, id)),
    group('storage', 'Storage', undefined, storageRows(device)),
    group('security', 'Security', undefined, securityRows(device, lookups, id)),
    group('patches', 'Patches', undefined, patchRows(lookups, id)),
    group('alerts', 'Alerts', undefined, alertRows(lookups.alerts, id)),
    group('network', 'Network', undefined, networkRows(device, lookups.networkInterfaces, id)),
    group('warranty', 'Warranty & owner', undefined, warrantyRows(device, nowMs)),
    group('hardware', 'Hardware detail', undefined, hardwareRows(device, lookups.disks, id)),
    group('virtualization', 'Virtualization', undefined, virtualizationRows(device)),
    group('backup', 'Backup', undefined, backupRows(device)),
    group('tags', 'Tags', undefined, [tags.length > 0 ? list('Tags', tags) : null]),
    group('notes', 'Notes', undefined, [notes.length > 0 ? list('Notes', notes) : null]),
  ];
  // The square mark: the driver logo is a wide wordmark that does not fit the 16px header.
  return { title: SECTION_TITLE, icon: 'ninjaone', groups: groups.filter((g) => g.rows.length > 0) };
}

/** Report rows grouped by their numeric `deviceId`; rows without one are dropped. */
export function byDeviceId(rows: readonly Obj[]): Map<number, Obj[]> {
  const out = new Map<number, Obj[]>();
  for (const row of rows) {
    const id = fin(row.deviceId) ?? fin(obj(row.device)?.id);
    if (id === undefined) continue;
    const bucket = out.get(id);
    if (bucket) bucket.push(row);
    else out.set(id, [row]);
  }
  return out;
}
