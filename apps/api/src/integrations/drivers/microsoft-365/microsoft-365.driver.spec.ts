import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { driverDescriptorSchema, integrationSectionSchema, type IntegrationSection } from '@weavestream/shared';
import { DriverAuthError, DriverResourceUnavailableError, type FetchRecordsContext, type IntegrationContext, type LegacyDriverRecord } from '../integration-driver.js';
import { setDefaultFetchForTests, setDefaultResolveForTests } from '../../../common/egress/safe-fetch.js';
import { __resetOAuthAccessTokenCacheForTests } from '../../oauth/oauth-token.js';
import { __resetRunCacheForTests, __runCacheSizeForTests } from '../run-cache.js';
import {
  MICROSOFT_365_RECOMMENDED_DESTINATIONS,
  Microsoft365Driver,
  decodeCursor,
  encodeCursor,
  listMicrosoftDomains,
} from './microsoft-365.driver.js';
import { GraphRequestError, MICROSOFT_PERMISSIONS, MICROSOFT_REQUIRED_PERMISSIONS, graphReportCsv } from './microsoft-365.graph.js';
import { writeReportConcealment } from './microsoft-365.report-settings.js';
import { CONCEALED_NOTE } from './microsoft-365.sections.js';
import { INTUNE_UNREADABLE_NOTE, OPTIONAL_WRITE_NOTE, diagnoseMicrosoftClient, diagnoseMicrosoftConnection } from './microsoft-365.diagnose.js';

/** Graph's answer for a tenant without an Intune licence (learn.microsoft.com/en-us/answers/questions/1063413). */
const NOT_LICENSED = { status: 400, body: { error: { code: 'BadRequest', message: 'Request not applicable to target tenant.' } } };

/** Graph's answer on managedDevices for an unlicensed tenant that granted the Intune permission (seen live). */
const UNLICENSED_401 = { status: 401, body: { error: { code: 'UnknownError', message: '' } } };
/** A genuine token problem: must never be read as "unlicensed". */
const TOKEN_401 = { status: 401, body: { error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired.' } } };
const WITHOUT_INTUNE = (roles: readonly string[]) => roles.filter((p) => p !== 'DeviceManagementManagedDevices.Read.All');

const G = 'https://graph.microsoft.com/v1.0';
const TENANT = '11111111-2222-4333-8444-555555555555';
const OTHER_TENANT = '99999999-2222-4333-8444-555555555555';
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const CSV_HOST = 'https://reportsncu.office.com';
const SNAPSHOT = '2026-10-08T12:00:00.000Z';
const U1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const U2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const U3 = 'aaaaaaaa-0000-4000-8000-000000000003';
const SKU_BP = 'cbdc14ab-d96c-4c30-b9f4-6ada7cdc1d46';

type Reply = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> };
type Entry = Reply | ((url: string, init?: RequestInit) => Reply);

interface Call {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
}

/**
 * Scripted fetch table: the longest key that prefixes the URL answers it;
 * an unscripted URL throws. DNS is stubbed to a public IP so the egress
 * guard stays on but never touches the network.
 */
function installFetchTable(table: Record<string, Entry>) {
  const calls: Call[] = [];
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  setDefaultFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    const key = keys.find((k) => url.startsWith(k));
    if (!key) throw new Error(`Microsoft 365 driver test: unscripted fetch to ${url}`);
    const entry = table[key]!;
    const reply = typeof entry === 'function' ? entry(url, init) : entry;
    const body = reply.text ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
    return new Response(reply.status && [204, 302].includes(reply.status) ? null : body, {
      status: reply.status ?? 200,
      headers: { 'content-type': reply.text !== undefined ? 'text/plain' : 'application/json', ...(reply.headers ?? {}) },
    });
  }) as typeof fetch);
  setDefaultResolveForTests(async () => ['1.2.3.4']);
  return calls;
}

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

const ORG = {
  value: [{
    id: TENANT,
    displayName: 'Contoso',
    createdDateTime: '2020-01-02T03:04:05Z',
    verifiedDomains: [
      { name: 'contoso.onmicrosoft.com', isInitial: true, isDefault: false },
      { name: 'contoso.example', isInitial: false, isDefault: true },
    ],
  }],
};

const USERS_PAGE_1 = {
  value: [
    {
      id: U1, displayName: 'User One', mail: 'one@contoso.example', userPrincipalName: 'one@contoso.example',
      jobTitle: 'Engineer', department: 'IT', businessPhones: ['+1 425 555 0100'], accountEnabled: true,
      createdDateTime: '2021-01-01T00:00:00Z', userType: 'Member', onPremisesSyncEnabled: true,
      assignedLicenses: [{ skuId: SKU_BP }],
      signInActivity: { lastSignInDateTime: '2026-10-01T00:00:00Z', lastNonInteractiveSignInDateTime: '2026-10-05T00:00:00Z' },
    },
    { id: 'guest-1', displayName: 'Guest', mail: 'guest@fabrikam.example', userPrincipalName: 'guest_fabrikam.example#EXT#@contoso.onmicrosoft.com', userType: 'Guest' },
  ],
  '@odata.nextLink': `${G}/users?$skiptoken=page2`,
};
const USERS_PAGE_2 = {
  value: [
    {
      id: U2, displayName: 'Shared Desk', mail: 'desk@contoso.example', userPrincipalName: 'desk@contoso.example',
      accountEnabled: true, createdDateTime: '2021-01-01T00:00:00Z', userType: 'Member',
      assignedLicenses: [{ skuId: SKU_BP }], signInActivity: null,
    },
    {
      id: U3, displayName: 'No Mail', mail: null, userPrincipalName: 'nomail@contoso.example', mobilePhone: '+1 425 555 0199',
      accountEnabled: false, createdDateTime: '2021-01-01T00:00:00Z', userType: 'Member', assignedLicenses: [{ skuId: SKU_BP }],
    },
  ],
};

const MAILBOX_CSV =
  '﻿Report Refresh Date,User Principal Name,Display Name,Is Deleted,Storage Used (Byte),Prohibit Send/Receive Quota (Byte),Has Archive\r\n' +
  '2026-10-06,ONE@contoso.example,User One,False,1073741824,53687091200,True\r\n' +
  '2026-10-06,old@contoso.example,Old,True,5,10,False\r\n';
const CONCEALED_CSV =
  '﻿Report Refresh Date,User Principal Name,Display Name,Is Deleted,Storage Used (Byte),Prohibit Send/Receive Quota (Byte),Has Archive\r\n' +
  '2026-10-06,7B8F2C1A9D3E4F5A6B7C8D9E0F1A2B3C,7B8F2C1A9D3E4F5A6B7C8D9E0F1A2B3C,False,1073741824,53687091200,False\r\n';
const ONEDRIVE_CSV =
  'Report Refresh Date,Site URL,Owner Display Name,Is Deleted,Storage Used (Byte),Storage Allocated (Byte),Owner Principal Name\n' +
  '2026-10-06,"https://contoso-my.sharepoint.com/personal/one, x",User One,False,2048,1099511627776,one@contoso.example\n';
const SHAREPOINT_CSV =
  'Report Refresh Date,Site Type,Storage Used (Byte),Report Date,Report Period\n2026-10-06,All,500,2026-10-05,7\n2026-10-06,All,700,2026-10-06,7\n';

function baseTable(overrides: Record<string, Entry> = {}): Record<string, Entry> {
  return {
    [TOKEN_URL]: { body: { access_token: jwt({ tid: TENANT, roles: MICROSOFT_PERMISSIONS }), expires_in: 3600 } },
    [`${G}/organization`]: { body: ORG },
    [`${G}/users?$select=id,signInActivity`]: { body: { value: [] } },
    [`${G}/users?$select=id,displayName`]: { body: USERS_PAGE_1 },
    [`${G}/users?$skiptoken=page2`]: { body: USERS_PAGE_2 },
    [`${G}/subscribedSkus`]: {
      body: { value: [
        { skuId: SKU_BP, skuPartNumber: 'SPB', capabilityStatus: 'Enabled', consumedUnits: 3, prepaidUnits: { enabled: 5 } },
        { skuId: 'x', skuPartNumber: 'CONTOSO_CUSTOM_SKU', capabilityStatus: 'Suspended', consumedUnits: 1, prepaidUnits: { enabled: 0 } },
        { skuId: 'y', skuPartNumber: 'WIN_DEF_ATP', capabilityStatus: 'Enabled', consumedUnits: 3, prepaidUnits: { enabled: 2, warning: 1 } },
        { skuId: 'z', skuPartNumber: 'INTUNE_A', capabilityStatus: 'Warning', consumedUnits: 2, prepaidUnits: { enabled: 0, warning: 4 } },
      ] },
    },
    [`${G}/reports/authenticationMethods/userRegistrationDetails`]: {
      body: { value: [{ id: U1, isMfaRegistered: true, userType: 'member' }, { id: U2, isMfaRegistered: false, userType: 'member' }] },
    },
    [`${G}/directoryRoles?`]: { body: { value: [{ id: 'role-ga', displayName: 'Global Administrator', roleTemplateId: '62e90394-69f5-4237-9190-012177145e10' }] } },
    [`${G}/directoryRoles/role-ga/members`]: { body: { value: [{ id: U1, '@odata.type': '#microsoft.graph.user' }, { id: 'sp-1', '@odata.type': '#microsoft.graph.servicePrincipal' }] } },
    [`${G}/reports/getMailboxUsageDetail`]: { status: 302, headers: { location: `${CSV_HOST}/mailbox.csv?sig=abc` } },
    [`${CSV_HOST}/mailbox.csv`]: { text: MAILBOX_CSV },
    [`${G}/reports/getOneDriveUsageAccountDetail`]: { text: ONEDRIVE_CSV },
    [`${G}/reports/getSharePointSiteUsageStorage`]: { text: SHAREPOINT_CSV },
    [`${G}/$batch`]: (_url, init) => {
      const { requests } = JSON.parse(String(init?.body)) as { requests: Array<{ id: string; method: string; url: string }> };
      return {
        body: {
          responses: requests.map((r) => ({
            id: r.id,
            status: r.url.includes(U1) || r.url.includes(U2) ? 200 : 404,
            body: { value: r.url.includes(U2) ? 'shared' : 'user' },
          })),
        },
      };
    },
    [`${G}/users/$count`]: (url) => ({ text: url.includes('Guest') ? '4' : url.includes('accountEnabled') ? '1' : '12' }),
    [`${G}/directory/subscriptions`]: {
      body: { value: [{ skuPartNumber: 'SPB', status: 'Enabled', totalLicenses: 5, isTrial: false, nextLifecycleDateTime: '2027-01-31T00:00:00Z' }] },
    },
    [`${G}/security/secureScores`]: { body: { value: [{ currentScore: 41.5, maxScore: 83 }] } },
    [`${G}/security/alerts_v2`]: {
      body: { value: [
        { title: 'Suspicious sign-in', severity: 'medium', status: 'new', createdDateTime: '2026-10-07T00:00:00Z', alertWebUrl: 'https://security.microsoft.com/alerts/1' },
        { title: 'Malware detected', severity: 'high', status: 'inProgress', createdDateTime: '2026-10-06T00:00:00Z', alertWebUrl: 'javascript:alert(1)' },
      ] },
    },
    [`${G}/groups?`]: {
      body: { value: [
        { id: 'g1', displayName: 'Sales', mail: 'sales@contoso.example', description: 'Sales team', groupTypes: ['Unified'], mailEnabled: true, securityEnabled: false },
        { id: 'g2', displayName: 'No mail', mail: null, mailEnabled: true },
      ] },
    },
    [`${G}/groups/g1/members`]: { body: { value: [{ mail: 'one@contoso.example' }], '@odata.count': 7 } },
    [`${G}/deviceManagement/managedDevices`]: {
      body: { value: [
        { id: 'd1', deviceName: 'CONTOSO-LT1', serialNumber: 'SN-1', manufacturer: 'Contoso Devices', model: 'Book 14', operatingSystem: 'Windows', osVersion: '10.0.22631', wiFiMacAddress: '0011AABBCCDD', complianceState: 'compliant', totalStorageSpaceInBytes: 1000, freeStorageSpaceInBytes: 250, isEncrypted: true, userPrincipalName: 'one@contoso.example', managementAgent: 'mdm' },
        { id: 'd2', deviceName: 'Phone', serialNumber: 'SN-2', manufacturer: 'Contoso', model: 'Phone 9', operatingSystem: 'iOS', osVersion: '18.1', imei: '351234567890123', phoneNumber: '+1 425 555 0111', complianceState: 'noncompliant' },
        { id: 'd3', deviceName: 'Mac', serialNumber: 'SN-3', operatingSystem: 'macOS', osVersion: '15.0' },
        { id: 'd4', deviceName: 'Tab', serialNumber: 'SN-4', operatingSystem: 'Android', osVersion: '15' },
      ] },
    },
    [`${G}/domains`]: {
      body: { value: [
        { id: 'contoso.onmicrosoft.com', isInitial: true, isVerified: true, isDefault: false, authenticationType: 'Managed', supportedServices: ['Email'] },
        { id: 'Contoso.Example.', isInitial: false, isVerified: true, isDefault: true, authenticationType: 'Federated', supportedServices: ['Email', 'OfficeCommunicationsOnline'] },
        { id: 'unverified.example', isInitial: false, isVerified: false },
        { id: 'legacy.mail.onmicrosoft.com', isInitial: false, isVerified: true },
      ] },
    },
    ...overrides,
  };
}

let seq = 0;
function makeCtx(tenantId = TENANT): IntegrationContext {
  seq += 1;
  return {
    config: {},
    secret: { tenantId, grantedRoles: MICROSOFT_PERMISSIONS, consentedAt: '2026-10-01T00:00:00.000Z' },
    oauthClient: { clientId: 'client-1', clientSecret: 'client-secret-1' },
    integrationId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    credentialVersion: `v${seq}`,
    correlationId: 'corr-1',
    http: { timeoutMs: 5_000, maxRetries: 0, backoffMs: 1 },
  };
}

function fetchCtx(base: IntegrationContext, resourceKey: string, externalOrgId = TENANT): FetchRecordsContext {
  return { ...base, externalOrgId, resourceKey, filter: {}, mode: 'full', updatedSince: null, snapshotAt: SNAPSHOT };
}

function sectionOf(rec: LegacyDriverRecord): IntegrationSection {
  const parsed = integrationSectionSchema.safeParse(rec.section);
  if (!parsed.success) throw new Error(`invalid section: ${parsed.error.message}`);
  return parsed.data;
}

function rows(rec: LegacyDriverRecord, groupKey: string) {
  return sectionOf(rec).groups.find((g) => g.key === groupKey)?.rows ?? [];
}
function rowOf(rec: LegacyDriverRecord, groupKey: string, label: string) {
  return rows(rec, groupKey).find((r) => r.label === label);
}

async function walk(driver: Microsoft365Driver, ctx: FetchRecordsContext) {
  const records: LegacyDriverRecord[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await driver.fetchRecords(ctx, cursor);
    records.push(...(page.records as LegacyDriverRecord[]));
    cursor = page.cursor;
    pages += 1;
  } while (cursor && pages < 10);
  return { records, pages };
}

const driver = new Microsoft365Driver();

beforeEach(() => {
  __resetOAuthAccessTokenCacheForTests();
  __resetRunCacheForTests();
});
afterEach(() => {
  setDefaultFetchForTests(null);
  setDefaultResolveForTests(null);
});

describe('Microsoft365Driver descriptor', () => {
  it('passes the shared descriptor schema with admin consent and the exact permission list', () => {
    expect(driverDescriptorSchema.safeParse(driver.descriptor).success).toBe(true);
    expect(driver.descriptor.label).toBe('Microsoft 365');
    expect(driver.descriptor.oauth).toMatchObject({
      provider: 'microsoft',
      consentFlow: 'admin_consent',
      authorizeUrl: 'https://login.microsoftonline.com/organizations/v2.0/adminconsent',
      clientCredentialsScope: 'https://graph.microsoft.com/.default',
    });
    expect([...MICROSOFT_PERMISSIONS].sort()).toEqual([
      'AuditLog.Read.All', 'DeviceManagementManagedDevices.Read.All', 'Domain.Read.All', 'GroupMember.Read.All',
      'LicenseAssignment.Read.All', 'MailboxSettings.Read', 'Organization.Read.All', 'ReportSettings.Read.All', 'ReportSettings.ReadWrite.All',
      'Reports.Read.All', 'RoleManagement.Read.Directory', 'SecurityAlert.Read.All', 'SecurityEvents.Read.All', 'User.Read.All',
    ]);
    expect(driver.descriptor.resources.map((r) => r.key)).toEqual(['tenant', 'users', 'groups', 'computers', 'mobile_devices']);
    expect(Object.keys(MICROSOFT_365_RECOMMENDED_DESTINATIONS)).toHaveLength(5);
  });

  it('only follows Graph links as cursors', () => {
    expect(decodeCursor(encodeCursor(`${G}/users?$skiptoken=x`))).toBe(`${G}/users?$skiptoken=x`);
    const forged = Buffer.from(JSON.stringify({ next: 'https://evil.example/steal' })).toString('base64');
    expect(decodeCursor(forged)).toBeUndefined();
    expect(() => encodeCursor('https://evil.example/x')).toThrow();
  });
});

describe('Microsoft365Driver users', () => {
  it('pages users, skips guests, fills standard fields and joins storage by UPN', async () => {
    const calls = installFetchTable(baseTable());
    const { records, pages } = await walk(driver, fetchCtx(makeCtx(), 'users'));
    expect(pages).toBe(2);
    expect(records.map((r) => r.externalId)).toEqual([U1, U2, U3]);
    const one = records[0]!;
    expect(one.fields).toEqual({ name: 'User One', email: 'one@contoso.example', job_title: 'Engineer', department: 'IT', phone: '+14255550100' });
    // Mail falls back to the UPN; phone falls back to mobile.
    expect(records[2]!.fields).toMatchObject({ email: 'nomail@contoso.example', phone: '+14255550199' });
    expect(rowOf(one, 'licences', 'Assigned')).toEqual({ kind: 'list', label: 'Assigned', value: ['Microsoft 365 Business Premium'] });
    expect(rowOf(one, 'mailbox', 'Mailbox storage')).toEqual({ kind: 'meter', label: 'Mailbox storage', used: 1073741824, total: 53687091200, unit: 'bytes' });
    expect(rowOf(one, 'mailbox', 'Archive mailbox')).toEqual({ kind: 'boolean', label: 'Archive mailbox', value: true });
    expect(rowOf(one, 'onedrive', 'OneDrive storage')).toMatchObject({ kind: 'meter', used: 2048 });
    expect(rowOf(one, 'account', 'Last sign-in')).toEqual({ kind: 'datetime', label: 'Last sign-in', value: '2026-10-05T00:00:00.000Z' });
    expect(rowOf(one, 'account', 'Synced from on-premises')).toMatchObject({ value: true });
    expect(rowOf(one, 'security', 'MFA registered')).toMatchObject({ value: true });
    expect(rowOf(one, 'security', 'Admin roles')).toEqual({ kind: 'list', label: 'Admin roles', value: ['Global Administrator'] });
    expect(rowOf(one, 'security', 'Wasted licence')).toMatchObject({ value: 'No' });
    // Signed in with P1 data: the select asks for signInActivity at 500 per page.
    expect(calls.find((c) => c.url.startsWith(`${G}/users?$select=id,displayName`))!.url).toMatch(/signInActivity&\$top=500$/);
    // Each report is fetched once per run, however many pages.
    expect(calls.filter((c) => c.url.startsWith(`${G}/reports/getMailboxUsageDetail`))).toHaveLength(1);
    expect(__runCacheSizeForTests()).toBe(0);
  });

  it('follows the report redirect through the egress guard without the bearer token', async () => {
    const calls = installFetchTable(baseTable());
    await driver.fetchRecords(fetchCtx(makeCtx(), 'users'), null);
    const report = calls.find((c) => c.url.startsWith(`${G}/reports/getMailboxUsageDetail`))!;
    expect(report.headers.authorization).toMatch(/^Bearer /);
    const download = calls.find((c) => new URL(c.url).origin === new URL(CSV_HOST).origin)!;
    expect(download.headers.authorization).toBeUndefined();
  });

  it('refuses a report redirect to a host outside Microsoft', async () => {
    const calls = installFetchTable(baseTable({
      [`${G}/reports/getMailboxUsageDetail`]: { status: 302, headers: { location: 'https://reports.example.net/mailbox.csv' } },
    }));
    await expect(graphReportCsv(makeCtx(), "getMailboxUsageDetail(period='D7')", 'the mailbox usage report')).rejects.toThrow(/unsafe download link/);
    expect(calls.some((c) => new URL(c.url).hostname === 'reports.example.net')).toBe(false);
  });

  it('detects shared mailboxes with $batch (20 per request, GET only) and flags their licence as wasted', async () => {
    const calls = installFetchTable(baseTable());
    const { records } = await walk(driver, fetchCtx(makeCtx(), 'users'));
    const desk = records[1]!;
    expect(rowOf(desk, 'account', 'Shared mailbox')).toMatchObject({ value: 'Yes' });
    expect(rowOf(desk, 'security', 'Wasted licence')).toMatchObject({ value: 'Yes' });
    // Disabled and licensed is wasted too.
    expect(rowOf(records[2]!, 'security', 'Wasted licence')).toMatchObject({ value: 'Yes' });
    const batches = calls.filter((c) => c.url === `${G}/$batch`);
    expect(batches.length).toBeGreaterThan(0);
    for (const b of batches) {
      const { requests } = JSON.parse(b.body!) as { requests: Array<{ method: string; url: string }> };
      expect(requests.length).toBeLessThanOrEqual(20);
      expect(requests.every((r) => r.method === 'GET' && /^\/users\/[^/]+\/mailboxSettings\/userPurpose$/.test(r.url))).toBe(true);
    }
  });

  it('shows concealed report names as hidden instead of joining on hashes', async () => {
    installFetchTable(baseTable({ [`${CSV_HOST}/mailbox.csv`]: { text: CONCEALED_CSV } }));
    const page = await driver.fetchRecords(fetchCtx(makeCtx(), 'users'), null);
    expect(rowOf(page.records[0] as LegacyDriverRecord, 'mailbox', 'Mailbox')).toEqual({ kind: 'text', label: 'Mailbox', value: CONCEALED_NOTE });
  });

  it('degrades P1 data to "Not available (needs Entra ID P1)" and drops signInActivity from the select', async () => {
    const p1 = { status: 403, body: { error: { code: 'Authentication_RequestFromNonPremiumTenantOrB2CTenant', message: 'internal text' } } };
    const calls = installFetchTable(baseTable({
      [`${G}/users?$select=id,signInActivity`]: p1,
      [`${G}/reports/authenticationMethods/userRegistrationDetails`]: p1,
    }));
    const page = await driver.fetchRecords(fetchCtx(makeCtx(), 'users'), null);
    const one = page.records[0] as LegacyDriverRecord;
    expect(rowOf(one, 'account', 'Last sign-in')).toEqual({ kind: 'text', label: 'Last sign-in', value: 'Not available (needs Entra ID P1).' });
    expect(rowOf(one, 'security', 'MFA registered')).toEqual({ kind: 'text', label: 'MFA registered', value: 'Not available (needs Entra ID P1).' });
    expect(JSON.stringify(page.records)).not.toContain('internal text');
    expect(calls.find((c) => c.url.startsWith(`${G}/users?$select=id,displayName`))!.url).toMatch(/assignedLicenses&\$top=999$/);
  });

  it('propagates a Graph rate limit with its Retry-After', async () => {
    installFetchTable(baseTable({ [`${G}/users?$select=id,displayName`]: { status: 429, headers: { 'Retry-After': '7' }, body: {} } }));
    await expect(driver.fetchRecords(fetchCtx(makeCtx(), 'users'), null)).rejects.toMatchObject({ name: 'DriverRateLimitError', retryAfterMs: 7_000 });
  });
});

describe('Microsoft365Driver tenant isolation', () => {
  it('refuses a mapping of another tenant, by stored consent and by Graph', async () => {
    installFetchTable(baseTable());
    await expect(driver.fetchRecords(fetchCtx(makeCtx(), 'users', OTHER_TENANT), null)).rejects.toBeInstanceOf(DriverAuthError);
    __resetRunCacheForTests();
    installFetchTable(baseTable({ [`${G}/organization`]: { body: { value: [{ ...ORG.value[0], id: OTHER_TENANT }] } } }));
    await expect(driver.fetchRecords(fetchCtx(makeCtx(), 'users'), null)).rejects.toThrow(/different tenant/);
  });

  it('lists the one consented tenant as the source org', async () => {
    installFetchTable(baseTable());
    await expect(driver.listSourceOrgs(makeCtx())).resolves.toEqual([{ externalId: TENANT, name: 'Contoso', hint: 'contoso.example' }]);
  });
});

describe('Microsoft365Driver devices', () => {
  it('splits Intune devices: Windows/macOS to computers, iOS/Android to mobile', async () => {
    installFetchTable(baseTable());
    const computers = (await driver.fetchRecords(fetchCtx(makeCtx(), 'computers'), null)).records as LegacyDriverRecord[];
    expect(computers.map((r) => r.externalId)).toEqual(['d1', 'd3']);
    expect(computers[0]!.fields).toEqual({
      name: 'CONTOSO-LT1', serialNumber: 'SN-1', hostname: 'CONTOSO-LT1', manufacturer: 'Contoso Devices', model: 'Book 14',
      operating_system: 'Windows 10.0.22631', mac_address: '00:11:aa:bb:cc:dd',
    });
    expect(rowOf(computers[0]!, 'intune', 'Storage')).toEqual({ kind: 'meter', label: 'Storage', used: 750, total: 1000, unit: 'bytes' });
    expect(rowOf(computers[0]!, 'intune', 'Compliance')).toMatchObject({ value: 'compliant', tone: 'success' });
    const mobile = (await driver.fetchRecords(fetchCtx(makeCtx(), 'mobile_devices'), null)).records as LegacyDriverRecord[];
    expect(mobile.map((r) => r.externalId)).toEqual(['d2', 'd4']);
    expect(mobile[0]!.fields).toMatchObject({ imei: '351234567890123', phone_number: '+14255550111', operating_system: 'iOS 18.1' });
  });

  it('skips the resource as unlicensed on Graph\'s "not applicable to target tenant" answer', async () => {
    installFetchTable(baseTable({ [`${G}/deviceManagement/managedDevices`]: NOT_LICENSED }));
    const fetched = driver.fetchRecords(fetchCtx(makeCtx(), 'computers'), null);
    await expect(fetched).rejects.toBeInstanceOf(DriverResourceUnavailableError);
    await expect(fetched).rejects.toThrow('Intune is not licensed in this tenant, so computers and mobile devices are skipped.');
  });

  it('fails the run on any other 400 instead of skipping it as unlicensed', async () => {
    installFetchTable(baseTable({ [`${G}/deviceManagement/managedDevices`]: { status: 400, body: { error: { code: 'BadRequest', message: 'Invalid filter clause' } } } }));
    const fetched = driver.fetchRecords(fetchCtx(makeCtx(), 'computers'), null);
    await expect(fetched).rejects.toBeInstanceOf(GraphRequestError);
    await expect(fetched).rejects.not.toBeInstanceOf(DriverResourceUnavailableError);
  });

  it('fails the run on a 403 while the Intune permission is granted', async () => {
    installFetchTable(baseTable({ [`${G}/deviceManagement/managedDevices`]: { status: 403, body: { error: { code: 'Forbidden' } } } }));
    await expect(driver.fetchRecords(fetchCtx(makeCtx(), 'computers'), null)).rejects.not.toBeInstanceOf(DriverResourceUnavailableError);
  });

  it('skips the resource as unlicensed on a 401 UnknownError while the Intune permission is granted', async () => {
    installFetchTable(baseTable({ [`${G}/deviceManagement/managedDevices`]: UNLICENSED_401 }));
    const fetched = driver.fetchRecords(fetchCtx(makeCtx(), 'computers'), null);
    await expect(fetched).rejects.toBeInstanceOf(DriverResourceUnavailableError);
    await expect(fetched).rejects.toThrow('Intune is not licensed in this tenant, so computers and mobile devices are skipped.');
  });

  it('fails the run on any other 401 while the Intune permission is granted', async () => {
    installFetchTable(baseTable({ [`${G}/deviceManagement/managedDevices`]: TOKEN_401 }));
    const fetched = driver.fetchRecords(fetchCtx(makeCtx(), 'computers'), null);
    await expect(fetched).rejects.toBeInstanceOf(DriverAuthError);
    await expect(fetched).rejects.not.toBeInstanceOf(DriverResourceUnavailableError);
  });

  it('names the missing permission on a 401 when the Intune permission is not granted', async () => {
    installFetchTable(baseTable({ [`${G}/deviceManagement/managedDevices`]: UNLICENSED_401 }));
    const base = makeCtx();
    const ctx = { ...base, secret: { ...(base.secret as object), grantedRoles: WITHOUT_INTUNE(MICROSOFT_PERMISSIONS) } };
    const fetched = driver.fetchRecords(fetchCtx(ctx, 'computers'), null);
    await expect(fetched).rejects.toBeInstanceOf(DriverResourceUnavailableError);
    await expect(fetched).rejects.toThrow(/DeviceManagementManagedDevices\.Read\.All is not granted in this tenant/);
  });

  it('names the missing permission when the Intune permission is not granted', async () => {
    installFetchTable(baseTable({ [`${G}/deviceManagement/managedDevices`]: { status: 403, body: { error: { code: 'Forbidden' } } } }));
    const base = makeCtx();
    const ctx = { ...base, secret: { ...(base.secret as object), grantedRoles: MICROSOFT_PERMISSIONS.filter((p) => p !== 'DeviceManagementManagedDevices.Read.All') } };
    const fetched = driver.fetchRecords(fetchCtx(ctx, 'mobile_devices'), null);
    await expect(fetched).rejects.toBeInstanceOf(DriverResourceUnavailableError);
    await expect(fetched).rejects.toThrow(/DeviceManagementManagedDevices\.Read\.All is not granted in this tenant/);
  });
});

describe('Microsoft365Driver groups', () => {
  it('syncs mail-enabled groups with type, count and members', async () => {
    const calls = installFetchTable(baseTable());
    const { records } = await walk(driver, fetchCtx(makeCtx(), 'groups'));
    expect(records).toHaveLength(1);
    expect(records[0]!.fields).toEqual({ name: 'Sales', email: 'sales@contoso.example', description: 'Sales team' });
    expect(rowOf(records[0]!, 'group', 'Type')).toMatchObject({ value: 'Microsoft 365' });
    expect(rowOf(records[0]!, 'group', 'Members')).toEqual({ kind: 'number', label: 'Members', value: 7 });
    expect(rowOf(records[0]!, 'group', 'Members (first 1)')).toMatchObject({ value: ['one@contoso.example'] });
    expect(calls.find((c) => c.url.startsWith(`${G}/groups/g1/members`))!.headers.consistencylevel).toBe('eventual');
  });
});

describe('Microsoft365Driver tenant', () => {
  it('builds the tenant block: counts, SKU meters with friendly names, subscriptions, Secure Score, MFA, admins, storage, alerts', async () => {
    installFetchTable(baseTable());
    const rec = (await driver.fetchRecords(fetchCtx(makeCtx(), 'tenant'), null)).records[0] as LegacyDriverRecord;
    expect(rec.externalId).toBe(TENANT);
    expect(rec.fields).toEqual({ name: 'Contoso', tenantId: TENANT, primary_domain: 'contoso.example' });
    expect(rowOf(rec, 'overview', 'Members')).toMatchObject({ value: 12 });
    expect(rowOf(rec, 'overview', 'Guests')).toMatchObject({ value: 4 });
    expect(rowOf(rec, 'licences', 'Microsoft 365 Business Premium')).toEqual({ kind: 'meter', label: 'Microsoft 365 Business Premium', used: 3, total: 5, unit: 'count' });
    // Grace-period (warning) units count as purchased, so the meter never runs past full.
    expect(rowOf(rec, 'licences', 'Microsoft Defender for Endpoint P2')).toEqual({ kind: 'meter', label: 'Microsoft Defender for Endpoint P2', used: 3, total: 3, unit: 'count' });
    // A SKU in its grace period still shows purchased vs assigned.
    expect(rowOf(rec, 'licences', 'Microsoft Intune Plan 1')).toEqual({ kind: 'meter', label: 'Microsoft Intune Plan 1', used: 2, total: 4, unit: 'count' });
    // Unknown part number falls back to itself.
    expect(rowOf(rec, 'licences', 'CONTOSO_CUSTOM_SKU')).toMatchObject({ kind: 'text', value: 'Suspended, 1 assigned' });
    expect(rowOf(rec, 'subscriptions', 'Microsoft 365 Business Premium')).toMatchObject({ value: 'Enabled, 5 licences, next lifecycle date 2027-01-31' });
    expect(rowOf(rec, 'security', 'Secure Score')).toEqual({ kind: 'meter', label: 'Secure Score', used: 41.5, total: 83, unit: 'count', higherIsBetter: true });
    expect(rowOf(rec, 'security', 'MFA coverage (members)')).toMatchObject({ used: 1, total: 2 });
    expect(rowOf(rec, 'security', 'Global Administrators')).toMatchObject({ value: 1 });
    expect(rowOf(rec, 'storage', 'OneDrive (all users)')).toEqual({ kind: 'bytes', label: 'OneDrive (all users)', value: 2048 });
    expect(rowOf(rec, 'storage', 'SharePoint')).toEqual({ kind: 'bytes', label: 'SharePoint', value: 700 });
    const alerts = rows(rec, 'alerts');
    expect(alerts[0]).toEqual({ kind: 'number', label: 'Alerts (last 30 days)', value: 2 });
    // High first; a non-https link is shown as text, never as a link.
    expect(alerts[1]).toEqual({ kind: 'text', label: 'high: Malware detected', value: 'inProgress, 2026-10-06' });
    expect(alerts[2]).toEqual({ kind: 'link', label: 'medium: Suspicious sign-in', value: 'https://security.microsoft.com/alerts/1', text: 'new, 2026-10-07' });
  });

  it('leaves out the OneDrive total when the report conceals names', async () => {
    const hidden =
      'Report Refresh Date,Site URL,Owner Display Name,Is Deleted,Storage Used (Byte),Storage Allocated (Byte),Owner Principal Name\n' +
      '2026-10-06,https://contoso-my.sharepoint.com/personal/x,7B8F2C1A,False,2048,1099511627776,7B8F2C1A9D3E4F5A6B7C8D9E0F1A2B3C\n';
    installFetchTable(baseTable({ [`${G}/reports/getOneDriveUsageAccountDetail`]: { text: hidden } }));
    const rec = (await driver.fetchRecords(fetchCtx(makeCtx(), 'tenant'), null)).records[0] as LegacyDriverRecord;
    expect(rowOf(rec, 'storage', 'OneDrive (all users)')).toBeUndefined();
  });

  it('does not present a capped alert page as the full count', async () => {
    installFetchTable(baseTable({
      [`${G}/security/alerts_v2`]: { body: { value: [{ title: 'A', severity: 'low' }], '@odata.nextLink': `${G}/security/alerts_v2?$skiptoken=x` } },
    }));
    const rec = (await driver.fetchRecords(fetchCtx(makeCtx(), 'tenant'), null)).records[0] as LegacyDriverRecord;
    expect(rows(rec, 'alerts')[0]).toEqual({ kind: 'text', label: 'Alerts (last 30 days)', value: 'More than 1' });
  });

  it('degrades Defender and Secure Score to Not available rows', async () => {
    installFetchTable(baseTable({
      [`${G}/security/alerts_v2`]: { status: 403, body: { error: { code: 'Forbidden' } } },
      [`${G}/security/secureScores`]: { status: 403, body: { error: { code: 'Forbidden' } } },
    }));
    const rec = (await driver.fetchRecords(fetchCtx(makeCtx(), 'tenant'), null)).records[0] as LegacyDriverRecord;
    expect(rowOf(rec, 'alerts', 'Alerts')).toMatchObject({ kind: 'text', value: expect.stringContaining('Microsoft denied access to security alerts') });
    expect(rowOf(rec, 'security', 'Secure Score')).toMatchObject({ kind: 'text' });
  });
});

describe('Microsoft365Driver is read-only', () => {
  it('only GETs Graph during sync and setup checks (the one POST is $batch of GETs; plus token requests)', async () => {
    const calls = installFetchTable(baseTable({ [`${G}/admin/reportSettings`]: { body: { displayConcealedNames: true } } }));
    const ctx = makeCtx();
    for (const key of ['tenant', 'users', 'groups', 'computers', 'mobile_devices']) await walk(driver, fetchCtx(ctx, key));
    await driver.listSourceOrgs(ctx);
    await listMicrosoftDomains(ctx, TENANT);
    await diagnoseMicrosoftConnection(ctx);
    for (const c of calls) {
      if (c.url.startsWith('https://login.microsoftonline.com/')) expect(c.method).toBe('POST');
      else if (c.url === `${G}/$batch`) expect(c.method).toBe('POST');
      else expect(c.method).toBe('GET');
    }
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('keeps the only write (PATCH /admin/reportSettings) out of the driver, sync and diagnose modules', () => {
    const here = __dirname;
    for (const file of ['microsoft-365.driver.ts', 'microsoft-365.diagnose.ts', 'microsoft-365.graph.ts', 'microsoft-365.sections.ts']) {
      const source = readFileSync(join(here, file), 'utf8');
      expect(source).not.toMatch(/from '\.\/microsoft-365\.report-settings/);
      expect(source).not.toMatch(/method: '(PATCH|PUT|DELETE)'/);
    }
  });

  it('writeReportConcealment sends exactly one PATCH of displayConcealedNames', async () => {
    const calls = installFetchTable(baseTable({ [`${G}/admin/reportSettings`]: { status: 204 } }));
    await writeReportConcealment(makeCtx(), false);
    const patch = calls.filter((c) => c.method === 'PATCH');
    expect(patch).toHaveLength(1);
    expect(patch[0]!.url).toBe(`${G}/admin/reportSettings`);
    expect(JSON.parse(patch[0]!.body!)).toEqual({ displayConcealedNames: false });
  });
});

describe('listMicrosoftDomains', () => {
  it('returns verified custom domains only, normalized, without onmicrosoft.com', async () => {
    installFetchTable(baseTable());
    await expect(listMicrosoftDomains(makeCtx(), TENANT)).resolves.toEqual([
      { hostname: 'contoso.example', isDefault: true, authType: 'FEDERATED', services: ['Email', 'OfficeCommunicationsOnline'] },
    ]);
  });

  it('refuses another tenant', async () => {
    installFetchTable(baseTable());
    await expect(listMicrosoftDomains(makeCtx(), OTHER_TENANT)).rejects.toBeInstanceOf(DriverAuthError);
  });
});

describe('verifyConsentedTenant', () => {
  it('returns the tenant name when Graph agrees, and throws when it does not', async () => {
    installFetchTable(baseTable());
    const input = { accessToken: 'tok', tenantId: TENANT, http: { timeoutMs: 5_000, maxRetries: 0, backoffMs: 1 }, correlationId: 'c' };
    await expect(driver.verifyConsentedTenant(input)).resolves.toEqual({ tenantName: 'Contoso' });
    await expect(driver.verifyConsentedTenant({ ...input, tenantId: OTHER_TENANT })).rejects.toThrow();
  });
});

describe('Check setup', () => {
  const client = (homeTenantId: string | null) => ({
    mode: 'client' as const,
    oauthClient: { clientId: 'client-1', clientSecret: 'client-secret-1' },
    redirectUri: 'https://ws.example.test/api/v1/admin/integrations/oauth/callback',
    homeTenantId,
    http: { timeoutMs: 5_000, maxRetries: 0, backoffMs: 1 },
    correlationId: 'c',
  });
  const ORGS_URL = 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token';

  it('passes the client with the home tenant id', async () => {
    installFetchTable(baseTable());
    await expect(diagnoseMicrosoftClient(client(TENANT))).resolves.toEqual({ ok: true, passedStepIds: ['register', 'secret', 'credentials'], failures: [] });
  });

  it.each([
    [7000215, 'secret', /AADSTS7000215/],
    [7000222, 'secret', /expired/],
    [700016, 'credentials', /AADSTS700016/],
    [50194, 'register', /not multi-tenant/],
  ])('maps AADSTS%s to the %s step with fixed text', async (code, step, text) => {
    installFetchTable({ [ORGS_URL]: { status: 401, body: { error: 'invalid_client', error_description: `AADSTS${code}: provider text`, error_codes: [code] } } });
    const result = await diagnoseMicrosoftClient(client(null));
    expect(result.failures).toEqual([{ stepId: step, message: expect.stringMatching(text) }]);
    expect(JSON.stringify(result)).not.toContain('provider text');
  });

  it('leaves the secret unverified (a note) when no home tenant is saved and the answer is inconclusive', async () => {
    installFetchTable({ [ORGS_URL]: { status: 400, body: { error: 'invalid_request', error_codes: [90009] } } });
    const result = await diagnoseMicrosoftClient(client(null));
    expect(result).toMatchObject({ ok: true, failures: [], notes: [{ stepId: 'secret' }] });
  });

  it('lists the permissions a tenant has not granted (re-consent needed)', async () => {
    installFetchTable(baseTable({
      [TOKEN_URL]: { body: { access_token: jwt({ tid: TENANT, roles: ['User.Read.All'] }), expires_in: 3600 } },
      [`${G}/admin/reportSettings`]: { body: { displayConcealedNames: false } },
    }));
    const result = await diagnoseMicrosoftConnection(makeCtx());
    const failure = result.failures.find((f) => f.stepId === 'permissions')!;
    expect(failure.message).toMatch(/^Not granted in this tenant: .*AuditLog\.Read\.All/);
    expect(failure.message).toContain('Reconnect');
    expect(failure.message).not.toContain('User.Read.All,');
  });

  it('says a granted report setting could not be read, without blaming the permission', async () => {
    installFetchTable(baseTable({ [`${G}/admin/reportSettings`]: { status: 503, body: {} } }));
    const notes = ((await diagnoseMicrosoftConnection(makeCtx())).notes ?? []).map((n) => n.message).join(' | ');
    expect(notes).toContain('could not be read right now');
    expect(notes).not.toContain('not granted');
  });

  it('passes a tenant that granted no optional report-settings permission, without reading the setting', async () => {
    const calls = installFetchTable(baseTable({
      [TOKEN_URL]: { body: { access_token: jwt({ tid: TENANT, roles: MICROSOFT_REQUIRED_PERMISSIONS }), expires_in: 3600 } },
    }));
    const result = await diagnoseMicrosoftConnection(makeCtx());
    expect(result.failures).toEqual([]);
    expect(result.passedStepIds).toContain('permissions');
    const notes = (result.notes ?? []).map((n) => n.message).join(' | ');
    expect(notes).toContain(OPTIONAL_WRITE_NOTE);
    expect(notes).toContain('optional ReportSettings.Read.All not granted');
    expect(calls.some((c) => c.url.startsWith(`${G}/admin/reportSettings`))).toBe(false);
  });

  it('notes P1, Intune and concealed names without failing a fully granted tenant', async () => {
    const p1 = { status: 403, body: { error: { code: 'Authentication_RequestFromNonPremiumTenantOrB2CTenant' } } };
    installFetchTable(baseTable({
      [`${G}/users?$select=id,signInActivity`]: p1,
      [`${G}/deviceManagement/managedDevices`]: { status: 403, body: {} },
      [`${G}/admin/reportSettings`]: { body: { displayConcealedNames: true } },
    }));
    const result = await diagnoseMicrosoftConnection(makeCtx());
    expect(result.ok).toBe(true);
    expect(result.passedStepIds).toEqual(expect.arrayContaining(['register', 'secret', 'credentials', 'permissions', 'connect']));
    const notes = (result.notes ?? []).map((n) => n.message).join(' | ');
    expect(notes).toContain('Entra ID P1');
    expect(notes).toContain(INTUNE_UNREADABLE_NOTE);
    expect(notes).not.toMatch(/Intune is not licensed/);
    expect(notes).toContain('"Conceal user, group, and site names in all reports" is on');
  });

  it('notes the Intune licence on a 401 UnknownError while the Intune permission is granted', async () => {
    installFetchTable(baseTable({ [`${G}/deviceManagement/managedDevices`]: UNLICENSED_401 }));
    const notes = ((await diagnoseMicrosoftConnection(makeCtx())).notes ?? []).map((n) => n.message);
    expect(notes).toContain('Intune is not licensed in this tenant, so computers and mobile devices are skipped.');
    expect(notes).not.toContain(INTUNE_UNREADABLE_NOTE);
  });

  it('does not call any other 401 unlicensed in Check setup', async () => {
    installFetchTable(baseTable({ [`${G}/deviceManagement/managedDevices`]: TOKEN_401 }));
    const notes = ((await diagnoseMicrosoftConnection(makeCtx())).notes ?? []).map((n) => n.message);
    expect(notes).toContain(INTUNE_UNREADABLE_NOTE);
    expect(notes.join(' | ')).not.toMatch(/Intune is not licensed/);
  });

  it('names the missing Intune permission on a 401 in Check setup', async () => {
    installFetchTable(baseTable({
      [TOKEN_URL]: { body: { access_token: jwt({ tid: TENANT, roles: WITHOUT_INTUNE(MICROSOFT_PERMISSIONS) }), expires_in: 3600 } },
      [`${G}/deviceManagement/managedDevices`]: UNLICENSED_401,
    }));
    const notes = ((await diagnoseMicrosoftConnection(makeCtx())).notes ?? []).map((n) => n.message).join(' | ');
    expect(notes).toMatch(/DeviceManagementManagedDevices\.Read\.All is not granted in this tenant/);
    expect(notes).not.toMatch(/Intune is not licensed/);
  });

  it('notes the Intune licence only on Graph\'s "not applicable to target tenant" answer', async () => {
    installFetchTable(baseTable({ [`${G}/deviceManagement/managedDevices`]: NOT_LICENSED }));
    const notes = ((await diagnoseMicrosoftConnection(makeCtx())).notes ?? []).map((n) => n.message);
    expect(notes).toContain('Intune is not licensed in this tenant, so computers and mobile devices are skipped.');
    expect(notes).not.toContain(INTUNE_UNREADABLE_NOTE);
  });
});
