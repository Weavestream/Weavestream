import type { IntegrationSection, IntegrationSectionGroup } from '@weavestream/shared';
import {
  badge,
  bool,
  date,
  datetime,
  facts,
  group,
  link,
  list,
  normalizeMac,
  normalizePhone,
  num,
  str,
  text,
  type Lookup,
  type Row,
} from '../section-rows.js';
import { skuName } from './microsoft-365.skus.js';

/**
 * Pure builders for the Microsoft 365 records. Standard facts (job title,
 * model, OS, serial, ...) fill layout fields through the `*StandardFields`
 * helpers; the sections hold only the Microsoft extras, rendered read-only
 * on the asset page (integrationSectionSchema). Data that needs a licence
 * the tenant may lack (Entra ID P1, Intune, Defender) arrives as a `Lookup`
 * and degrades to a "Not available (needs ...)" row.
 */

export const SECTION_TITLE = 'Microsoft 365';
const DAY_MS = 86_400_000;
export const INACTIVE_DAYS = 90;
export const CONCEALED_NOTE = "Hidden by the tenant's report privacy setting.";
export const NOT_REPORTED = 'No usage reported for this user yet.';

export function section(groups: IntegrationSectionGroup[]): IntegrationSection {
  return { title: SECTION_TITLE, groups: groups.filter((g) => g.rows.length > 0) };
}

const unavailable = (label: string, reason: string): Row => text(label, reason.startsWith('Not available') ? reason : `Not available: ${reason}`);

// ---------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------

export interface MicrosoftUser {
  id?: string;
  displayName?: string;
  mail?: string | null;
  userPrincipalName?: string;
  jobTitle?: string | null;
  department?: string | null;
  businessPhones?: string[];
  mobilePhone?: string | null;
  accountEnabled?: boolean;
  createdDateTime?: string;
  userType?: string | null;
  onPremisesSyncEnabled?: boolean | null;
  assignedLicenses?: Array<{ skuId?: string }>;
  signInActivity?: { lastSignInDateTime?: string | null; lastNonInteractiveSignInDateTime?: string | null } | null;
}

/** Email used to match People: the mail address, else the UPN. */
export function userEmail(u: MicrosoftUser): string | undefined {
  return str(u.mail) ?? str(u.userPrincipalName);
}

export function userStandardFields(u: MicrosoftUser): Record<string, string> {
  const business = (u.businessPhones ?? []).map((p) => normalizePhone(str(p))).find(Boolean);
  return facts({
    job_title: str(u.jobTitle),
    department: str(u.department),
    phone: business ?? normalizePhone(str(u.mobilePhone)),
  });
}

/** Latest interactive or non-interactive sign-in in epoch ms, null when never. */
export function lastSignInMs(u: MicrosoftUser): number | null {
  const times = [u.signInActivity?.lastSignInDateTime, u.signInActivity?.lastNonInteractiveSignInDateTime]
    .map((v) => (v ? Date.parse(v) : NaN))
    .filter((ms) => Number.isFinite(ms) && ms > 0);
  return times.length > 0 ? Math.max(...times) : null;
}

/**
 * Licensed AND (disabled OR a shared mailbox OR, only when sign-in data
 * exists (Entra ID P1), no sign-in for 90 days). A never-signed-in account
 * counts once it is older than 90 days.
 */
export function isWastedLicence(
  u: MicrosoftUser,
  input: { licensed: boolean; sharedMailbox: boolean; signInKnown: boolean; nowMs: number },
): boolean {
  if (!input.licensed) return false;
  if (u.accountEnabled === false || input.sharedMailbox) return true;
  if (!input.signInKnown) return false;
  const last = lastSignInMs(u);
  if (last !== null) return input.nowMs - last > INACTIVE_DAYS * DAY_MS;
  const created = u.createdDateTime ? Date.parse(u.createdDateTime) : NaN;
  return Number.isFinite(created) && input.nowMs - created > INACTIVE_DAYS * DAY_MS;
}

/** One user's row of the mailbox usage report. */
export interface MailboxUsage {
  usedBytes?: number;
  quotaBytes?: number;
  hasArchive?: boolean;
}
/** One user's row of the OneDrive usage report. */
export interface OneDriveUsage {
  usedBytes?: number;
  allocatedBytes?: number;
}

/**
 * A usage report joined by lowercased UPN. `concealed` is true when the
 * tenant hides names (rows exist, but no UPN looks like an address), so
 * nothing can be joined.
 */
export interface UsageReport<T> {
  date: string | null;
  concealed: boolean;
  byUpn: ReadonlyMap<string, T>;
}

export interface UserLookups {
  skuNames: Lookup<ReadonlyMap<string, string>>;
  /** Sign-in activity is present in the user records (Entra ID P1). */
  signIn: Lookup<true>;
  mfa: Lookup<ReadonlyMap<string, boolean>>;
  roles: Lookup<ReadonlyMap<string, string[]>>;
  sharedMailboxes: Lookup<ReadonlySet<string>>;
  mailbox: Lookup<UsageReport<MailboxUsage>>;
  oneDrive: Lookup<UsageReport<OneDriveUsage>>;
}

function bytesMeter(label: string, used: number | undefined, total: number | undefined): Row {
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null;
  if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
    return { kind: 'meter', label, used, total, unit: 'bytes' };
  }
  return { kind: 'bytes', label, value: used };
}

function usageGroup<T>(
  key: string,
  title: string,
  report: Lookup<UsageReport<T>>,
  upn: string,
  rows: (entry: T) => Row[],
): IntegrationSectionGroup {
  if (!report.ok) return group(key, title, 'microsoft', [unavailable(title, report.reason)]);
  if (report.value.concealed) return group(key, title, 'microsoft', [text(title, CONCEALED_NOTE)]);
  const entry = report.value.byUpn.get(upn);
  const asOf = date('Data as of', report.value.date);
  return group(key, title, 'microsoft', entry ? [...rows(entry), asOf] : [text(title, NOT_REPORTED), asOf]);
}

export function userLicenceNames(u: MicrosoftUser, skuNames: ReadonlyMap<string, string>): string[] {
  return (u.assignedLicenses ?? []).map((l) => (l.skuId ? skuNames.get(l.skuId.toLowerCase()) ?? l.skuId : null)).filter((n): n is string => Boolean(n));
}

export function buildUserSection(u: MicrosoftUser, lookups: UserLookups, nowMs: number): IntegrationSection {
  const id = (u.id ?? '').toLowerCase();
  const upn = (u.userPrincipalName ?? '').toLowerCase();
  const licensed = (u.assignedLicenses ?? []).length > 0;
  const shared = lookups.sharedMailboxes.ok ? lookups.sharedMailboxes.value.has(id) : null;
  const last = lastSignInMs(u);

  const groups: IntegrationSectionGroup[] = [
    group('account', 'Account', 'microsoft', [
      u.accountEnabled === false ? badge('Status', 'Disabled', 'warning') : badge('Status', 'Enabled', 'success'),
      datetime('Created', u.createdDateTime),
      lookups.signIn.ok
        ? last === null
          ? text('Last sign-in', 'Never')
          : datetime('Last sign-in', new Date(last).toISOString())
        : unavailable('Last sign-in', lookups.signIn.reason),
      bool('Synced from on-premises', u.onPremisesSyncEnabled === true),
      shared === null
        ? unavailable('Shared mailbox', (lookups.sharedMailboxes as { reason: string }).reason)
        : badge('Shared mailbox', shared ? 'Yes' : 'No', 'neutral'),
    ]),
    group('licences', 'Licences', 'microsoft', lookups.skuNames.ok
      ? [licensed ? list('Assigned', userLicenceNames(u, lookups.skuNames.value)) : text('Assigned', 'None')]
      : [unavailable('Licences', lookups.skuNames.reason)]),
    usageGroup('mailbox', 'Mailbox', lookups.mailbox, upn, (m) => [
      bytesMeter('Mailbox storage', m.usedBytes, m.quotaBytes),
      bool('Archive mailbox', m.hasArchive),
    ]),
    usageGroup('onedrive', 'OneDrive', lookups.oneDrive, upn, (o) => [bytesMeter('OneDrive storage', o.usedBytes, o.allocatedBytes)]),
  ];

  const roles = lookups.roles.ok ? lookups.roles.value.get(id) ?? [] : null;
  const mfa = lookups.mfa.ok ? lookups.mfa.value.get(id) : undefined;
  const wasted = lookups.skuNames.ok
    ? isWastedLicence(u, { licensed, sharedMailbox: shared === true, signInKnown: lookups.signIn.ok, nowMs })
    : null;
  groups.push(
    group('security', 'Security', 'microsoft', [
      lookups.mfa.ok ? (mfa === undefined ? text('MFA registered', 'Not reported') : bool('MFA registered', mfa)) : unavailable('MFA registered', lookups.mfa.reason),
      roles === null
        ? unavailable('Admin roles', (lookups.roles as { reason: string }).reason)
        : roles.length > 0
          ? list('Admin roles', roles)
          : text('Admin roles', 'None'),
      wasted === null ? null : wasted ? badge('Wasted licence', 'Yes', 'danger') : badge('Wasted licence', 'No', 'success'),
    ]),
  );
  return section(groups);
}

// ---------------------------------------------------------------------
// Intune devices
// ---------------------------------------------------------------------

export interface ManagedDevice {
  id?: string;
  deviceName?: string | null;
  serialNumber?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  operatingSystem?: string | null;
  osVersion?: string | null;
  wiFiMacAddress?: string | null;
  imei?: string | null;
  phoneNumber?: string | null;
  complianceState?: string | null;
  lastSyncDateTime?: string | null;
  enrolledDateTime?: string | null;
  userPrincipalName?: string | null;
  userDisplayName?: string | null;
  managementAgent?: string | null;
  isEncrypted?: boolean | null;
  totalStorageSpaceInBytes?: number | null;
  freeStorageSpaceInBytes?: number | null;
  managedDeviceOwnerType?: string | null;
}

/** iOS, iPadOS and Android go to Phones; Windows, macOS, Linux and anything else to computers. */
export function isMobileOs(os: string | null | undefined): boolean {
  return /^(ios|ipados|android)/i.test((os ?? '').trim());
}

function osOf(d: ManagedDevice): string | undefined {
  const os = str(d.operatingSystem);
  const version = str(d.osVersion);
  return os ? (version ? `${os} ${version}` : os) : undefined;
}

export function computerStandardFields(d: ManagedDevice): Record<string, string> {
  return facts({
    hostname: str(d.deviceName),
    manufacturer: str(d.manufacturer),
    model: str(d.model),
    operating_system: osOf(d),
    mac_address: normalizeMac(str(d.wiFiMacAddress)),
  });
}

export function mobileStandardFields(d: ManagedDevice): Record<string, string> {
  return facts({
    model: str(d.model),
    manufacturer: str(d.manufacturer),
    operating_system: osOf(d),
    imei: str(d.imei),
    phone_number: normalizePhone(str(d.phoneNumber)),
  });
}

function compliance(d: ManagedDevice): Row {
  const state = str(d.complianceState);
  if (!state) return null;
  const tone = state === 'compliant' ? 'success' : state === 'noncompliant' ? 'danger' : 'neutral';
  return badge('Compliance', state, tone);
}

function owner(d: ManagedDevice): Row {
  return text('Primary user', str(d.userPrincipalName) ?? str(d.userDisplayName));
}

export function buildComputerSection(d: ManagedDevice): IntegrationSection {
  const total = typeof d.totalStorageSpaceInBytes === 'number' ? d.totalStorageSpaceInBytes : undefined;
  const free = typeof d.freeStorageSpaceInBytes === 'number' ? d.freeStorageSpaceInBytes : undefined;
  return section([
    group('intune', 'Intune', 'microsoft', [
      compliance(d),
      datetime('Last check-in', d.lastSyncDateTime),
      datetime('Enrolled', d.enrolledDateTime),
      owner(d),
      total !== undefined && free !== undefined && total > 0 && free >= 0 && free <= total
        ? bytesMeter('Storage', total - free, total)
        : null,
      text('Management agent', d.managementAgent),
      bool('Encrypted', d.isEncrypted ?? undefined),
      text('Ownership', d.managedDeviceOwnerType),
    ]),
  ]);
}

export function buildMobileSection(d: ManagedDevice): IntegrationSection {
  return section([
    group('intune', 'Intune', 'microsoft', [
      compliance(d),
      datetime('Last check-in', d.lastSyncDateTime),
      owner(d),
      text('Ownership', d.managedDeviceOwnerType),
    ]),
  ]);
}

// ---------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------

export interface MicrosoftGroup {
  id?: string;
  displayName?: string;
  mail?: string | null;
  description?: string | null;
  groupTypes?: string[];
  mailEnabled?: boolean;
  securityEnabled?: boolean;
}

export function groupType(g: MicrosoftGroup): string {
  if ((g.groupTypes ?? []).includes('Unified')) return 'Microsoft 365';
  if (g.mailEnabled && g.securityEnabled) return 'Mail-enabled security';
  if (g.mailEnabled) return 'Distribution';
  return 'Security';
}

export function groupStandardFields(g: MicrosoftGroup): Record<string, string> {
  return facts({ description: str(g.description) });
}

export function buildGroupSection(g: MicrosoftGroup, members: { count: number | null; shown: string[] }): IntegrationSection {
  const count = members.count ?? members.shown.length;
  return section([
    group('group', 'Group', 'microsoft', [
      badge('Type', groupType(g), 'neutral'),
      num('Members', count),
      members.shown.length > 0 ? list(count > members.shown.length ? `Members (first ${members.shown.length})` : 'Member list', members.shown) : null,
    ]),
  ]);
}

// ---------------------------------------------------------------------
// Tenant
// ---------------------------------------------------------------------

export interface SubscribedSku {
  skuId?: string;
  skuPartNumber?: string;
  capabilityStatus?: string;
  consumedUnits?: number;
  prepaidUnits?: { enabled?: number; suspended?: number; warning?: number };
}

export interface DirectorySubscription {
  skuPartNumber?: string;
  status?: string;
  totalLicenses?: number;
  isTrial?: boolean;
  nextLifecycleDateTime?: string | null;
}

export interface SecurityAlert {
  title?: string;
  severity?: string;
  status?: string;
  createdDateTime?: string;
  alertWebUrl?: string | null;
}

export interface TenantInput {
  createdAt?: string;
  counts: Lookup<{ members: number; disabled: number; guests: number }>;
  skus: Lookup<SubscribedSku[]>;
  subscriptions: Lookup<DirectorySubscription[]>;
  secureScore: Lookup<{ current: number; max: number } | null>;
  mfa: Lookup<{ registered: number; members: number }>;
  admins: Lookup<{ any: number; global: number }>;
  storage: Lookup<{ oneDriveBytes: number | null; sharePointBytes: number | null; date: string | null }>;
  alerts: Lookup<{ items: SecurityAlert[]; more: boolean }>;
}

/** Shown alerts; the count row says how many there were. */
export const ALERTS_SHOWN = 10;

export function subscriptionLine(s: DirectorySubscription): string {
  const parts = [
    s.status ?? 'Unknown status',
    typeof s.totalLicenses === 'number' ? `${s.totalLicenses} licence${s.totalLicenses === 1 ? '' : 's'}` : null,
    s.nextLifecycleDateTime ? `next lifecycle date ${s.nextLifecycleDateTime.slice(0, 10)}` : null,
    s.isTrial ? 'trial' : null,
  ];
  return parts.filter(Boolean).join(', ');
}

const SEVERITY_ORDER = ['high', 'medium', 'low', 'informational', 'unknownFutureValue'];

export function buildTenantSection(input: TenantInput): IntegrationSection {
  const overview: Row[] = input.counts.ok
    ? [num('Members', input.counts.value.members), num('Disabled members', input.counts.value.disabled), num('Guests', input.counts.value.guests)]
    : [unavailable('Users', input.counts.reason)];
  overview.push(datetime('Created', input.createdAt));

  const licences: Row[] = input.skus.ok
    ? input.skus.value
        .filter((s) => s.skuPartNumber)
        .sort((a, b) => (b.consumedUnits ?? 0) - (a.consumedUnits ?? 0))
        .slice(0, 40)
        .map((s): Row => {
          const name = skuName(s.skuPartNumber);
          // Units in their grace period (warning) are still purchased and assignable.
          const total = (s.prepaidUnits?.enabled ?? 0) + (s.prepaidUnits?.warning ?? 0);
          const used = Math.max(0, s.consumedUnits ?? 0);
          const assignable = !s.capabilityStatus || s.capabilityStatus === 'Enabled' || (s.capabilityStatus === 'Warning' && total > 0);
          if (!assignable) return text(name, `${s.capabilityStatus}, ${used} assigned`);
          return total > 0 ? { kind: 'meter', label: name, used, total, unit: 'count' } : num(`${name} (assigned)`, used);
        })
    : [unavailable('Licences', input.skus.reason)];
  if (input.skus.ok && licences.length === 0) licences.push(text('Licences', 'None'));

  const subscriptions: Row[] = input.subscriptions.ok
    ? input.subscriptions.value.slice(0, 40).map((s) => text(skuName(s.skuPartNumber), subscriptionLine(s)))
    : [unavailable('Subscriptions', input.subscriptions.reason)];
  if (input.subscriptions.ok && subscriptions.length === 0) subscriptions.push(text('Subscriptions', 'None'));

  const security: Row[] = [];
  if (!input.secureScore.ok) security.push(unavailable('Secure Score', input.secureScore.reason));
  else if (input.secureScore.value && input.secureScore.value.max > 0) {
    const { current, max } = input.secureScore.value;
    security.push({ kind: 'meter', label: 'Secure Score', used: Math.min(Math.max(current, 0), max), total: max, unit: 'count', higherIsBetter: true });
  }
  if (!input.mfa.ok) security.push(unavailable('MFA coverage', input.mfa.reason));
  else if (input.mfa.value.members > 0) {
    security.push({ kind: 'meter', label: 'MFA coverage (members)', used: input.mfa.value.registered, total: input.mfa.value.members, unit: 'count', higherIsBetter: true });
  }
  if (input.admins.ok) security.push(num('Users with admin roles', input.admins.value.any), num('Global Administrators', input.admins.value.global));
  else security.push(unavailable('Admins', input.admins.reason));

  const storage: Row[] = input.storage.ok
    ? [
        input.storage.value.oneDriveBytes === null ? null : { kind: 'bytes', label: 'OneDrive (all users)', value: input.storage.value.oneDriveBytes },
        input.storage.value.sharePointBytes === null ? null : { kind: 'bytes', label: 'SharePoint', value: input.storage.value.sharePointBytes },
        date('Data as of', input.storage.value.date),
      ]
    : [unavailable('Storage', input.storage.reason)];

  const alerts: Row[] = [];
  if (!input.alerts.ok) alerts.push(unavailable('Alerts', input.alerts.reason));
  else {
    const { items, more } = input.alerts.value;
    const sorted = [...items].sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.severity ?? 'unknownFutureValue') - SEVERITY_ORDER.indexOf(b.severity ?? 'unknownFutureValue') ||
        (b.createdDateTime ?? '').localeCompare(a.createdDateTime ?? ''),
    );
    // A capped page is never presented as the full total.
    alerts.push(more ? text('Alerts (last 30 days)', `More than ${items.length}`) : num('Alerts (last 30 days)', items.length));
    for (const a of sorted.slice(0, ALERTS_SHOWN)) {
      const label = `${a.severity ?? 'unknown'}: ${a.title ?? 'Untitled alert'}`;
      const status = [a.status, a.createdDateTime?.slice(0, 10)].filter(Boolean).join(', ') || 'Open';
      alerts.push(link(label, a.alertWebUrl, status));
    }
  }

  return section([
    group('overview', 'Overview', 'microsoft', overview),
    group('licences', 'Licences assigned vs purchased', 'microsoft', licences),
    group('subscriptions', 'Subscriptions', 'microsoft', subscriptions),
    group('security', 'Security', 'microsoft', security),
    group('storage', 'Storage', 'microsoft', storage),
    group('alerts', 'Recent security alerts', 'microsoft', alerts),
  ]);
}
