import { Logger } from '@nestjs/common';
import { z } from 'zod';
import type {
  DriverDescriptor,
  DriverStandardField,
  IntegrationSetupCheck,
  SourceFieldDto,
  SourceOrgDto,
} from '@weavestream/shared';
import {
  DriverAuthError,
  DriverResourceUnavailableError,
  type DriverDiagnoseInput,
  type FetchRecordsContext,
  type IntegrationContext,
  type IntegrationDriver,
  type LegacyDriverFetchPage,
  type LegacyDriverRecord,
  type RecommendedDestination,
  type RecommendedDestinationField,
} from '../integration-driver.js';
import { assertRecommendedDestinations, fetchWithRetry } from '../driver-utils.js';
import { evictRun, optional as optionalLookup, runCached } from '../run-cache.js';
import type { Lookup } from '../section-rows.js';
import { requireAdminConsent } from '../../oauth/oauth-token.js';
import {
  BATCH_SIZE,
  GRAPH,
  GraphAccessError,
  GraphRequestError,
  MICROSOFT_365_OAUTH,
  assertGraphUrl,
  getOrganization,
  graphBatchGet,
  graphCount,
  graphGet,
  graphListAll,
  graphReportCsv,
  intuneUnavailableMessage,
  type GraphPage,
  type MicrosoftOrganization,
} from './microsoft-365.graph.js';
import {
  buildComputerSection,
  buildGroupSection,
  buildMobileSection,
  buildTenantSection,
  buildUserSection,
  computerStandardFields,
  groupStandardFields,
  isMobileOs,
  mobileStandardFields,
  userEmail,
  userStandardFields,
  type DirectorySubscription,
  type MailboxUsage,
  type ManagedDevice,
  type MicrosoftGroup,
  type MicrosoftUser,
  type OneDriveUsage,
  type SecurityAlert,
  type SubscribedSku,
  type UsageReport,
} from './microsoft-365.sections.js';
import { skuName } from './microsoft-365.skus.js';
import { MICROSOFT_365_SETUP_GUIDE } from './microsoft-365.setup-guide.js';
import { diagnoseMicrosoftClient, diagnoseMicrosoftConnection } from './microsoft-365.diagnose.js';

/**
 * Microsoft 365 driver (read-only, one integration = one Entra tenant,
 * connected by admin consent). Graph v1.0 over app-only tokens minted per
 * tenant with client credentials (see oauth-token.ts); every Graph read is a
 * GET (plus `$batch` of GETs). Records carry the name, the match key and the
 * standard facts that fill layout fields; Microsoft extras go into the
 * section. Licence-dependent data (Entra ID P1, Intune, Defender) degrades
 * to "Not available (needs ...)" rows. Each usage report is fetched once
 * per run (reports are throttled per tenant).
 */

type ResourceKey = 'tenant' | 'users' | 'groups' | 'computers' | 'mobile_devices';

interface ResourceSpec {
  label: string;
  description: string;
  matchField: string;
  matchLabel: string;
  matchType: 'TEXT' | 'EMAIL';
  layoutHints: string[];
  fieldHints: string[];
  layout: RecommendedDestination['layout'];
  standardFields?: DriverStandardField[];
}

const logger = new Logger('Microsoft365Driver');

const MODEL: DriverStandardField = { sourceField: 'model', label: 'Model', fieldType: 'TEXT', fieldHints: ['model'] };
const MANUFACTURER: DriverStandardField = { sourceField: 'manufacturer', label: 'Manufacturer', fieldType: 'TEXT', fieldHints: ['manufacturer', 'make', 'vendor', 'brand'] };
const OS: DriverStandardField = { sourceField: 'operating_system', label: 'Operating system', fieldType: 'TEXT', fieldHints: ['operating_system', 'os'] };

const RESOURCES: Readonly<Record<ResourceKey, ResourceSpec>> = {
  tenant: {
    label: 'Tenant',
    description: 'The Microsoft 365 tenant: licences purchased vs assigned, subscriptions, Secure Score, MFA coverage and recent alerts.',
    matchField: 'tenantId', matchLabel: 'Tenant ID', matchType: 'TEXT',
    layoutHints: ['microsoft_365', 'm365', 'office_365', 'tenant', 'tenants'],
    fieldHints: ['tenant_id', 'tenantid', 'directory_id'],
    layout: { name: 'Microsoft 365 Tenants', slug: 'microsoft_365_tenants', icon: 'building', color: 'blue' },
    standardFields: [
      { sourceField: 'primary_domain', label: 'Primary domain', fieldType: 'TEXT', fieldHints: ['primary_domain', 'domain'] },
    ],
  },
  users: {
    label: 'Users',
    description: 'Members with licences, mailbox and OneDrive storage, sign-in, MFA and admin roles.',
    matchField: 'email', matchLabel: 'Email', matchType: 'EMAIL',
    layoutHints: ['people', 'contacts', 'users', 'staff', 'employees'],
    fieldHints: ['email', 'primary_email', 'e_mail', 'mail', 'upn'],
    layout: { name: 'People', slug: 'people', icon: 'person', color: 'blue' },
    standardFields: [
      { sourceField: 'job_title', label: 'Job title', fieldType: 'TEXT', fieldHints: ['job_title', 'title'] },
      { sourceField: 'department', label: 'Department', fieldType: 'TEXT', fieldHints: ['department'] },
      { sourceField: 'phone', label: 'Phone', fieldType: 'PHONE', fieldHints: ['phone', 'phone_number', 'work_phone'] },
    ],
  },
  groups: {
    label: 'Groups',
    description: 'Mail-enabled groups (Microsoft 365, distribution and mail-enabled security) with their members.',
    matchField: 'email', matchLabel: 'Email', matchType: 'EMAIL',
    layoutHints: ['distribution_lists', 'distribution', 'groups', 'mailing_lists'],
    fieldHints: ['email', 'group_email', 'address'],
    layout: { name: 'Distribution Lists', slug: 'distribution_lists', icon: 'users', color: 'teal' },
    standardFields: [
      { sourceField: 'description', label: 'Description', fieldType: 'TEXTAREA', fieldHints: ['description'] },
    ],
  },
  computers: {
    label: 'Computers',
    description: 'Windows, macOS and Linux devices managed by Intune.',
    matchField: 'serialNumber', matchLabel: 'Serial number', matchType: 'TEXT',
    layoutHints: ['workstations', 'laptops', 'computers', 'desktops', 'devices'],
    fieldHints: ['serial_number', 'serial', 'serialnumber', 'service_tag'],
    layout: { name: 'Workstations', slug: 'workstations', icon: 'laptop', color: 'amber' },
    standardFields: [
      { sourceField: 'hostname', label: 'Hostname', fieldType: 'TEXT', fieldHints: ['hostname', 'host_name', 'computer_name', 'device_name'] },
      MANUFACTURER,
      MODEL,
      OS,
      { sourceField: 'mac_address', label: 'MAC address (Wi-Fi)', fieldType: 'TEXT', fieldHints: ['mac_address', 'mac'] },
    ],
  },
  mobile_devices: {
    label: 'Mobile devices',
    description: 'iOS, iPadOS and Android devices managed by Intune.',
    matchField: 'serialNumber', matchLabel: 'Serial number', matchType: 'TEXT',
    layoutHints: ['phones', 'mobile', 'mobile_devices', 'tablets'],
    fieldHints: ['serial_number', 'serial', 'serialnumber', 'imei'],
    layout: { name: 'Phones', slug: 'phones', icon: 'box', color: 'violet' },
    standardFields: [
      MODEL,
      MANUFACTURER,
      OS,
      { sourceField: 'imei', label: 'IMEI', fieldType: 'TEXT', fieldHints: ['imei'] },
      { sourceField: 'phone_number', label: 'Phone number', fieldType: 'PHONE', fieldHints: ['phone_number', 'phone', 'mobile_number'] },
    ],
  },
};

const RESOURCE_KEYS = Object.keys(RESOURCES) as ResourceKey[];

function destinationField(
  sourceField: string, name: string, fieldType: RecommendedDestinationField['fieldType'], isPrimary: boolean,
): RecommendedDestinationField {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return { sourceField, name, slug, fieldType, syncDirection: 'source_wins', isPrimary, showInTable: true, options: {} };
}

/** "Create a new layout" for each resource: the name and the match key only. */
export const MICROSOFT_365_RECOMMENDED_DESTINATIONS = assertRecommendedDestinations(
  'microsoft-365',
  Object.fromEntries(
    RESOURCE_KEYS.map((key) => {
      const spec = RESOURCES[key];
      return [key, { layout: spec.layout, fields: [destinationField('name', 'Name', 'TEXT', true), destinationField(spec.matchField, spec.matchLabel, spec.matchType, false)] }];
    }),
  ),
);

// ---------------------------------------------------------------------
// Cursor: the Graph @odata.nextLink, opaque to the runner
// ---------------------------------------------------------------------

const cursorSchema = z.object({ next: z.string().min(1).max(8_192) }).strict();

export function encodeCursor(nextLink: string | undefined): string | null {
  return nextLink ? Buffer.from(JSON.stringify({ next: assertGraphUrl(nextLink) }), 'utf8').toString('base64') : null;
}

export function decodeCursor(cursor: string | null): string | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')));
    // Only a Graph link is ever followed with the token.
    return parsed.success && parsed.data.next.startsWith(`${GRAPH}/`) ? parsed.data.next : undefined;
  } catch {
    // A malformed cursor restarts the walk from the first page.
    return undefined;
  }
}

// ---------------------------------------------------------------------
// Lookups (cached per run)
// ---------------------------------------------------------------------

/** Our own fixed-text errors show as is in a "Not available" row. */
function optional<T>(load: () => Promise<T | null>, unavailable: string): Promise<Lookup<T>> {
  return optionalLookup(load, unavailable, (e) => e instanceof GraphAccessError);
}

const GLOBAL_ADMIN_TEMPLATE = '62e90394-69f5-4237-9190-012177145e10';
const REPORT_PERIOD = "(period='D7')";
export const USER_SELECT = 'id,displayName,mail,userPrincipalName,jobTitle,department,businessPhones,mobilePhone,accountEnabled,createdDateTime,userType,onPremisesSyncEnabled,assignedLicenses';
export const DEVICE_SELECT = 'id,deviceName,serialNumber,manufacturer,model,operatingSystem,osVersion,wiFiMacAddress,imei,phoneNumber,complianceState,lastSyncDateTime,enrolledDateTime,userPrincipalName,userDisplayName,managementAgent,isEncrypted,totalStorageSpaceInBytes,freeStorageSpaceInBytes,managedDeviceOwnerType';
const NEEDS_P1 = 'Not available (needs Entra ID P1).';
const NEEDS_DEFENDER = 'Not available (needs Microsoft Defender or a security licence, and SecurityAlert.Read.All).';
const REPORT_UNAVAILABLE = 'Microsoft has not published this usage report yet (reports lag 24 to 72 hours).';

function getSkus(ctx: IntegrationContext): Promise<SubscribedSku[]> {
  return graphListAll<SubscribedSku>(ctx, `${GRAPH}/subscribedSkus`, 'licences');
}

/** P1 probe: sign-in activity is only readable on Entra ID P1 tenants. */
async function probeSignIn(ctx: IntegrationContext): Promise<true> {
  await graphGet(ctx, `${GRAPH}/users?$select=id,signInActivity&$top=1`, 'sign-in activity');
  return true;
}

async function getMfaRegistration(ctx: IntegrationContext): Promise<Array<{ id?: string; isMfaRegistered?: boolean; userType?: string }>> {
  return graphListAll(ctx, `${GRAPH}/reports/authenticationMethods/userRegistrationDetails`, 'MFA registration');
}

/** User id (lowercase) -> activated directory role names. */
async function getRoleMembers(ctx: IntegrationContext): Promise<{ byUser: Map<string, string[]>; global: number }> {
  const roles = await graphListAll<{ id?: string; displayName?: string; roleTemplateId?: string }>(
    ctx,
    `${GRAPH}/directoryRoles?$select=id,displayName,roleTemplateId`,
    'admin roles',
  );
  const byUser = new Map<string, string[]>();
  let global = 0;
  for (const role of roles) {
    if (!role.id) continue;
    const members = await graphListAll<{ id?: string; '@odata.type'?: string }>(
      ctx,
      `${GRAPH}/directoryRoles/${encodeURIComponent(role.id)}/members?$select=id`,
      'admin roles',
    );
    for (const m of members) {
      if (!m.id || (m['@odata.type'] && m['@odata.type'] !== '#microsoft.graph.user')) continue;
      const id = m.id.toLowerCase();
      byUser.set(id, [...(byUser.get(id) ?? []), role.displayName ?? 'Unnamed role']);
      if (role.roleTemplateId === GLOBAL_ADMIN_TEMPLATE) global += 1;
    }
  }
  return { byUser, global };
}

const toNum = (v: string | undefined): number | undefined => {
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Join a report by lowercased UPN; concealed when rows exist but none holds an address. */
function joinReport<T>(rows: Array<Record<string, string>>, upnColumn: string, map: (row: Record<string, string>) => T): UsageReport<T> | null {
  const live = rows.filter((r) => r['Is Deleted']?.toLowerCase() !== 'true');
  if (rows.length === 0) return null;
  const date = rows[0]?.['Report Refresh Date'] || null;
  const concealed = live.length > 0 && !live.some((r) => (r[upnColumn] ?? '').includes('@'));
  const byUpn = new Map<string, T>();
  if (!concealed) for (const r of live) if (r[upnColumn]) byUpn.set(r[upnColumn]!.toLowerCase(), map(r));
  return { date, concealed, byUpn };
}

async function getMailboxReport(ctx: IntegrationContext): Promise<UsageReport<MailboxUsage> | null> {
  const rows = await graphReportCsv(ctx, `getMailboxUsageDetail${REPORT_PERIOD}`, 'the mailbox usage report');
  return joinReport(rows, 'User Principal Name', (r) => ({
    usedBytes: toNum(r['Storage Used (Byte)']),
    quotaBytes: toNum(r['Prohibit Send/Receive Quota (Byte)']),
    hasArchive: r['Has Archive'] ? r['Has Archive'].toLowerCase() === 'true' : undefined,
  }));
}

async function getOneDriveReport(ctx: IntegrationContext): Promise<UsageReport<OneDriveUsage> | null> {
  const rows = await graphReportCsv(ctx, `getOneDriveUsageAccountDetail${REPORT_PERIOD}`, 'the OneDrive usage report');
  return joinReport(rows, 'Owner Principal Name', (r) => ({
    usedBytes: toNum(r['Storage Used (Byte)']),
    allocatedBytes: toNum(r['Storage Allocated (Byte)']),
  }));
}

async function getSharePointStorage(ctx: IntegrationContext): Promise<{ bytes: number; date: string } | null> {
  const rows = await graphReportCsv(ctx, `getSharePointSiteUsageStorage${REPORT_PERIOD}`, 'the SharePoint storage report');
  const latest = rows
    .filter((r) => r['Report Date'] && toNum(r['Storage Used (Byte)']) !== undefined)
    .sort((a, b) => (b['Report Date'] ?? '').localeCompare(a['Report Date'] ?? ''))[0];
  return latest ? { bytes: toNum(latest['Storage Used (Byte)'])!, date: latest['Report Date']! } : null;
}

/**
 * Shared mailboxes among `users` (lowercased ids), via
 * mailboxSettings/userPurpose in `$batch` requests of 20. A user without a
 * mailbox answers 404 and is simply not shared; a denied permission makes
 * the whole lookup unavailable.
 */
export async function getSharedMailboxes(ctx: IntegrationContext, users: MicrosoftUser[]): Promise<Set<string>> {
  const shared = new Set<string>();
  const ids = users.filter((u) => u.id && u.mail).map((u) => u.id!);
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const chunk = ids.slice(i, i + BATCH_SIZE);
    const answers = await graphBatchGet<{ value?: unknown }>(
      ctx,
      chunk.map((id, n) => ({ id: String(n), url: `/users/${encodeURIComponent(id)}/mailboxSettings/userPurpose` })),
      'mailbox settings',
    );
    if (answers.length > 0 && answers.every((a) => a.status === 401 || a.status === 403)) {
      throw new GraphAccessError('Not available (needs MailboxSettings.Read).');
    }
    for (const a of answers) {
      if (a.status === 200 && a.body?.value === 'shared') shared.add(chunk[Number(a.id)]!.toLowerCase());
    }
  }
  return shared;
}

/** Members of one group (first 50) and the total, both in one request. */
async function groupMembers(ctx: IntegrationContext, groupId: string): Promise<{ count: number | null; shown: string[] }> {
  const body = await graphGet<GraphPage<{ mail?: string | null; userPrincipalName?: string; displayName?: string }> & { '@odata.count'?: number }>(
    ctx,
    `${GRAPH}/groups/${encodeURIComponent(groupId)}/members?$select=mail,userPrincipalName,displayName&$top=50&$count=true`,
    'group members',
    { ConsistencyLevel: 'eventual' },
  );
  const shown = (body.value ?? [])
    .map((m) => m.mail || m.userPrincipalName || m.displayName)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  const count = typeof body['@odata.count'] === 'number' ? body['@odata.count'] : body['@odata.nextLink'] ? null : shown.length;
  return { count, shown };
}

// ---------------------------------------------------------------------
// Domains (built-in Domains monitoring)
// ---------------------------------------------------------------------

/** One verified Microsoft 365 domain as Domains monitoring stores it. */
export interface MicrosoftDomain {
  /** Lowercased, trimmed, no trailing dot. */
  hostname: string;
  isDefault: boolean;
  authType: 'MANAGED' | 'FEDERATED';
  services: string[];
}

export function normalizeDomainName(name: string): string {
  return name.trim().toLowerCase().replace(/\.+$/, '');
}

/**
 * Verified custom domains of the tenant `externalOrgId`. Throws when the
 * connection belongs to another tenant, so one mapping never feeds another
 * tenant's domains. The initial `*.onmicrosoft.com` domain (and any other
 * onmicrosoft.com name) and unverified domains are left out.
 */
export async function listMicrosoftDomains(ctx: IntegrationContext, externalOrgId: string): Promise<MicrosoftDomain[]> {
  await assertTenant(ctx, externalOrgId);
  const domains = await graphListAll<{
    id?: string;
    isDefault?: boolean;
    isInitial?: boolean;
    isVerified?: boolean;
    authenticationType?: string;
    supportedServices?: string[];
  }>(ctx, `${GRAPH}/domains`, 'domains');
  const out = new Map<string, MicrosoftDomain>();
  for (const d of domains) {
    if (!d.id || d.isVerified !== true || d.isInitial === true) continue;
    const hostname = normalizeDomainName(d.id);
    if (!hostname || hostname.endsWith('.onmicrosoft.com') || out.has(hostname)) continue;
    out.set(hostname, {
      hostname,
      isDefault: d.isDefault === true,
      authType: d.authenticationType?.toLowerCase() === 'federated' ? 'FEDERATED' : 'MANAGED',
      services: (d.supportedServices ?? []).filter((s): s is string => typeof s === 'string').slice(0, 20).map((s) => s.slice(0, 64)),
    });
  }
  return [...out.values()];
}

const WRONG_TENANT =
  'This Microsoft connection belongs to a different tenant than the mapped one. Reconnect with a Global Administrator of the mapped tenant.';

/** Tenant isolation: the stored consent and Graph's own answer must both be the mapped tenant. */
async function assertTenant(ctx: IntegrationContext, externalOrgId: string, org?: MicrosoftOrganization & { id: string }): Promise<MicrosoftOrganization & { id: string }> {
  const stored = requireAdminConsent(ctx);
  const mapped = externalOrgId.toLowerCase();
  if (stored.tenantId !== mapped) throw new DriverAuthError(WRONG_TENANT);
  const actual = org ?? (await getOrganization(ctx));
  if (actual.id.toLowerCase() !== mapped) throw new DriverAuthError(WRONG_TENANT);
  return actual;
}

function primaryDomain(org: MicrosoftOrganization): string | undefined {
  const domains = org.verifiedDomains ?? [];
  return (domains.find((d) => d.isDefault) ?? domains.find((d) => d.isInitial))?.name;
}

function record(key: ResourceKey, externalId: string, name: string, matchValue: string | undefined, section: unknown, extra: Record<string, unknown> = {}): LegacyDriverRecord {
  return {
    externalId,
    displayName: name,
    fields: { name, [RESOURCES[key].matchField]: matchValue ?? null, ...extra },
    section,
    updatedAt: null,
  };
}

export class Microsoft365Driver implements IntegrationDriver {
  readonly key = 'microsoft-365';

  readonly recommendedDestinations = MICROSOFT_365_RECOMMENDED_DESTINATIONS;

  readonly descriptor: DriverDescriptor = {
    key: 'microsoft-365',
    label: 'Microsoft 365',
    description:
      'Read-only sync of a Microsoft 365 tenant by admin consent: names, job titles, device models, OS and serials fill layout fields; licences, storage, sign-in, MFA, Intune compliance and tenant security show on the asset page.',
    iconKey: null,
    configFields: [],
    secretFields: [],
    oauth: MICROSOFT_365_OAUTH,
    setupGuide: MICROSOFT_365_SETUP_GUIDE,
    resources: RESOURCE_KEYS.map((key) => {
      const spec = RESOURCES[key];
      return {
        key,
        label: spec.label,
        description: spec.description,
        defaultMatchKeyHint: spec.matchField,
        targetKind: 'asset' as const,
        targetConfig: {},
        dependsOnResourceKeys: [],
        matchSuggestions: { sourceField: spec.matchField, layoutHints: spec.layoutHints, fieldHints: spec.fieldHints, fieldLabel: spec.matchLabel },
        minimalFields: ['name', spec.matchField],
        ...(spec.standardFields ? { standardFields: spec.standardFields } : {}),
      };
    }),
    capabilities: {
      kind: 'pull',
      listSourceOrgs: true,
      dryRun: true,
      ticketing: false,
      reconstructionCompleteness: false,
    },
  };

  diagnose(input: DriverDiagnoseInput): Promise<IntegrationSetupCheck> {
    return input.mode === 'client' ? diagnoseMicrosoftClient(input) : diagnoseMicrosoftConnection(input.ctx);
  }

  /** Re-read the consented tenant with the fresh token; the id must match, the name is shown. */
  async verifyConsentedTenant(input: {
    accessToken: string;
    tenantId: string;
    http: IntegrationContext['http'];
    correlationId: string;
  }): Promise<{ tenantName: string | null }> {
    const res = await fetchWithRetry(`${GRAPH}/organization?$select=id,displayName`, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${input.accessToken}` },
      redirect: 'error',
      ...input.http,
      correlationId: input.correlationId,
      serviceName: 'Microsoft 365',
    });
    if (!res.ok) throw new GraphRequestError(`Reading the tenant failed (HTTP ${res.status}).`, res.status, null);
    const org = ((await res.json()) as GraphPage<MicrosoftOrganization>).value?.[0];
    if (!org?.id || org.id.toLowerCase() !== input.tenantId.toLowerCase()) {
      throw new GraphRequestError('The token belongs to a different tenant.', res.status, null);
    }
    return { tenantName: typeof org.displayName === 'string' ? org.displayName : null };
  }

  async testConnection(ctx: IntegrationContext): Promise<{ ok: true; details?: string }> {
    const org = await getOrganization(ctx);
    return { ok: true, details: `Connected to the Microsoft 365 tenant ${org.displayName ?? org.id}.` };
  }

  async listSourceOrgs(ctx: IntegrationContext): Promise<SourceOrgDto[]> {
    const stored = requireAdminConsent(ctx);
    const org = await assertTenant(ctx, stored.tenantId);
    return [{ externalId: org.id.toLowerCase(), name: org.displayName ?? primaryDomain(org) ?? org.id, hint: primaryDomain(org) ?? null }];
  }

  async listSourceFields(ctx: IntegrationContext & { externalOrgId: string; resourceKey: string }): Promise<SourceFieldDto[]> {
    const spec = RESOURCES[ctx.resourceKey as ResourceKey];
    if (!spec) return [];
    const fields: SourceFieldDto[] = [
      { key: 'name', label: 'Name', hintType: 'TEXT', alwaysPresent: true },
      { key: spec.matchField, label: spec.matchLabel, hintType: spec.matchType, alwaysPresent: ctx.resourceKey !== 'computers' && ctx.resourceKey !== 'mobile_devices' },
    ];
    for (const field of spec.standardFields ?? []) {
      fields.push({
        key: field.sourceField,
        label: field.label,
        hintType: field.fieldType === 'TEXTAREA' ? field.fieldType : 'TEXT',
        alwaysPresent: false,
      });
    }
    return fields;
  }

  async fetchRecords(ctx: FetchRecordsContext, cursor: string | null): Promise<LegacyDriverFetchPage> {
    const key = ctx.resourceKey as ResourceKey;
    if (!RESOURCES[key]) throw new Error(`Unknown Microsoft 365 resource: ${ctx.resourceKey}`);
    const snapshotAt = ctx.snapshotAt ?? new Date().toISOString();
    // Tenant isolation: the app-only token may only feed the tenant it is mapped to.
    const org = await runCached(ctx, snapshotAt, 'org', () => getOrganization(ctx));
    await assertTenant(ctx, ctx.externalOrgId, org);
    const page = await this.fetchPage(key, ctx, org, snapshotAt, decodeCursor(cursor));
    const next = encodeCursor(page.nextLink);
    if (next === null) evictRun(ctx, snapshotAt);
    return {
      records: page.records,
      hasMore: next !== null,
      cursor: next,
      snapshotAt,
    };
  }

  private async fetchPage(
    key: ResourceKey,
    ctx: FetchRecordsContext,
    org: MicrosoftOrganization & { id: string },
    snapshotAt: string,
    nextLink: string | undefined,
  ): Promise<{ records: LegacyDriverRecord[]; nextLink?: string }> {
    const nowMs = Date.parse(snapshotAt);
    const cached = <T>(name: string, load: () => Promise<T>) => runCached(ctx, snapshotAt, name, load);
    const skus = () => cached('skus', () => optional(() => getSkus(ctx), 'Licence data is not available.'));
    const signIn = () => cached('p1', () => optional(() => probeSignIn(ctx), NEEDS_P1));
    const mfa = () => cached('mfa', () => optional(() => getMfaRegistration(ctx), NEEDS_P1));
    const roles = () => cached('roles', () => optional(() => getRoleMembers(ctx), 'Admin roles are not available.'));
    const oneDrive = () => cached('onedrive', () => optional(() => getOneDriveReport(ctx), REPORT_UNAVAILABLE));

    switch (key) {
      case 'tenant': {
        const since = new Date(nowMs - 30 * 86_400_000).toISOString();
        const count = (filter: string) => graphCount(ctx, `${GRAPH}/users/$count?$filter=${encodeURIComponent(filter)}`, 'user counts');
        const [skuLookup, mfaLookup, roleLookup, oneDriveLookup] = await Promise.all([skus(), mfa(), roles(), oneDrive()]);
        const sharePoint = await optional(() => getSharePointStorage(ctx), REPORT_UNAVAILABLE);
        const section = buildTenantSection({
          createdAt: org.createdDateTime,
          counts: await optional(async () => ({
            members: await count("userType eq 'Member'"),
            disabled: await count("accountEnabled eq false and userType eq 'Member'"),
            guests: await count("userType eq 'Guest'"),
          }), 'User counts are not available.'),
          skus: skuLookup,
          subscriptions: await optional(
            () => graphListAll<DirectorySubscription>(ctx, `${GRAPH}/directory/subscriptions`, 'subscriptions'),
            'Subscriptions are not available.',
          ),
          secureScore: await optional(async () => {
            const body = await graphGet<GraphPage<{ currentScore?: number; maxScore?: number }>>(ctx, `${GRAPH}/security/secureScores?$top=1`, 'Secure Score');
            const s = body.value?.[0];
            return { value: s && typeof s.currentScore === 'number' && typeof s.maxScore === 'number' ? { current: s.currentScore, max: s.maxScore } : null };
          }, 'Secure Score is not available (needs SecurityEvents.Read.All).').then((l) => (l.ok ? { ok: true as const, value: l.value.value } : l)),
          mfa: mfaLookup.ok
            ? {
                ok: true,
                value: {
                  registered: mfaLookup.value.filter((m) => m.userType?.toLowerCase() !== 'guest' && m.isMfaRegistered === true).length,
                  members: mfaLookup.value.filter((m) => m.userType?.toLowerCase() !== 'guest').length,
                },
              }
            : mfaLookup,
          admins: roleLookup.ok ? { ok: true, value: { any: roleLookup.value.byUser.size, global: roleLookup.value.global } } : roleLookup,
          storage: {
            ok: true,
            value: {
              // A concealed report has no per-user rows to sum: leave the total out rather than show 0.
              oneDriveBytes: oneDriveLookup.ok && !oneDriveLookup.value.concealed
                ? [...oneDriveLookup.value.byUpn.values()].reduce((sum, o) => sum + (o.usedBytes ?? 0), 0)
                : null,
              sharePointBytes: sharePoint.ok ? sharePoint.value.bytes : null,
              date: (sharePoint.ok ? sharePoint.value.date : null) ?? (oneDriveLookup.ok ? oneDriveLookup.value.date : null),
            },
          },
          alerts: await optional(
            () =>
              graphGet<GraphPage<SecurityAlert>>(
                ctx,
                `${GRAPH}/security/alerts_v2?$filter=${encodeURIComponent(`createdDateTime ge ${since}`)}&$top=50`,
                'security alerts',
              ).then((b) => ({ items: b.value ?? [], more: Boolean(b['@odata.nextLink']) })),
            NEEDS_DEFENDER,
          ),
        });
        const domain = primaryDomain(org);
        const tenantId = org.id.toLowerCase();
        return { records: [record(key, tenantId, org.displayName || domain || tenantId, tenantId, section, domain ? { primary_domain: domain } : {})] };
      }
      case 'users': {
        const signInLookup = await signIn();
        const url = nextLink ?? `${GRAPH}/users?$select=${USER_SELECT}${signInLookup.ok ? ',signInActivity' : ''}&$top=${signInLookup.ok ? 500 : 999}`;
        const body = await graphGet<GraphPage<MicrosoftUser>>(ctx, url, 'users');
        // Members only: guests are other organisations' people.
        const users = (body.value ?? []).filter((u) => u.id && userEmail(u) && u.userType?.toLowerCase() !== 'guest');
        const [skuLookup, mfaLookup, roleLookup, mailbox, oneDriveLookup] = await Promise.all([
          skus(),
          mfa(),
          roles(),
          cached('mailbox', () => optional(() => getMailboxReport(ctx), REPORT_UNAVAILABLE)),
          oneDrive(),
        ]);
        const sharedMailboxes = await optional(() => getSharedMailboxes(ctx, users), 'Not available (needs MailboxSettings.Read).');
        const lookups = {
          skuNames: skuLookup.ok
            ? { ok: true as const, value: new Map(skuLookup.value.filter((s) => s.skuId).map((s) => [s.skuId!.toLowerCase(), skuName(s.skuPartNumber)])) }
            : skuLookup,
          signIn: signInLookup,
          mfa: mfaLookup.ok
            ? { ok: true as const, value: new Map(mfaLookup.value.filter((m) => m.id).map((m) => [m.id!.toLowerCase(), m.isMfaRegistered === true])) }
            : mfaLookup,
          roles: roleLookup.ok ? { ok: true as const, value: roleLookup.value.byUser } : roleLookup,
          sharedMailboxes,
          mailbox,
          oneDrive: oneDriveLookup,
        };
        const records = users.map((u) =>
          record(key, u.id!, u.displayName || userEmail(u)!, userEmail(u), buildUserSection(u, lookups, nowMs), userStandardFields(u)),
        );
        return { records, nextLink: body['@odata.nextLink'] };
      }
      case 'groups': {
        const url = nextLink ?? `${GRAPH}/groups?$filter=${encodeURIComponent('mailEnabled eq true')}&$select=id,displayName,mail,description,groupTypes,mailEnabled,securityEnabled&$top=999`;
        const body = await graphGet<GraphPage<MicrosoftGroup>>(ctx, url, 'groups');
        const records: LegacyDriverRecord[] = [];
        for (const g of body.value ?? []) {
          if (!g.id || !g.mail) continue;
          const members = await groupMembers(ctx, g.id);
          records.push(record(key, g.id, g.displayName || g.mail, g.mail, buildGroupSection(g, members), groupStandardFields(g)));
        }
        return { records, nextLink: body['@odata.nextLink'] };
      }
      case 'computers':
      case 'mobile_devices': {
        const url = nextLink ?? `${GRAPH}/deviceManagement/managedDevices?$select=${DEVICE_SELECT}&$top=999`;
        let body: GraphPage<ManagedDevice>;
        try {
          body = await graphGet<GraphPage<ManagedDevice>>(ctx, url, 'Intune devices');
        } catch (e) {
          // An identified missing Intune licence or permission skips the
          // resource with a run warning; any other Graph error fails the run.
          const unavailable = nextLink ? null : intuneUnavailableMessage(e, requireAdminConsent(ctx).grantedRoles);
          if (unavailable) throw new DriverResourceUnavailableError(unavailable);
          if (e instanceof GraphRequestError || e instanceof GraphAccessError) {
            const code = e instanceof GraphRequestError ? e.code : e.graphCode;
            logger.warn(`Intune devices read failed: HTTP ${e.status ?? 'unknown'}, Graph code ${code ?? 'none'}`);
          }
          throw e;
        }
        const mobile = key === 'mobile_devices';
        const records = (body.value ?? [])
          .filter((d) => d.id && isMobileOs(d.operatingSystem) === mobile)
          .map((d) => {
            const name = d.deviceName || [d.model, d.serialNumber].filter(Boolean).join(' ') || d.id!;
            return mobile
              ? record(key, d.id!, name, d.serialNumber ?? undefined, buildMobileSection(d), mobileStandardFields(d))
              : record(key, d.id!, name, d.serialNumber ?? undefined, buildComputerSection(d), computerStandardFields(d));
          });
        return { records, nextLink: body['@odata.nextLink'] };
      }
    }
  }
}
