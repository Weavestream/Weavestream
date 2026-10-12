import { isIP } from 'node:net';
import type { IntegrationSection, IntegrationSectionGroup } from '@weavestream/shared';
import { badge, bool, date, datetime, facts, group, list, normalizeMac, normalizePhone, num, str, text, toIso, type Lookup, type Row } from '../section-rows.js';

export { badge, bool, clean, date, datetime, group, list, normalizeMac, normalizePhone, num, text, toIso, type Lookup, type Row } from '../section-rows.js';

/**
 * Pure builders for the Google Workspace records. Standard facts (job
 * title, model, OS, MAC, ...) fill layout fields through the
 * `*StandardFields` helpers; the sections below hold only the extras a
 * layout does not have, rendered read-only on the asset page
 * (integrationSectionSchema).
 */

export const SECTION_TITLE = 'Google Workspace';
const DAY_MS = 86_400_000;
export const INACTIVE_DAYS = 90;
const MB = 1024 * 1024;


export interface StorageUsage {
  usedMb?: number;
  totalMb?: number;
  gmailMb?: number;
  driveMb?: number;
  sharedDrivesMb?: number;
}

export interface UsageReport<T> {
  /** Report date (YYYY-MM-DD), shown as "Data as of". */
  date: string;
  value: T;
}

export interface GoogleUser {
  id?: string;
  primaryEmail?: string;
  name?: { fullName?: string };
  suspended?: boolean;
  archived?: boolean;
  isAdmin?: boolean;
  isDelegatedAdmin?: boolean;
  isEnrolledIn2Sv?: boolean;
  isEnforcedIn2Sv?: boolean;
  lastLoginTime?: string;
  creationTime?: string;
  orgUnitPath?: string;
  organizations?: Array<{ title?: string; department?: string; primary?: boolean }>;
  phones?: Array<{ value?: string; type?: string; primary?: boolean }>;
}


export function userStandardFields(user: GoogleUser): Record<string, string> {
  const orgs = user.organizations ?? [];
  const org = orgs.find((o) => o?.primary) ?? orgs[0];
  const phones = (user.phones ?? []).filter((p) => str(p?.value));
  const phone = phones.find((p) => p.primary) ?? phones.find((p) => p.type === 'work') ?? phones[0];
  return facts({
    job_title: str(org?.title),
    department: str(org?.department),
    phone: normalizePhone(str(phone?.value)),
  });
}

/**
 * A usage bar against a quota, or (pooled storage: no per-user quota, or
 * a quota of -1 / 0) the used amount as bytes with "pooled" in the label.
 */
function usage(label: string, usedMb: number | undefined, totalMb: number | undefined): Row {
  if (typeof usedMb !== 'number' || !Number.isFinite(usedMb) || usedMb < 0) return null;
  if (typeof totalMb === 'number' && Number.isFinite(totalMb) && totalMb > 0) {
    return { kind: 'meter', label, used: usedMb, total: totalMb, unit: 'mb' };
  }
  return { kind: 'bytes', label: `${label} (pooled storage)`, value: usedMb * MB };
}

export function section(groups: IntegrationSectionGroup[]): IntegrationSection {
  return { title: SECTION_TITLE, groups: groups.filter((g) => g.rows.length > 0) };
}

/** Last login as epoch ms, or null when the user never signed in (Google reports the epoch). */
export function lastLoginMs(user: GoogleUser): number | null {
  const ms = user.lastLoginTime ? Date.parse(user.lastLoginTime) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** Licensed AND (suspended, archived, or no sign-in for 90 days / ever). */
export function isWastedLicence(user: GoogleUser, licensed: boolean, nowMs: number): boolean {
  if (!licensed) return false;
  if (user.suspended || user.archived) return true;
  const last = lastLoginMs(user);
  return last === null || nowMs - last > INACTIVE_DAYS * DAY_MS;
}

function accountStatus(user: GoogleUser): Row {
  if (user.archived) return badge('Status', 'Archived', 'neutral');
  if (user.suspended) return badge('Status', 'Suspended', 'warning');
  return badge('Status', 'Active', 'success');
}

function adminRole(user: GoogleUser): Row {
  if (user.isAdmin) return badge('Admin role', 'Super admin', 'warning');
  if (user.isDelegatedAdmin) return badge('Admin role', 'Delegated admin', 'neutral');
  return badge('Admin role', 'None', 'neutral');
}

export function buildUserSection(
  user: GoogleUser,
  licences: Lookup<ReadonlyMap<string, string[]>>,
  usageLookup: Lookup<UsageReport<ReadonlyMap<string, StorageUsage>>>,
  nowMs: number,
): IntegrationSection {
  const email = (user.primaryEmail ?? '').toLowerCase();
  const skus = licences.ok ? licences.value.get(email) ?? [] : [];
  const groups: IntegrationSectionGroup[] = [
    group('account', 'Account', 'google', [
      accountStatus(user),
      text('Org unit', user.orgUnitPath),
      datetime('Created', user.creationTime),
      lastLoginMs(user) === null ? text('Last login', 'Never') : datetime('Last login', user.lastLoginTime),
    ]),
    group('licences', 'Licences', 'google-admin', licences.ok
      ? [skus.length > 0 ? list('Assigned', skus) : text('Assigned', 'None')]
      : [text('Licences', `Not available: ${licences.reason}`)]),
  ];

  if (usageLookup.ok) {
    const entry = usageLookup.value.value.get(email);
    const asOf = date('Data as of', usageLookup.value.date);
    if (entry) {
      groups.push(
        group('mailbox', 'Mailbox', 'gmail', [usage('Mailbox storage', entry.gmailMb, entry.totalMb)]),
        group('drive', 'Drive', 'google-drive', [usage('Drive storage', entry.driveMb, entry.totalMb)]),
        group('storage', 'Total storage', 'google-drive', [usage('Total storage', entry.usedMb, entry.totalMb), asOf]),
      );
    } else {
      groups.push(group('storage', 'Storage', 'google-drive', [text('Storage', 'No usage reported for this user yet.'), asOf]));
    }
  } else {
    groups.push(group('storage', 'Storage', 'google-drive', [text('Storage', `Not available: ${usageLookup.reason}`)]));
  }

  groups.push(
    group('security', 'Security', 'google-admin', [
      adminRole(user),
      bool('2-step verification enrolled', user.isEnrolledIn2Sv),
      bool('2-step verification enforced', user.isEnforcedIn2Sv),
      licences.ok
        ? isWastedLicence(user, skus.length > 0, nowMs)
          ? badge('Wasted licence', 'Yes', 'danger')
          : badge('Wasted licence', 'No', 'success')
        : null,
    ]),
  );
  return section(groups);
}

export interface TenantInput {
  createdAt?: string;
  users: GoogleUser[];
  licences: Lookup<ReadonlyMap<string, string[]>>;
  storage: Lookup<UsageReport<StorageUsage>>;
  nowMs: number;
}

export function buildTenantSection(input: TenantInput): IntegrationSection {
  const active = input.users.filter((u) => !u.suspended && !u.archived);
  const enrolled = active.filter((u) => u.isEnrolledIn2Sv).length;
  const superAdmins = input.users.filter((u) => u.isAdmin).length;

  const licenceRows: Row[] = [];
  let wasted: number | null = null;
  if (input.licences.ok) {
    const perEdition = new Map<string, number>();
    for (const skus of input.licences.value.values()) {
      for (const sku of skus) perEdition.set(sku, (perEdition.get(sku) ?? 0) + 1);
    }
    for (const [sku, count] of [...perEdition].sort((a, b) => b[1] - a[1])) licenceRows.push(num(sku, count));
    if (licenceRows.length === 0) licenceRows.push(text('Assigned', 'None'));
    const licensed = input.licences.value;
    wasted = input.users.filter((u) =>
      isWastedLicence(u, (licensed.get((u.primaryEmail ?? '').toLowerCase())?.length ?? 0) > 0, input.nowMs),
    ).length;
  } else {
    licenceRows.push(text('Licences', `Not available: ${input.licences.reason}`));
  }

  const storageRows: Row[] = [];
  if (input.storage.ok) {
    const s = input.storage.value.value;
    storageRows.push(
      usage('Total storage', s.usedMb, s.totalMb),
      usage('Gmail', s.gmailMb, s.totalMb),
      usage('Drive', s.driveMb, s.totalMb),
      usage('Shared drives', s.sharedDrivesMb, s.totalMb),
      date('Data as of', input.storage.value.date),
    );
  } else {
    storageRows.push(text('Storage', `Not available: ${input.storage.reason}`));
  }

  return section([
    group('overview', 'Overview', 'google', [
      num('Active users', active.length),
      num('Suspended users', input.users.filter((u) => u.suspended && !u.archived).length),
      num('Archived users', input.users.filter((u) => u.archived).length),
      datetime('Created', input.createdAt),
    ]),
    group('licences', 'Licences assigned per edition', 'google-admin', licenceRows),
    group('storage', 'Storage', 'google-drive', storageRows),
    group('security', 'Security', 'google-admin', [
      active.length > 0
        ? { kind: 'meter', label: '2-step verification coverage', used: enrolled, total: active.length, unit: 'count', higherIsBetter: true }
        : null,
      num('Super admins', superAdmins),
      wasted === null ? null : num('Wasted licences', wasted),
    ]),
  ]);
}

export interface GoogleGroup {
  id?: string;
  email?: string;
  name?: string;
  description?: string;
  directMembersCount?: string | number;
}

export function groupStandardFields(g: GoogleGroup): Record<string, string> {
  return facts({ description: str(g.description) });
}

export function buildGroupSection(g: GoogleGroup, members: Array<{ email?: string; role?: string }>): IntegrationSection {
  const count = Number(g.directMembersCount);
  const shown = members.filter((m) => m.email).map((m) => (m.role && m.role !== 'MEMBER' ? `${m.email} (${m.role.toLowerCase()})` : m.email!));
  return section([
    group('group', 'Group', 'google', [
      num('Members', Number.isFinite(count) ? count : members.length),
      shown.length > 0 ? list(Number.isFinite(count) && count > shown.length ? `Members (first ${shown.length})` : 'Member list', shown) : null,
    ]),
  ]);
}

export interface ChromeDevice {
  deviceId?: string;
  serialNumber?: string;
  model?: string;
  status?: string;
  osVersion?: string;
  lastSync?: string;
  annotatedUser?: string;
  annotatedAssetId?: string;
  orgUnitPath?: string;
  macAddress?: string;
  autoUpdateExpiration?: string;
  recentUsers?: Array<{ email?: string; type?: string }>;
  lastKnownNetwork?: Array<{ ipAddress?: string; wanIpAddress?: string }>;
}

export function chromeStandardFields(d: ChromeDevice): Record<string, string> {
  const os = str(d.osVersion);
  const ip = str(d.lastKnownNetwork?.[0]?.ipAddress);
  return facts({
    model: str(d.model),
    operating_system: os && `ChromeOS ${os}`,
    mac_address: normalizeMac(d.macAddress),
    ip_address: ip && isIP(ip) ? ip : undefined,
  });
}

export function buildChromeSection(d: ChromeDevice, nowMs: number): IntegrationSection {
  const expiry = toIso(d.autoUpdateExpiration);
  return section([
    group('chrome', 'Chrome OS', 'chrome', [
      d.status ? badge('Status', d.status, d.status === 'ACTIVE' ? 'success' : 'neutral') : null,
      datetime('Last sync', d.lastSync),
      // Shown only: a device's last user never fills assigned-to.
      text('Last user', str(d.annotatedUser) ?? str(d.recentUsers?.[0]?.email)),
      text('Org unit', d.orgUnitPath),
      date('Auto-update expiration', d.autoUpdateExpiration),
      expiry && Date.parse(expiry) < nowMs ? badge('Updates', 'Expired', 'danger') : null,
    ]),
  ]);
}

export interface MobileDevice {
  resourceId?: string;
  serialNumber?: string;
  model?: string;
  os?: string;
  type?: string;
  email?: string[];
  status?: string;
  lastSync?: string;
  deviceCompromisedStatus?: string;
  brand?: string;
  manufacturer?: string;
  imei?: string;
  wifiMacAddress?: string;
}

export function mobileStandardFields(d: MobileDevice): Record<string, string> {
  return facts({
    model: str(d.model),
    manufacturer: str(d.brand) ?? str(d.manufacturer),
    operating_system: str(d.os),
    imei: str(d.imei),
    mac_address: normalizeMac(d.wifiMacAddress),
  });
}

export function buildMobileSection(d: MobileDevice): IntegrationSection {
  const compromised = d.deviceCompromisedStatus;
  return section([
    group('device', 'Device', 'android', [
      text('Type', d.type),
      d.email && d.email.length > 0 ? list('Owner', d.email) : null,
      text('Status', d.status),
      datetime('Last sync', d.lastSync),
      compromised
        ? badge('Compromised', compromised, /no compromise/i.test(compromised) ? 'success' : /compromise/i.test(compromised) ? 'danger' : 'neutral')
        : null,
    ]),
  ]);
}
