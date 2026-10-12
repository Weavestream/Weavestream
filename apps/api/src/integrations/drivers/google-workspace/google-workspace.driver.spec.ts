import { driverDescriptorSchema, integrationSectionSchema, type IntegrationSection } from '@weavestream/shared';
import {
  DriverAuthError,
  DriverRateLimitError,
  DriverResourceUnavailableError,
  type FetchRecordsContext,
  type IntegrationContext,
  type LegacyDriverRecord,
} from '../integration-driver.js';
import {
  GoogleWorkspaceDriver,
  GOOGLE_WORKSPACE_RECOMMENDED_DESTINATIONS,
  LOOKUP_ITEM_CAP,
  listWorkspaceDomains,
  __googleWorkspaceRunCacheSizeForTests,
  __resetGoogleWorkspaceRunCacheForTests,
} from './google-workspace.driver.js';
import { __resetOAuthAccessTokenCacheForTests } from '../../oauth/oauth-token.js';
import { setDefaultFetchForTests, setDefaultResolveForTests } from '../../../common/egress/safe-fetch.js';

const DIR = 'https://admin.googleapis.com/admin/directory/v1';
const REPORTS = 'https://admin.googleapis.com/admin/reports/v1';
const LICENSING = 'https://licensing.googleapis.com/apps/licensing/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CUSTOMER_ID = 'C0example1';
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
    if (!key) throw new Error(`Google Workspace driver test: unscripted fetch to ${url}`);
    const entry = table[key]!;
    const reply = typeof entry === 'function' ? entry(url) : entry;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch);
  setDefaultResolveForTests(async () => ['1.2.3.4']);
  return calls;
}

const BASE_TABLE: Record<string, Reply> = {
  [TOKEN_URL]: { body: { access_token: 'access-1', expires_in: 3600 } },
  [`${DIR}/customers/my_customer`]: {
    body: { id: CUSTOMER_ID, customerDomain: 'example.com', customerCreationTime: '2020-01-02T03:04:05.000Z' },
  },
  // Education licence products the example tenant does not have.
  [`${LICENSING}/product/`]: { status: 404, body: { error: { code: 404 } } },
};

let integrationSeq = 0;
function makeCtx(): IntegrationContext {
  integrationSeq += 1;
  return {
    config: {},
    secret: { refreshToken: 'refresh-1', grantedScopes: [], connectedAt: '2026-10-01T00:00:00.000Z' },
    oauthClient: { clientId: 'client-1', clientSecret: 'client-secret-1' },
    integrationId: `00000000-0000-4000-8000-${String(integrationSeq).padStart(12, '0')}`,
    correlationId: 'corr-1',
    http: { timeoutMs: 5_000, maxRetries: 1, backoffMs: 1 },
  };
}

function fetchCtx(base: IntegrationContext, resourceKey: string, externalOrgId = CUSTOMER_ID): FetchRecordsContext {
  return { ...base, externalOrgId, resourceKey, filter: {}, mode: 'full', updatedSince: null, snapshotAt: SNAPSHOT };
}

function sectionOf(rec: LegacyDriverRecord): IntegrationSection {
  const parsed = integrationSectionSchema.safeParse(rec.section);
  if (!parsed.success) throw new Error(`invalid section: ${parsed.error.message}`);
  return parsed.data;
}

function rows(section: IntegrationSection, group: string) {
  const g = section.groups.find((candidate) => candidate.key === group);
  if (!g) throw new Error(`missing group ${group}`);
  return g.rows;
}

function row(section: IntegrationSection, group: string, label: string) {
  return rows(section, group).find((r) => r.label === label);
}

const ALICE = {
  id: '1001', primaryEmail: 'Alice@example.com', name: { fullName: 'User Alice' },
  suspended: false, archived: false, isAdmin: true, isDelegatedAdmin: false,
  isEnrolledIn2Sv: true, isEnforcedIn2Sv: true, lastLoginTime: '2026-10-07T08:00:00.000Z',
  creationTime: '2021-05-01T00:00:00.000Z', orgUnitPath: '/Staff',
  organizations: [{ title: 'Old title' }, { title: 'Engineer', department: 'Operations', primary: true }],
  phones: [{ value: '555 0100', type: 'home' }, { value: '(555) 010-0199', type: 'work' }],
};
const BOB = {
  id: '1002', primaryEmail: 'bob@example.com', name: { fullName: 'User Bob' },
  suspended: true, isAdmin: false, isDelegatedAdmin: true, isEnrolledIn2Sv: false,
  lastLoginTime: '1970-01-01T00:00:00.000Z', creationTime: '2022-01-01T00:00:00.000Z', orgUnitPath: '/',
  // No primary organization or phone: the first one is used; a phone with an extension is not a PHONE value.
  organizations: [{ title: 'Analyst' }], phones: [{ value: '+1 555 0100 ext 12', type: 'work', primary: true }],
};
const CAROL = {
  id: '1003', primaryEmail: 'carol@example.com', isEnrolledIn2Sv: false,
  lastLoginTime: '2026-01-01T00:00:00.000Z', creationTime: '2022-01-01T00:00:00.000Z',
};

const LICENCES = {
  items: [
    { userId: 'alice@example.com', skuId: '1010020028', skuName: 'Google Workspace Business Standard', productId: 'Google-Apps' },
    { userId: 'bob@example.com', skuId: '1010020027', productId: 'Google-Apps' },
  ],
};

function usageParams(used: number, total: number, gmail: number, drive: number, shared?: number) {
  return [
    { name: 'accounts:used_quota_in_mb', intValue: String(used) },
    { name: 'accounts:total_quota_in_mb', intValue: String(total) },
    { name: 'accounts:gmail_used_quota_in_mb', intValue: String(gmail) },
    { name: 'accounts:drive_used_quota_in_mb', intValue: String(drive) },
    ...(shared === undefined ? [] : [{ name: 'accounts:team_drive_used_quota_in_mb', intValue: String(shared) }]),
  ];
}

const NOT_YET = { body: { warnings: [{ code: 'DATA_NOT_AVAILABLE', message: 'Data for dates later than 2026-10-05 is not yet available.' }] } };

function userUsage(total = 30_720) {
  return {
    body: {
      usageReports: [
        { entity: { userEmail: 'alice@example.com' }, parameters: usageParams(12_000, total, 4_000, 8_000) },
      ],
    },
  };
}

beforeEach(() => {
  __resetOAuthAccessTokenCacheForTests();
  __resetGoogleWorkspaceRunCacheForTests();
});
afterEach(() => {
  setDefaultFetchForTests(null);
  setDefaultResolveForTests(null);
});

describe('GoogleWorkspaceDriver descriptor', () => {
  const driver = new GoogleWorkspaceDriver();

  it('validates against the shared descriptor schema with OAuth and match hints on every resource', () => {
    const parsed = driverDescriptorSchema.parse(driver.descriptor);
    expect(parsed.oauth?.provider).toBe('google');
    expect(parsed.oauth?.extraAuthorizeParams).toEqual({ access_type: 'offline', prompt: 'consent' });
    expect(parsed.resources.map((r) => r.key)).toEqual([
      'tenant', 'users', 'groups', 'chrome_devices', 'mobile_devices',
    ]);
    for (const resource of parsed.resources) {
      expect(resource.matchSuggestions).toBeDefined();
      expect(resource.minimalFields).toContain('name');
      expect(resource.minimalFields).not.toContain('autoUpdateExpiration');
    }
  });

  it('recommends new layouts with the minimal fields only', () => {
    for (const resource of driver.descriptor.resources) {
      const destination = GOOGLE_WORKSPACE_RECOMMENDED_DESTINATIONS[resource.key]!;
      expect(destination.fields.map((f) => f.sourceField).sort()).toEqual([...resource.minimalFields!].sort());
    }
  });

  it('offers the auto-update expiration as an optional mappable date for Chrome devices', async () => {
    const fields = await driver.listSourceFields({ ...makeCtx(), externalOrgId: CUSTOMER_ID, resourceKey: 'chrome_devices' });
    expect(fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'autoUpdateExpiration', hintType: 'DATE', alwaysPresent: false }),
      expect.objectContaining({ key: 'serialNumber' }),
    ]));
    const users = await driver.listSourceFields({ ...makeCtx(), externalOrgId: CUSTOMER_ID, resourceKey: 'users' });
    expect(users.map((f) => f.key)).toEqual(['name', 'primaryEmail', 'job_title', 'department', 'phone']);
  });

  it('declares standard fields per resource that skip the match key and the name', () => {
    const standard = Object.fromEntries(
      driverDescriptorSchema.parse(driver.descriptor).resources.map((r) => [r.key, (r.standardFields ?? []).map((f) => f.sourceField)]),
    );
    expect(standard).toEqual({
      tenant: ['primary_domain'],
      users: ['job_title', 'department', 'phone'],
      groups: ['description'],
      chrome_devices: ['model', 'operating_system', 'mac_address', 'ip_address'],
      mobile_devices: ['model', 'manufacturer', 'operating_system', 'imei', 'mac_address'],
    });
    const users = driver.descriptor.resources.find((r) => r.key === 'users')!;
    expect(users.standardFields!.find((f) => f.sourceField === 'phone')).toMatchObject({ fieldType: 'PHONE' });
    expect(users.standardFields!.find((f) => f.sourceField === 'job_title')!.fieldHints).toEqual(['job_title', 'title']);
  });
});

describe('GoogleWorkspaceDriver connection', () => {
  it('tests the connection on customers/my_customer with a Bearer token', async () => {
    const calls = installFetchTable(BASE_TABLE);
    await expect(new GoogleWorkspaceDriver().testConnection(makeCtx())).resolves.toEqual({
      ok: true,
      details: 'Connected to the Google Workspace tenant example.com.',
    });
    const customerCall = calls.find((c) => c.url === `${DIR}/customers/my_customer`)!;
    expect(customerCall.headers).toMatchObject({ Authorization: 'Bearer access-1' });
  });

  it('lists exactly one source org: the connected customer', async () => {
    installFetchTable(BASE_TABLE);
    await expect(new GoogleWorkspaceDriver().listSourceOrgs(makeCtx())).resolves.toEqual([
      { externalId: CUSTOMER_ID, name: 'example.com', hint: null },
    ]);
  });

  it('refuses to fetch for a tenant other than the connected one', async () => {
    installFetchTable(BASE_TABLE);
    await expect(
      new GoogleWorkspaceDriver().fetchRecords(fetchCtx(makeCtx(), 'users', 'C0other'), null),
    ).rejects.toBeInstanceOf(DriverAuthError);
  });

  it('turns invalid_grant into a Reconnect DriverAuthError', async () => {
    installFetchTable({ [TOKEN_URL]: { status: 400, body: { error: 'invalid_grant' } } });
    await expect(new GoogleWorkspaceDriver().testConnection(makeCtx())).rejects.toThrow(/Reconnect/);
  });

  it('names the API to enable on accessNotConfigured', async () => {
    installFetchTable({
      ...BASE_TABLE,
      [`${DIR}/customers/my_customer`]: {
        status: 403,
        body: { error: { code: 403, errors: [{ reason: 'accessNotConfigured' }], message: 'raw provider text' } },
      },
    });
    const error = await new GoogleWorkspaceDriver().testConnection(makeCtx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DriverAuthError);
    expect((error as Error).message).toMatch(/Admin SDK API is not enabled/);
    expect((error as Error).message).not.toMatch(/raw provider text/);
  });

  it('maps a 403 rate-limit reason to DriverRateLimitError', async () => {
    installFetchTable({
      ...BASE_TABLE,
      [`${DIR}/customers/my_customer`]: {
        status: 403,
        body: { error: { code: 403, details: [{ reason: 'RATE_LIMIT_EXCEEDED' }], errors: [{ reason: 'userRateLimitExceeded' }] } },
      },
    });
    await expect(new GoogleWorkspaceDriver().testConnection(makeCtx())).rejects.toBeInstanceOf(DriverRateLimitError);
  });
});

describe('GoogleWorkspaceDriver users', () => {
  function usersTable(overrides: Record<string, Reply> = {}): Record<string, Reply> {
    return {
      ...BASE_TABLE,
      [`${DIR}/users?`]: (url) =>
        url.includes('pageToken=page-2')
          ? { body: { users: [CAROL] } }
          : { body: { users: [ALICE, BOB], nextPageToken: 'page-2' } },
      [`${LICENSING}/product/Google-Apps/users?customerId=${CUSTOMER_ID}`]: { body: LICENCES },
      [`${REPORTS}/usage/users/all/dates/2026-10-06`]: NOT_YET,
      [`${REPORTS}/usage/users/all/dates/2026-10-05`]: userUsage(),
      ...overrides,
    };
  }

  it('emits minimal fields, a valid section, and walks pages through an opaque cursor', async () => {
    const calls = installFetchTable(usersTable());
    const driver = new GoogleWorkspaceDriver();
    const ctx = makeCtx();

    const first = await driver.fetchRecords(fetchCtx(ctx, 'users'), null);
    expect(first.hasMore).toBe(true);
    expect(first.snapshotAt).toBe(SNAPSHOT);
    expect(JSON.parse(Buffer.from(first.cursor!, 'base64').toString('utf8'))).toEqual({ pageToken: 'page-2' });

    const [alice, bob] = first.records as LegacyDriverRecord[];
    expect(alice!.externalId).toBe('1001');
    expect(alice!.displayName).toBe('User Alice');
    expect(alice!.fields).toEqual({
      name: 'User Alice', primaryEmail: 'Alice@example.com', job_title: 'Engineer', department: 'Operations', phone: '+15550100199',
    });
    expect(bob!.fields).toEqual({ name: 'User Bob', primaryEmail: 'bob@example.com', job_title: 'Analyst' });

    const a = sectionOf(alice!);
    expect(row(a, 'account', 'Status')).toMatchObject({ kind: 'badge', value: 'Active' });
    // Org unit stays in the block; the mapped facts do not.
    expect(row(a, 'account', 'Org unit')).toMatchObject({ value: '/Staff' });
    const labels = a.groups.flatMap((g) => g.rows.map((r) => r.label));
    for (const mapped of ['Name', 'Email', 'Job title', 'Department', 'Phone']) {
      expect(labels).not.toContain(mapped);
    }
    expect(row(a, 'licences', 'Assigned')).toEqual({ kind: 'list', label: 'Assigned', value: ['Google Workspace Business Standard'] });
    expect(row(a, 'mailbox', 'Mailbox storage')).toEqual({ kind: 'meter', label: 'Mailbox storage', used: 4_000, total: 30_720, unit: 'mb' });
    expect(row(a, 'drive', 'Drive storage')).toMatchObject({ kind: 'meter', used: 8_000 });
    expect(row(a, 'storage', 'Total storage')).toMatchObject({ kind: 'meter', used: 12_000, total: 30_720 });
    expect(row(a, 'storage', 'Data as of')).toEqual({ kind: 'date', label: 'Data as of', value: '2026-10-05' });
    expect(row(a, 'security', 'Admin role')).toMatchObject({ value: 'Super admin' });
    expect(row(a, 'security', 'Wasted licence')).toMatchObject({ value: 'No' });

    const b = sectionOf(bob!);
    expect(row(b, 'account', 'Status')).toMatchObject({ value: 'Suspended' });
    expect(row(b, 'account', 'Last login')).toMatchObject({ kind: 'text', value: 'Never' });
    // SKU name missing from the listing: falls back to the edition table.
    expect(row(b, 'licences', 'Assigned')).toMatchObject({ value: ['Business Starter'] });
    expect(row(b, 'security', 'Admin role')).toMatchObject({ value: 'Delegated admin' });
    expect(row(b, 'security', 'Wasted licence')).toMatchObject({ value: 'Yes', tone: 'danger' });
    expect(row(b, 'storage', 'Storage')).toMatchObject({ value: 'No usage reported for this user yet.' });

    const second = await driver.fetchRecords(fetchCtx(ctx, 'users'), first.cursor);
    expect(second).toMatchObject({ hasMore: false, cursor: null });
    expect((second.records[0] as LegacyDriverRecord).fields).toEqual({ name: 'carol@example.com', primaryEmail: 'carol@example.com' });
    const carol = sectionOf(second.records[0] as LegacyDriverRecord);
    expect(row(carol, 'licences', 'Assigned')).toMatchObject({ kind: 'text', value: 'None' });
    expect(row(carol, 'security', 'Wasted licence')).toMatchObject({ value: 'No' });

    // Per-run lookups are fetched once for both pages.
    expect(calls.filter((c) => c.url.startsWith(LICENSING))).toHaveLength(3); // one per licence product
    expect(calls.filter((c) => c.url.includes('/usage/users/all/dates/2026-10-05'))).toHaveLength(1);
    expect(calls.filter((c) => c.url === `${DIR}/customers/my_customer`)).toHaveLength(1);
  });

  it('flags a licensed user inactive for more than 90 days as wasted', async () => {
    installFetchTable(usersTable({
      [`${DIR}/users?`]: { body: { users: [{ ...CAROL, primaryEmail: 'alice@example.com' }] } },
    }));
    const page = await new GoogleWorkspaceDriver().fetchRecords(fetchCtx(makeCtx(), 'users'), null);
    expect(row(sectionOf(page.records[0] as LegacyDriverRecord), 'security', 'Wasted licence')).toMatchObject({ value: 'Yes' });
  });

  it('renders pooled storage as bytes rows instead of meters', async () => {
    installFetchTable(usersTable({
      [`${DIR}/users?`]: { body: { users: [ALICE] } },
      [`${REPORTS}/usage/users/all/dates/2026-10-06`]: userUsage(-1),
    }));
    const page = await new GoogleWorkspaceDriver().fetchRecords(fetchCtx(makeCtx(), 'users'), null);
    const s = sectionOf(page.records[0] as LegacyDriverRecord);
    expect(row(s, 'mailbox', 'Mailbox storage (pooled storage)')).toEqual({
      kind: 'bytes', label: 'Mailbox storage (pooled storage)', value: 4_000 * 1024 * 1024,
    });
    expect(row(s, 'storage', 'Data as of')).toMatchObject({ value: '2026-10-06' });
  });

  it('still syncs users when Licensing is forbidden and reports never arrive', async () => {
    const table = usersTable({
      [`${DIR}/users?`]: { body: { users: [ALICE] } },
      [`${LICENSING}/product/Google-Apps/users?customerId=${CUSTOMER_ID}`]: {
        status: 403, body: { error: { code: 403, errors: [{ reason: 'forbidden' }] } },
      },
      [`${REPORTS}/usage/users/all/dates/2026-10-05`]: NOT_YET,
    });
    for (const day of ['04', '03', '02', '01']) table[`${REPORTS}/usage/users/all/dates/2026-10-${day}`] = NOT_YET;
    const calls = installFetchTable(table);
    const page = await new GoogleWorkspaceDriver().fetchRecords(fetchCtx(makeCtx(), 'users'), null);
    const s = sectionOf(page.records[0] as LegacyDriverRecord);
    expect(row(s, 'licences', 'Licences')).toMatchObject({ kind: 'text', value: expect.stringMatching(/^Not available: Google denied access to the Enterprise License Manager API/) });
    expect(row(s, 'storage', 'Storage')).toMatchObject({ value: expect.stringMatching(/^Not available: Google has not published usage reports/) });
    expect(rows(s, 'security').some((r) => r.label === 'Wasted licence')).toBe(false);
    // Today - 2, then at most five steps back.
    expect(calls.filter((c) => c.url.startsWith(`${REPORTS}/usage/users/all/dates/`))).toHaveLength(6);
  });

  it('steps back a day when Reports answers HTTP 400 for a date', async () => {
    const calls = installFetchTable(usersTable({
      [`${DIR}/users?`]: { body: { users: [ALICE] } },
      [`${REPORTS}/usage/users/all/dates/2026-10-06`]: { status: 400, body: { error: { code: 400 } } },
    }));
    const page = await new GoogleWorkspaceDriver().fetchRecords(fetchCtx(makeCtx(), 'users'), null);
    expect(row(sectionOf(page.records[0] as LegacyDriverRecord), 'storage', 'Data as of')).toMatchObject({ value: '2026-10-05' });
    expect(calls.filter((c) => c.url.startsWith(`${REPORTS}/usage/users/all/dates/`))).toHaveLength(2);
  });

  it('turns any non-rate-limit failure of optional data into a note and still syncs users', async () => {
    const table = usersTable({
      [`${DIR}/users?`]: { body: { users: [ALICE] } },
      [`${LICENSING}/product/Google-Apps/users?customerId=${CUSTOMER_ID}`]: { status: 500, body: { error: { code: 500, message: 'raw provider text' } } },
    });
    for (const day of ['06', '05', '04', '03', '02', '01']) table[`${REPORTS}/usage/users/all/dates/2026-10-${day}`] = { status: 400, body: {} };
    installFetchTable(table);
    const page = await new GoogleWorkspaceDriver().fetchRecords(fetchCtx(makeCtx(), 'users'), null);
    expect(page.records).toHaveLength(1);
    const s = sectionOf(page.records[0] as LegacyDriverRecord);
    expect(row(s, 'licences', 'Licences')).toMatchObject({ value: 'Not available: Licence data is not available.' });
    expect(row(s, 'storage', 'Storage')).toMatchObject({ value: expect.stringMatching(/^Not available: Google has not published usage reports/) });
  });

  it('still propagates a rate limit from optional data so the page is retried', async () => {
    installFetchTable(usersTable({
      [`${DIR}/users?`]: { body: { users: [ALICE] } },
      [`${LICENSING}/product/Google-Apps/users?customerId=${CUSTOMER_ID}`]: { status: 429, body: {} },
    }));
    await expect(new GoogleWorkspaceDriver().fetchRecords(fetchCtx(makeCtx(), 'users'), null)).rejects.toBeInstanceOf(DriverRateLimitError);
  });

  it('merges Education licences and ignores products the tenant does not have', async () => {
    const calls = installFetchTable(usersTable({
      [`${DIR}/users?`]: { body: { users: [CAROL] } },
      [`${LICENSING}/product/101031/users?customerId=${CUSTOMER_ID}`]: {
        body: { items: [{ userId: 'carol@example.com', skuId: '1010310008', productId: '101031' }] },
      },
      [`${LICENSING}/product/101037/users?`]: { status: 400, body: { error: { code: 400 } } },
    }));
    const page = await new GoogleWorkspaceDriver().fetchRecords(fetchCtx(makeCtx(), 'users'), null);
    expect(row(sectionOf(page.records[0] as LegacyDriverRecord), 'licences', 'Assigned')).toMatchObject({ value: ['Education Plus'] });
    expect(calls.filter((c) => c.url.startsWith(LICENSING)).map((c) => new URL(c.url).pathname.split('/')[5]))
      .toEqual(['Google-Apps', '101031', '101037']);
  });

  it('marks licences unavailable instead of partial when the lookup exceeds the cap', async () => {
    const items = Array.from({ length: LOOKUP_ITEM_CAP + 1 }, (_, i) => ({ userId: `u${i}@example.com`, skuId: '1010020027' }));
    installFetchTable(usersTable({
      [`${DIR}/users?`]: { body: { users: [ALICE] } },
      [`${LICENSING}/product/Google-Apps/users?customerId=${CUSTOMER_ID}`]: { body: { items } },
    }));
    const page = await new GoogleWorkspaceDriver().fetchRecords(fetchCtx(makeCtx(), 'users'), null);
    expect(row(sectionOf(page.records[0] as LegacyDriverRecord), 'licences', 'Licences')).toMatchObject({
      value: expect.stringMatching(/more than 50,000 entries/),
    });
  });

  it('marks usage unavailable when the report exceeds the cap', async () => {
    const usageReports = Array.from({ length: LOOKUP_ITEM_CAP + 1 }, (_, i) => ({ entity: { userEmail: `u${i}@example.com` } }));
    installFetchTable(usersTable({
      [`${DIR}/users?`]: { body: { users: [ALICE] } },
      [`${REPORTS}/usage/users/all/dates/2026-10-06`]: { body: { usageReports } },
    }));
    const page = await new GoogleWorkspaceDriver().fetchRecords(fetchCtx(makeCtx(), 'users'), null);
    expect(row(sectionOf(page.records[0] as LegacyDriverRecord), 'storage', 'Storage')).toMatchObject({
      value: expect.stringMatching(/more than 50,000 entries/),
    });
  });

  it('evicts the run cache when a resource finishes', async () => {
    installFetchTable(usersTable());
    const driver = new GoogleWorkspaceDriver();
    const ctx = makeCtx();
    const first = await driver.fetchRecords(fetchCtx(ctx, 'users'), null);
    expect(__googleWorkspaceRunCacheSizeForTests()).toBeGreaterThan(0);
    await driver.fetchRecords(fetchCtx(ctx, 'users'), first.cursor);
    expect(__googleWorkspaceRunCacheSizeForTests()).toBe(0);
  });
});

describe('GoogleWorkspaceDriver tenant', () => {
  it('summarises licences, storage and security posture in one record', async () => {
    installFetchTable({
      ...BASE_TABLE,
      [`${DIR}/users?`]: { body: { users: [ALICE, BOB, CAROL] } },
      [`${LICENSING}/product/Google-Apps/users?customerId=${CUSTOMER_ID}`]: { body: LICENCES },
      [`${REPORTS}/usage/dates/2026-10-06`]: {
        body: { usageReports: [{ parameters: usageParams(500_000, 2_000_000, 100_000, 300_000, 100_000) }] },
      },
    });
    const page = await new GoogleWorkspaceDriver().fetchRecords(fetchCtx(makeCtx(), 'tenant'), null);
    expect(page).toMatchObject({ hasMore: false, cursor: null });
    const tenant = page.records[0] as LegacyDriverRecord;
    expect(tenant.externalId).toBe(CUSTOMER_ID);
    expect(tenant.fields).toEqual({ name: 'example.com', customerId: CUSTOMER_ID, primary_domain: 'example.com' });
    const s = sectionOf(tenant);
    expect(row(s, 'overview', 'Primary domain')).toBeUndefined();
    expect(row(s, 'overview', 'Customer ID')).toBeUndefined();
    expect(row(s, 'overview', 'Created')).toMatchObject({ kind: 'datetime' });
    expect(row(s, 'overview', 'Active users')).toMatchObject({ value: 2 });
    expect(row(s, 'overview', 'Suspended users')).toMatchObject({ value: 1 });
    expect(row(s, 'licences', 'Google Workspace Business Standard')).toMatchObject({ kind: 'number', value: 1 });
    expect(row(s, 'licences', 'Business Starter')).toMatchObject({ value: 1 });
    expect(row(s, 'storage', 'Total storage')).toMatchObject({ kind: 'meter', used: 500_000, total: 2_000_000 });
    expect(row(s, 'storage', 'Shared drives')).toMatchObject({ kind: 'meter', used: 100_000 });
    expect(row(s, 'storage', 'Data as of')).toMatchObject({ value: '2026-10-06' });
    expect(row(s, 'security', '2-step verification coverage')).toEqual({
      kind: 'meter', label: '2-step verification coverage', used: 1, total: 2, unit: 'count', higherIsBetter: true,
    });
    expect(row(s, 'security', 'Super admins')).toMatchObject({ value: 1 });
    expect(row(s, 'security', 'Wasted licences')).toMatchObject({ value: 1 });
  });
});

describe('GoogleWorkspaceDriver groups and devices', () => {
  const table: Record<string, Reply> = {
    ...BASE_TABLE,
    [`${DIR}/groups?`]: {
      body: { groups: [{ id: 'g1', email: 'staff@example.com', name: 'Staff', description: 'All <b>staff</b>', directMembersCount: '75' }] },
    },
    [`${DIR}/groups/g1/members`]: {
      body: { members: [{ email: 'alice@example.com', role: 'OWNER' }, { email: 'bob@example.com', role: 'MEMBER' }] },
    },
    [`${DIR}/customer/my_customer/domains`]: {
      body: {
        domains: [{
          domainName: 'example.com', isPrimary: true, verified: true, creationTime: '1577934245000',
          domainAliases: [{ domainAliasName: 'example.org', parentDomainName: 'example.com', verified: false }],
        }],
      },
    },
    [`${DIR}/customer/my_customer/devices/chromeos?`]: {
      body: {
        chromeosdevices: [{
          deviceId: 'dev-1', serialNumber: 'SN123', model: 'Example Chromebook', status: 'ACTIVE',
          osVersion: '128.0', lastSync: '2026-10-07T10:00:00.000Z', annotatedUser: 'alice@example.com',
          orgUnitPath: '/Staff', macAddress: '001122AABBCC', autoUpdateExpiration: '1780272000000',
          lastKnownNetwork: [{ ipAddress: '192.0.2.10', wanIpAddress: '198.51.100.7' }],
        }, {
          deviceId: 'dev-2', serialNumber: 'SN124', status: 'DISABLED', macAddress: 'not-a-mac',
          recentUsers: [{ email: 'carol@example.com', type: 'USER_TYPE_MANAGED' }],
          lastKnownNetwork: [{ ipAddress: 'unknown' }],
        }],
      },
    },
    [`${DIR}/customer/my_customer/devices/mobile?`]: {
      body: {
        mobiledevices: [{
          resourceId: 'm-1', serialNumber: 'PH1', model: 'Example Phone', os: 'Android 15', type: 'ANDROID',
          email: ['bob@example.com'], status: 'APPROVED', lastSync: '2026-10-06T09:00:00.000Z',
          deviceCompromisedStatus: 'No compromise detected',
          brand: 'Example', manufacturer: 'Example Corp', imei: '490154203237518', wifiMacAddress: 'AA-BB-CC-00-11-22',
        }],
      },
    },
  };

  async function only(resourceKey: string) {
    const page = await new GoogleWorkspaceDriver().fetchRecords(fetchCtx(makeCtx(), resourceKey), null);
    return page.records as LegacyDriverRecord[];
  }

  it('groups: member list, count and plain-text description', async () => {
    installFetchTable(table);
    const [g] = await only('groups');
    // The description is a layout field now, cleaned to plain text.
    expect(g!.fields).toEqual({ name: 'Staff', email: 'staff@example.com', description: 'All < b>staff< /b>' });
    const s = sectionOf(g!);
    expect(row(s, 'group', 'Members')).toMatchObject({ value: 75 });
    expect(row(s, 'group', 'Members (first 2)')).toMatchObject({ value: ['alice@example.com (owner)', 'bob@example.com'] });
    expect(row(s, 'group', 'Description')).toBeUndefined();
    expect(row(s, 'group', 'Email')).toBeUndefined();
  });

  it('domains: no longer an asset resource (they feed Domains monitoring)', async () => {
    installFetchTable(table);
    await expect(only('domains')).rejects.toThrow('Unknown Google Workspace resource: domains');
  });

  it('skips Chrome and mobile devices when the account lacks the device privilege (HTTP 403)', async () => {
    installFetchTable({
      ...table,
      [`${DIR}/customer/my_customer/devices/chromeos?`]: { status: 403, body: { error: { errors: [{ reason: 'forbidden' }] } } },
      [`${DIR}/customer/my_customer/devices/mobile?`]: { status: 403, body: { error: { errors: [{ reason: 'forbidden' }] } } },
    });
    await expect(only('chrome_devices')).rejects.toBeInstanceOf(DriverResourceUnavailableError);
    await expect(only('mobile_devices')).rejects.toThrow('so mobile devices are skipped');
  });

  it('still fails a device listing whose API is disabled (configuration, not data)', async () => {
    installFetchTable({
      ...table,
      [`${DIR}/customer/my_customer/devices/chromeos?`]: { status: 403, body: { error: { errors: [{ reason: 'accessNotConfigured' }] } } },
    });
    await expect(only('chrome_devices')).rejects.toBeInstanceOf(DriverAuthError);
  });

  it('chrome devices: serial match key, standard facts, and the expiry as an optional date field', async () => {
    installFetchTable(table);
    const [d, bare] = await only('chrome_devices');
    expect(d!.externalId).toBe('dev-1');
    expect(d!.fields).toEqual({
      name: 'Example Chromebook SN123', serialNumber: 'SN123', autoUpdateExpiration: '2026-06-01',
      model: 'Example Chromebook', operating_system: 'ChromeOS 128.0', mac_address: '00:11:22:aa:bb:cc', ip_address: '192.0.2.10',
    });
    const s = sectionOf(d!);
    expect(row(s, 'chrome', 'Auto-update expiration')).toEqual({ kind: 'date', label: 'Auto-update expiration', value: '2026-06-01' });
    expect(row(s, 'chrome', 'Updates')).toMatchObject({ value: 'Expired' });
    expect(row(s, 'chrome', 'Last user')).toMatchObject({ value: 'alice@example.com' });
    expect(row(s, 'chrome', 'Org unit')).toMatchObject({ value: '/Staff' });
    for (const label of ['Model', 'Serial number', 'OS version', 'MAC address']) expect(row(s, 'chrome', label)).toBeUndefined();
    // Unreported or malformed facts are omitted, never cleared; the last user falls back to recentUsers.
    expect(bare!.fields).toEqual({ name: 'SN124', serialNumber: 'SN124', autoUpdateExpiration: null });
    expect(row(sectionOf(bare!), 'chrome', 'Last user')).toMatchObject({ value: 'carol@example.com' });
  });

  it('mobile devices: device group', async () => {
    installFetchTable(table);
    const [d] = await only('mobile_devices');
    expect(d!.fields).toEqual({
      name: 'Example Phone PH1', serialNumber: 'PH1', model: 'Example Phone', manufacturer: 'Example',
      operating_system: 'Android 15', imei: '490154203237518', mac_address: 'aa:bb:cc:00:11:22',
    });
    const s = sectionOf(d!);
    expect(row(s, 'device', 'Compromised')).toMatchObject({ tone: 'success' });
    expect(row(s, 'device', 'Owner')).toMatchObject({ value: ['bob@example.com'] });
    for (const label of ['Model', 'Serial number', 'OS']) expect(row(s, 'device', label)).toBeUndefined();
  });
});

describe('GoogleWorkspaceDriver is read-only', () => {
  it('never issues a non-GET request to a Google API', async () => {
    const calls = installFetchTable({
      ...BASE_TABLE,
      [`${DIR}/users?`]: { body: { users: [ALICE] } },
      [`${LICENSING}/`]: { body: LICENCES },
      [`${REPORTS}/`]: userUsage(),
      [`${DIR}/groups?`]: { body: { groups: [{ id: 'g1', email: 'staff@example.com' }] } },
      [`${DIR}/groups/g1/members`]: { body: { members: [] } },
      [`${DIR}/customer/my_customer/`]: { body: {} },
    });
    const driver = new GoogleWorkspaceDriver();
    const ctx = makeCtx();
    await driver.testConnection(ctx);
    for (const resource of driver.descriptor.resources) {
      await driver.fetchRecords(fetchCtx(ctx, resource.key), null);
    }
    const apiCalls = calls.filter((c) => !c.url.startsWith(TOKEN_URL));
    expect(apiCalls.length).toBeGreaterThan(8);
    expect(apiCalls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});

describe('listWorkspaceDomains', () => {
  const domainsTable = (body: unknown): Record<string, Reply> => ({
    ...BASE_TABLE,
    [`${DIR}/customer/my_customer/domains`]: { body },
  });

  it('returns verified domains and aliases with their role, normalized, without Google defaults', async () => {
    installFetchTable(domainsTable({
      domains: [
        {
          domainName: ' Example.COM. ', isPrimary: true, verified: true,
          domainAliases: [
            { domainAliasName: 'example.org', parentDomainName: 'Example.com', verified: true },
            { domainAliasName: 'example.com.test-google-a.com', parentDomainName: 'example.com', verified: true },
            { domainAliasName: 'pending.example', parentDomainName: 'example.com', verified: false },
          ],
        },
        { domainName: 'example.net', isPrimary: false, verified: true },
        { domainName: 'unverified.example', isPrimary: false, verified: false },
        { domainName: 'example.googleapps.com', isPrimary: false, verified: true },
      ],
    }));
    await expect(listWorkspaceDomains(makeCtx(), CUSTOMER_ID)).resolves.toEqual([
      { hostname: 'example.com', role: 'PRIMARY', aliasOf: null },
      { hostname: 'example.org', role: 'ALIAS', aliasOf: 'example.com' },
      { hostname: 'example.net', role: 'SECONDARY', aliasOf: null },
    ]);
  });

  it('refuses a connection that belongs to a different tenant than the mapped one', async () => {
    const calls = installFetchTable(domainsTable({ domains: [{ domainName: 'example.com', isPrimary: true, verified: true }] }));
    await expect(listWorkspaceDomains(makeCtx(), 'C0other')).rejects.toBeInstanceOf(DriverAuthError);
    expect(calls.some((c) => c.url.includes('/domains'))).toBe(false);
  });
});
