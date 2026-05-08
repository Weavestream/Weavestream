import {
  DriverAuthError,
  DriverRateLimitError,
  type FetchRecordsContext,
  type IntegrationContext,
} from '../integration-driver.js';
import { NinjaOneDriver } from './ninjaone.driver.js';

/**
 * Phase 11 — NinjaOne driver behavioural tests.
 *
 * Mirrors the Action1 driver tests: a `globalThis.fetch` shim returns
 * scripted `Response` objects so we can exercise the OAuth2 token
 * exchange, source-org / device pagination, cursor semantics, 429
 * retry, and `DriverAuthError` mapping for 401/403 — all without
 * touching the live NinjaOne API.
 */

type ScriptedResponse =
  | {
      kind: 'json';
      status?: number;
      body: unknown;
      headers?: Record<string, string>;
    }
  | {
      kind: 'text';
      status: number;
      body: string;
      headers?: Record<string, string>;
    };

interface RecordedCall {
  url: string;
  method: string;
  body?: string;
  headers?: Record<string, string>;
}

function installFetchScript(script: ScriptedResponse[]) {
  const calls: RecordedCall[] = [];
  let i = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
      headers: init?.headers as Record<string, string> | undefined,
    });
    const next = script[i++];
    if (!next) {
      throw new Error(`NinjaOne driver test: unscripted fetch to ${url}`);
    }
    if (next.kind === 'json') {
      return new Response(JSON.stringify(next.body), {
        status: next.status ?? 200,
        headers: { 'content-type': 'application/json', ...next.headers },
      });
    }
    return new Response(next.body, {
      status: next.status,
      headers: { 'content-type': 'text/plain', ...next.headers },
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const HTTP = { timeoutMs: 5_000, maxRetries: 2, backoffMs: 1 };

/**
 * Tag a test device record as an agent device so it survives the
 * `records` resource's `deviceType === 'AgentDevice'` filter. Most
 * tests in this spec model agented endpoints; tests covering the
 * resource-branching logic explicitly use raw `deviceType` values
 * instead of going through this helper.
 */
function agent<T extends object>(rec: T): T & { deviceType: 'AgentDevice' } {
  return { deviceType: 'AgentDevice', ...rec } as T & {
    deviceType: 'AgentDevice';
  };
}

function makeCtx(): IntegrationContext {
  return {
    integrationId: 'int-1',
    config: { baseUrl: 'https://app.ninjarmm.com' },
    secret: { apiKey: 'k', apiSecret: 's' },
    correlationId: 'test-corr',
    http: HTTP,
  } as IntegrationContext;
}

function makeFetchCtx(orgId = '7'): FetchRecordsContext {
  return {
    ...makeCtx(),
    externalOrgId: orgId,
    resourceKey: 'records',
    filter: {},
  } as FetchRecordsContext;
}

describe('NinjaOneDriver.testConnection', () => {
  it('exchanges credentials and returns the org count', async () => {
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      {
        kind: 'json',
        // NinjaOne returns a bare array of orgs, NOT an envelope.
        body: [
          { id: 1, name: 'Acme', description: 'HQ' },
          { id: 2, name: 'Globex' },
        ],
      },
    ]);
    try {
      const out = await new NinjaOneDriver().testConnection(makeCtx());
      expect(out).toEqual({
        ok: true,
        details: 'Reached NinjaOne (2 organisations).',
      });
      // OAuth2 lives at /ws/oauth/token relative to the base URL.
      expect(fx.calls[0]!.url).toBe('https://app.ninjarmm.com/ws/oauth/token');
      expect(fx.calls[0]!.method).toBe('POST');
      expect(fx.calls[0]!.body).toContain('client_id=k');
      expect(fx.calls[0]!.body).toContain('client_secret=s');
      expect(fx.calls[0]!.body).toContain('grant_type=client_credentials');
      expect(fx.calls[0]!.body).toContain('scope=monitoring');
      // First org-page request omits `after` (default = 0).
      expect(fx.calls[1]!.url).toBe(
        'https://app.ninjarmm.com/v2/organizations?pageSize=200',
      );
    } finally {
      fx.restore();
    }
  });

  it('maps 401 from /ws/oauth/token to DriverAuthError', async () => {
    const fx = installFetchScript([{ kind: 'text', status: 401, body: 'no' }]);
    try {
      await expect(
        new NinjaOneDriver().testConnection(makeCtx()),
      ).rejects.toBeInstanceOf(DriverAuthError);
    } finally {
      fx.restore();
    }
  });

  it('throws DriverAuthError when the token response omits access_token', async () => {
    const fx = installFetchScript([{ kind: 'json', body: { token_type: 'Bearer' } }]);
    try {
      await expect(
        new NinjaOneDriver().testConnection(makeCtx()),
      ).rejects.toBeInstanceOf(DriverAuthError);
    } finally {
      fx.restore();
    }
  });
});

describe('NinjaOneDriver.listSourceOrgs', () => {
  it('flattens the NinjaOne org payload into SourceOrgDto[]', async () => {
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      {
        kind: 'json',
        body: [
          { id: 9, name: 'Wayne Enterprises', description: 'Gotham HQ' },
          { id: 10, name: 'Stark Industries' },
        ],
      },
    ]);
    try {
      const orgs = await new NinjaOneDriver().listSourceOrgs(makeCtx());
      expect(orgs).toEqual([
        { externalId: '9', name: 'Wayne Enterprises', hint: 'Gotham HQ' },
        { externalId: '10', name: 'Stark Industries', hint: null },
      ]);
    } finally {
      fx.restore();
    }
  });

  it('paginates via after=<lastId> when the first page is full', async () => {
    // 200 orgs in the first page (== pageSize), then a short tail of 5.
    const firstPage = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1,
      name: `Org ${i + 1}`,
    }));
    const secondPage = Array.from({ length: 5 }, (_, i) => ({
      id: 201 + i,
      name: `Org ${201 + i}`,
    }));
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      { kind: 'json', body: firstPage },
      { kind: 'json', body: secondPage },
    ]);
    try {
      const orgs = await new NinjaOneDriver().listSourceOrgs(makeCtx());
      expect(orgs).toHaveLength(205);
      expect(orgs[0]).toEqual({
        externalId: '1',
        name: 'Org 1',
        hint: null,
      });
      expect(orgs[204]).toEqual({
        externalId: '205',
        name: 'Org 205',
        hint: null,
      });
      // Token + 2 org-page fetches.
      expect(fx.calls).toHaveLength(3);
      expect(fx.calls[1]!.url).toBe(
        'https://app.ninjarmm.com/v2/organizations?pageSize=200',
      );
      // Second page advances past the last id seen.
      expect(fx.calls[2]!.url).toBe(
        'https://app.ninjarmm.com/v2/organizations?pageSize=200&after=200',
      );
    } finally {
      fx.restore();
    }
  });
});

describe('NinjaOneDriver.listSourceFields', () => {
  it('probes the live device schema and unions discovered keys with the curated catalogue', async () => {
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      {
        kind: 'json',
        body: [
          {
            id: 101,
            systemName: 'host-1.lan',
            dnsName: 'host-1.lan',
            nodeClass: 'WINDOWS_WORKSTATION',
            organizationId: 7,
            locationId: 3,
            lastContact: 1714000000.123,
            lastUpdate: 1714000500,
            offline: false,
            customAgentField: 'tenant-only',
            // Nested objects must be skipped.
            os: { name: 'Windows 11', build: '22631' },
          },
          {
            id: 102,
            systemName: 'host-2.lan',
            nodeClass: 'WINDOWS_SERVER',
            organizationId: 7,
            locationId: 3,
            lastContact: 1714003000,
            offline: true,
            customAgentField: null,
          },
        ].map(agent),
      },
    ]);
    try {
      const fields = await new NinjaOneDriver().listSourceFields({
        ...makeCtx(),
        externalOrgId: '7',
        resourceKey: 'records',
      });
      const keys = fields.map((f) => f.key);
      expect(keys).toEqual(
        expect.arrayContaining([
          'systemName',
          'dnsName',
          'nodeClass',
          'organizationId',
          'locationId',
          'lastContact',
          'lastUpdate',
          'offline',
          'customAgentField',
        ]),
      );
      // `id` is the externalId — never user-mappable.
      expect(keys).not.toContain('id');
      // Nested objects/arrays are filtered out.
      expect(keys).not.toContain('os');

      // Curated overrides win on label + hintType.
      const lastContact = fields.find((f) => f.key === 'lastContact')!;
      expect(lastContact.label).toBe('Last contact');
      expect(lastContact.hintType).toBe('DATETIME');
      const nodeClass = fields.find((f) => f.key === 'nodeClass')!;
      expect(nodeClass.label).toBe('Node class');
      expect(nodeClass.hintType).toBe('TEXT');

      // Auto-derived fields humanise + infer correctly.
      const customField = fields.find((f) => f.key === 'customAgentField')!;
      expect(customField.label).toBe('Custom Agent Field');
      expect(customField.hintType).toBe('TEXT');
      // `customAgentField` is null in record 2 → not always-present.
      expect(customField.alwaysPresent).toBe(false);

      // Sorted by label.
      const labels = fields.map((f) => f.label);
      expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    } finally {
      fx.restore();
    }
  });

  it('falls back to the curated catalogue when the probe fails', async () => {
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      { kind: 'text', status: 500, body: 'oops' },
      { kind: 'text', status: 500, body: 'oops' },
      { kind: 'text', status: 500, body: 'oops' },
    ]);
    try {
      const fields = await new NinjaOneDriver().listSourceFields({
        ...makeCtx(),
        externalOrgId: '7',
        resourceKey: 'records',
      });
      expect(fields.length).toBeGreaterThan(5);
      expect(fields.map((f) => f.key)).toEqual(
        expect.arrayContaining(['systemName', 'nodeClass', 'lastContact']),
      );
    } finally {
      fx.restore();
    }
  });

  it('surfaces flattened reference fields (warranty, owner, role, policy, location) and tags from the sample', async () => {
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      {
        kind: 'json',
        body: [
          {
            id: 42,
            systemName: 'host-42.lan',
            nodeClass: 'WINDOWS_SERVER',
            organizationId: 7,
            locationId: 3,
            tags: ['critical'],
            references: {
              warranty: { startDate: 1577836800, endDate: 1735689600 },
              assignedOwner: {
                firstName: 'Ada',
                email: 'ada@example.com',
                enabled: true,
              },
              role: { name: 'Domain Controller', nodeClass: 'WINDOWS_SERVER' },
              policy: { name: 'Production Servers', nodeClass: 'WINDOWS_SERVER' },
              location: { name: 'Datacenter West', address: '1 Server Lane' },
            },
          },
        ].map(agent),
      },
    ]);
    try {
      const fields = await new NinjaOneDriver().listSourceFields({
        ...makeCtx(),
        externalOrgId: '7',
        resourceKey: 'records',
      });
      const keys = fields.map((f) => f.key);
      expect(keys).toEqual(
        expect.arrayContaining([
          'warrantyStartDate',
          'warrantyEndDate',
          'assignedOwnerFirstName',
          'assignedOwnerEmail',
          'assignedOwnerEnabled',
          'roleName',
          'policyName',
          'locationName',
          'locationAddress',
          'tags',
        ]),
      );
      // The raw nested blocks must NOT surface as un-mappable objects.
      expect(keys).not.toContain('references');
      expect(keys).not.toContain('maintenance');
      expect(keys).not.toContain('userData');

      // Curated overrides win on label + hintType for promoted keys.
      const warrantyEnd = fields.find((f) => f.key === 'warrantyEndDate')!;
      expect(warrantyEnd.label).toBe('Warranty end');
      expect(warrantyEnd.hintType).toBe('DATETIME');
      const ownerEmail = fields.find((f) => f.key === 'assignedOwnerEmail')!;
      expect(ownerEmail.label).toBe('Assigned owner email');
      expect(ownerEmail.hintType).toBe('EMAIL');
      const tags = fields.find((f) => f.key === 'tags')!;
      expect(tags.hintType).toBe('TAGS');
    } finally {
      fx.restore();
    }
  });

  it('falls back to the curated catalogue when the org is empty', async () => {
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      { kind: 'json', body: [] },
    ]);
    try {
      const fields = await new NinjaOneDriver().listSourceFields({
        ...makeCtx(),
        externalOrgId: '7',
        resourceKey: 'records',
      });
      expect(fields.length).toBeGreaterThan(5);
      expect(fields.map((f) => f.key)).toEqual(
        expect.arrayContaining(['systemName', 'nodeClass']),
      );
    } finally {
      fx.restore();
    }
  });
});

describe('NinjaOneDriver.fetchRecords', () => {
  it('paginates via after=<lastId> and stops on a short page', async () => {
    const firstPage = Array.from({ length: 200 }, (_, i) =>
      agent({
        id: i + 1,
        systemName: `host-${i + 1}`,
        lastContact: 1714000000,
      }),
    );
    const secondPage = Array.from({ length: 20 }, (_, i) =>
      agent({
        id: 201 + i,
        systemName: `host-${201 + i}`,
      }),
    );
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      { kind: 'json', body: firstPage },
      { kind: 'json', body: { access_token: 'tok-1' } },
      { kind: 'json', body: secondPage },
    ]);
    try {
      const driver = new NinjaOneDriver();
      const page1 = await driver.fetchRecords(makeFetchCtx(), null);
      expect(page1.records).toHaveLength(200);
      expect(page1.records[0]).toMatchObject({
        externalId: '1',
        displayName: 'host-1',
        // Numeric epoch (seconds) is normalised to ISO milliseconds.
        updatedAt: '2024-04-24T23:06:40.000Z',
      });
      expect(page1.records[0]!.fields).toMatchObject({
        lastContact: '2024-04-24T23:06:40.000Z',
      });
      expect(page1.hasMore).toBe(true);
      expect(page1.cursor).toBe('200');

      const page2 = await driver.fetchRecords(makeFetchCtx(), page1.cursor);
      expect(page2.records).toHaveLength(20);
      expect(page2.hasMore).toBe(false);
      expect(page2.cursor).toBeNull();

      // Org scoping uses NinjaOne's `df` (Device Filter) param —
      // `?of=` is silently ignored on `/v2/devices-detailed`, which
      // would leak every visible device across orgs into the mapped
      // tenant. URLSearchParams encodes the `=` inside the value as
      // `%3D`.
      expect(fx.calls[1]!.url).toBe(
        'https://app.ninjarmm.com/v2/devices-detailed?df=org%3D7&pageSize=200',
      );
      expect(fx.calls[3]!.url).toBe(
        'https://app.ninjarmm.com/v2/devices-detailed?df=org%3D7&pageSize=200&after=200',
      );

      // The plain `/v2/devices` endpoint is intentionally NOT used —
      // it returns lean records without the `references` block, which
      // means warranty / owner / role / policy / location names would
      // be unavailable for mapping.
      expect(fx.calls[1]!.url).not.toContain('/v2/devices?');
      // The buggy `?of=` shortcut must never appear.
      expect(fx.calls[1]!.url).not.toContain('?of=');
      expect(fx.calls[3]!.url).not.toContain('&of=');
    } finally {
      fx.restore();
    }
  });

  it('falls back to dnsName then displayName when systemName is missing', async () => {
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      {
        kind: 'json',
        body: [
          { id: 1, dnsName: 'a.lan' },
          { id: 2, displayName: 'Edge router' },
          { id: 3 },
        ].map(agent),
      },
    ]);
    try {
      const page = await new NinjaOneDriver().fetchRecords(makeFetchCtx(), null);
      expect(page.records.map((r) => r.displayName)).toEqual([
        'a.lan',
        'Edge router',
        null,
      ]);
    } finally {
      fx.restore();
    }
  });

  it('applies the optional locationIds filter post-fetch', async () => {
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      {
        kind: 'json',
        body: [
          { id: 1, systemName: 'a.lan', locationId: 10 },
          { id: 2, systemName: 'b.lan', locationId: 20 },
          { id: 3, systemName: 'c.lan', locationId: 10 },
        ].map(agent),
      },
    ]);
    try {
      const ctx = {
        ...makeFetchCtx(),
        filter: { locationIds: [10] },
      } as FetchRecordsContext;
      const page = await new NinjaOneDriver().fetchRecords(ctx, null);
      expect(page.records.map((r) => r.externalId)).toEqual(['1', '3']);
    } finally {
      fx.restore();
    }
  });

  it('rejects an invalid cursor before issuing the device fetch', async () => {
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
    ]);
    try {
      await expect(
        new NinjaOneDriver().fetchRecords(makeFetchCtx(), 'banana'),
      ).rejects.toThrow(/Invalid NinjaOne fetch cursor/);
    } finally {
      fx.restore();
    }
  });

  it('retries once on 429 and succeeds on the next attempt', async () => {
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      {
        kind: 'text',
        status: 429,
        body: 'rate limited',
        headers: { 'Retry-After': '0' },
      },
      {
        kind: 'json',
        body: [agent({ id: 99, systemName: 'x.lan' })],
      },
    ]);
    try {
      const page = await new NinjaOneDriver().fetchRecords(makeFetchCtx(), null);
      expect(page.records).toEqual([
        {
          externalId: '99',
          displayName: 'x.lan',
          fields: { id: 99, systemName: 'x.lan', deviceType: 'AgentDevice' },
          updatedAt: null,
        },
      ]);
    } finally {
      fx.restore();
    }
  });

  it('flattens references, maintenance, and tags onto top-level fields', async () => {
    // Sample mirrors the public NinjaOne `/v2/devices-detailed` payload —
    // see the OpenAPI schema. Every `references.*` subtree the driver
    // promotes (warranty, assignedOwner, role, policy, rolePolicy,
    // location, organization) is exercised here, plus `maintenance`
    // and `tags`.
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      {
        kind: 'json',
        body: [
          {
            id: 42,
            uid: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
            assignedOwnerUid: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
            systemName: 'host-42.lan',
            netbiosName: 'HOST42',
            nodeClass: 'WINDOWS_WORKSTATION',
            organizationId: 7,
            locationId: 3,
            rolePolicyId: 11,
            policyId: 12,
            lastContact: 1714000000,
            offline: false,
            tags: ['critical', 'production'],
            userData: { customField: 'should be dropped' },
            maintenance: {
              status: 'PENDING',
              start: 1714000000,
              end: 1714003600,
              reasonMessage: 'Patch Tuesday',
            },
            references: {
              organization: { id: 7, name: 'Acme', description: 'HQ' },
              location: {
                id: 3,
                name: 'Datacenter West',
                address: '1 Server Lane',
                description: 'Primary DC',
              },
              role: {
                id: 21,
                name: 'Domain Controller',
                nodeClass: 'WINDOWS_SERVER',
                chassisType: 'RACK',
                custom: false,
                icon: 'dc.svg',
              },
              policy: {
                id: 12,
                name: 'Production Servers',
                nodeClass: 'WINDOWS_SERVER',
                parentPolicyId: 1,
              },
              rolePolicy: {
                id: 11,
                name: 'Default Server',
                nodeClass: 'WINDOWS_SERVER',
                parentPolicyId: null,
              },
              warranty: {
                startDate: 1577836800,
                endDate: 1735689600,
                manufacturerFulfillmentDate: 1577923200,
              },
              assignedOwner: {
                id: 99,
                firstName: 'Ada',
                lastName: 'Lovelace',
                email: 'ada@example.com',
                phone: '+1-555-0100',
                enabled: true,
                userType: 'TECHNICIAN',
                invitationStatus: 'REGISTERED',
              },
              // Subtrees we intentionally don't surface — confirm they
              // don't pollute the output.
              backupUsage: { revisionsCurrentSize: 100 },
              backupBandwidthThrottle: { enabled: false },
            },
          },
        ].map(agent),
      },
    ]);
    try {
      const page = await new NinjaOneDriver().fetchRecords(makeFetchCtx(), null);
      expect(page.records).toHaveLength(1);
      const fields = page.records[0]!.fields;

      // Top-level scalars pass through.
      expect(fields).toMatchObject({
        uid: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        assignedOwnerUid: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        netbiosName: 'HOST42',
        rolePolicyId: 11,
        policyId: 12,
        tags: ['critical', 'production'],
      });

      // Datetime epoch → ISO normalisation.
      expect(fields.lastContact).toBe('2024-04-24T23:06:40.000Z');
      expect(fields.warrantyStartDate).toBe('2020-01-01T00:00:00.000Z');
      expect(fields.warrantyEndDate).toBe('2025-01-01T00:00:00.000Z');
      expect(fields.warrantyManufacturerFulfillmentDate).toBe(
        '2020-01-02T00:00:00.000Z',
      );
      expect(fields.maintenanceStart).toBe('2024-04-24T23:06:40.000Z');
      expect(fields.maintenanceEnd).toBe('2024-04-25T00:06:40.000Z');

      // Reference subtree → camelCase top-level keys.
      expect(fields).toMatchObject({
        organizationName: 'Acme',
        organizationDescription: 'HQ',
        locationName: 'Datacenter West',
        locationAddress: '1 Server Lane',
        locationDescription: 'Primary DC',
        roleName: 'Domain Controller',
        roleNodeClass: 'WINDOWS_SERVER',
        roleChassisType: 'RACK',
        roleCustom: false,
        roleIcon: 'dc.svg',
        policyName: 'Production Servers',
        policyNodeClass: 'WINDOWS_SERVER',
        policyParentPolicyId: 1,
        rolePolicyName: 'Default Server',
        rolePolicyNodeClass: 'WINDOWS_SERVER',
        rolePolicyParentPolicyId: null,
        assignedOwnerFirstName: 'Ada',
        assignedOwnerLastName: 'Lovelace',
        assignedOwnerEmail: 'ada@example.com',
        assignedOwnerPhone: '+1-555-0100',
        assignedOwnerEnabled: true,
        assignedOwnerUserType: 'TECHNICIAN',
        assignedOwnerInvitationStatus: 'REGISTERED',
        maintenanceStatus: 'PENDING',
        maintenanceReason: 'Patch Tuesday',
      });

      // Raw nested blocks are dropped — they would be unmappable nested
      // objects in the field-mapping UI.
      expect(fields).not.toHaveProperty('references');
      expect(fields).not.toHaveProperty('maintenance');
      expect(fields).not.toHaveProperty('userData');
      // Subtrees we don't promote (backupUsage / backupBandwidthThrottle)
      // also leave no trace.
      expect(fields).not.toHaveProperty('backupUsage');
      expect(fields).not.toHaveProperty('backupBandwidthThrottle');
    } finally {
      fx.restore();
    }
  });

  it('drops devices whose organizationId does not match the mapping (defensive cross-org backstop)', async () => {
    // Belt-and-suspenders: even if NinjaOne's `df=org=` filter were
    // ever silently ignored upstream, devices from other orgs MUST
    // NOT land in the mapped Weavestream company. The driver filters
    // them out client-side; records missing `organizationId` are
    // kept (the upstream filter is the source of truth and we trust
    // it for records that don't carry the field).
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      {
        kind: 'json',
        body: [
          { id: 1, systemName: 'a.lan', organizationId: 7 },
          { id: 2, systemName: 'b.lan', organizationId: 99 }, // wrong org!
          { id: 3, systemName: 'c.lan', organizationId: 7 },
          { id: 4, systemName: 'd.lan' /* missing organizationId — kept */ },
        ].map(agent),
      },
    ]);
    try {
      const page = await new NinjaOneDriver().fetchRecords(makeFetchCtx('7'), null);
      expect(page.records.map((r) => r.externalId)).toEqual(['1', '3', '4']);
    } finally {
      fx.restore();
    }
  });

  it('flattens os, system, memory, processors[0] and volumes[0] from a real /v2/devices-detailed payload', async () => {
    // Sample lifted directly from a real ETVAPP4 NinjaOne device — every
    // field a Windows server reports through the agent should be
    // mappable, including OS, make/model, serial number, BIOS, CPU,
    // memory, primary volume, public IP, IP / MAC arrays, and the
    // last-logged-in user.
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      {
        kind: 'json',
        body: [
          {
            id: 38,
            uid: '194076ff-5788-43dc-8cea-326fff7345a4',
            systemName: 'ETVAPP4',
            dnsName: 'ETVAPP4',
            nodeClass: 'WINDOWS_SERVER',
            deviceType: 'AgentDevice',
            organizationId: 4,
            locationId: 4,
            policyId: 56,
            rolePolicyId: 56,
            nodeRoleId: 1002,
            approvalStatus: 'APPROVED',
            offline: false,
            tags: [],
            created: 1755816387.919423,
            lastContact: 1776780004.317,
            lastUpdate: 1776780004.317,
            lastLoggedInUser: 'ETVAPP4\\ETAdmin',
            publicIP: '162.239.158.209',
            ipAddresses: [
              '169.254.1.2',
              '10.0.0.61',
              'fe80::453f:d728:130e:f9a4',
            ],
            macAddresses: ['10:98:19:9B:E0:62', 'D4:04:E6:F8:A6:C1'],
            os: {
              name: 'Windows Server 2022 Standard Edition',
              locale: 'en-US',
              language: 'English',
              releaseId: '21H2',
              buildNumber: '20348',
              needsReboot: false,
              architecture: '64-bit',
              lastBootTime: 1765098849,
              manufacturer: 'Microsoft Corporation',
              servicePackMajorVersion: 0,
              servicePackMinorVersion: 0,
            },
            memory: { capacity: 136928935936 },
            system: {
              name: 'ETVAPP4',
              model: 'PowerEdge R660xs',
              domain: 'ENTERPRISE',
              domainRole: 'Standalone Server',
              chassisType: 'UNKNOWN',
              manufacturer: 'Dell Inc.',
              serialNumber: '7H20Q54',
              virtualMachine: false,
              biosSerialNumber: '7H20Q54',
              assetSerialNumber: '7H20Q54',
              numberOfProcessors: 1,
              totalPhysicalMemory: 136928935936,
            },
            processors: [
              {
                name: 'Intel(R) Xeon(R) Gold 5412U',
                numCores: 24,
                clockSpeed: 2100000000,
                architecture: 'x64',
                maxClockSpeed: 2100000000,
                numLogicalCores: 48,
              },
            ],
            volumes: [
              {
                name: 'D:',
                label: '',
                capacity: 4799607074816,
                deviceType: 'Local Disk',
                fileSystem: 'NTFS',
                serialNumber: 'E8EB470B',
                freeSpace: 3126422405120,
              },
              {
                name: 'C:',
                label: 'OS',
                capacity: 1916148903936,
                deviceType: 'Local Disk',
                fileSystem: 'NTFS',
                serialNumber: '28219144',
                freeSpace: 811016052736,
              },
            ],
          },
        ],
      },
    ]);
    try {
      const page = await new NinjaOneDriver().fetchRecords(makeFetchCtx('4'), null);
      expect(page.records).toHaveLength(1);
      const fields = page.records[0]!.fields;

      // Top-level scalars + string arrays.
      expect(fields).toMatchObject({
        deviceType: 'AgentDevice',
        publicIP: '162.239.158.209',
        ipAddresses: [
          '169.254.1.2',
          '10.0.0.61',
          'fe80::453f:d728:130e:f9a4',
        ],
        macAddresses: ['10:98:19:9B:E0:62', 'D4:04:E6:F8:A6:C1'],
        lastLoggedInUser: 'ETVAPP4\\ETAdmin',
      });

      // Derived scalar variants — map these onto IP_ADDRESS / TEXT /
      // rich-text fields. Skips link-local IPv4 (169.254.x.x) and
      // picks the routable IPv4 (10.0.0.61).
      expect(fields.primaryIpAddress).toBe('10.0.0.61');
      expect(fields.primaryMacAddress).toBe('10:98:19:9B:E0:62');

      // Operating system flatten + epoch normalisation on lastBootTime.
      expect(fields).toMatchObject({
        osName: 'Windows Server 2022 Standard Edition',
        osManufacturer: 'Microsoft Corporation',
        osArchitecture: '64-bit',
        osBuildNumber: '20348',
        osReleaseId: '21H2',
        osLanguage: 'English',
        osLocale: 'en-US',
        osNeedsReboot: false,
        osServicePackMajorVersion: 0,
        osServicePackMinorVersion: 0,
      });
      expect(fields.osLastBootTime).toBe('2025-12-07T09:14:09.000Z');

      // Computer system / hardware flatten — make / model / serial /
      // BIOS / chassis / domain — without clobbering top-level
      // `systemName`.
      expect(fields).toMatchObject({
        systemManufacturer: 'Dell Inc.',
        systemModel: 'PowerEdge R660xs',
        systemSerialNumber: '7H20Q54',
        systemBiosSerialNumber: '7H20Q54',
        systemAssetSerialNumber: '7H20Q54',
        systemDomain: 'ENTERPRISE',
        systemDomainRole: 'Standalone Server',
        systemChassisType: 'UNKNOWN',
        systemVirtualMachine: false,
        systemNumberOfProcessors: 1,
        systemTotalPhysicalMemory: 136928935936,
        systemName: 'ETVAPP4',
      });

      // Memory — raw + human-readable.
      expect(fields.memoryCapacity).toBe(136928935936);
      expect(fields.memoryCapacityHuman).toBe('127.5 GB');
      expect(fields.systemTotalPhysicalMemoryHuman).toBe('127.5 GB');

      // First processor — clock speed surfaced both as raw Hz and
      // human-readable GHz.
      expect(fields).toMatchObject({
        processorName: 'Intel(R) Xeon(R) Gold 5412U',
        processorNumCores: 24,
        processorNumLogicalCores: 48,
        processorClockSpeed: 2100000000,
        processorMaxClockSpeed: 2100000000,
        processorArchitecture: 'x64',
      });
      expect(fields.processorClockSpeedHuman).toBe('2.10 GHz');
      expect(fields.processorMaxClockSpeedHuman).toBe('2.10 GHz');

      // Volumes — count + first-entry summary, with both raw bytes
      // and human-readable variants for capacity / free space.
      expect(fields.volumeCount).toBe(2);
      expect(fields).toMatchObject({
        firstVolumeName: 'D:',
        firstVolumeLabel: '',
        firstVolumeFileSystem: 'NTFS',
        firstVolumeDeviceType: 'Local Disk',
        firstVolumeSerialNumber: 'E8EB470B',
        firstVolumeCapacity: 4799607074816,
        firstVolumeFreeSpace: 3126422405120,
      });
      expect(fields.firstVolumeCapacityHuman).toBe('4.4 TB');
      expect(fields.firstVolumeFreeSpaceHuman).toBe('2.8 TB');

      // Multi-line summary covering EVERY volume — drop this onto a
      // TEXTAREA / rich-text AssetField. One line per volume, each
      // with `<name>[ <label>] — <cap> total, <free> free (<fs>)`.
      expect(fields.volumesSummary).toBe(
        [
          'D: — 4.4 TB total, 2.8 TB free (NTFS)',
          'C: OS — 1.7 TB total, 755.3 GB free (NTFS)',
        ].join('\n'),
      );

      // Raw nested blocks must NOT leak through as un-mappable nested
      // objects.
      expect(fields).not.toHaveProperty('os');
      expect(fields).not.toHaveProperty('system');
      expect(fields).not.toHaveProperty('memory');
      expect(fields).not.toHaveProperty('processors');
      expect(fields).not.toHaveProperty('volumes');
    } finally {
      fx.restore();
    }
  });

  it('derives primaryIpAddress from messy ipAddresses arrays (|-joined entries, link-local skip, IPv6 fallback)', async () => {
    // Three devices probe the corners of the heuristic:
    //   1. The exact ETVAPP4 shape — `|`-joined IPv6 GUA + link-local
    //      pair, link-local IPv4, routable IPv4. Should pick the
    //      routable IPv4.
    //   2. IPv6-only host (no IPv4 at all). Should fall back to the
    //      GUA after splitting on `|`.
    //   3. Pathological host with only link-local addresses. Should
    //      fall back to the first entry rather than dropping the
    //      whole field.
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      {
        kind: 'json',
        body: [
          {
            id: 1,
            systemName: 'etvapp4',
            organizationId: 7,
            ipAddresses: [
              '169.254.1.2',
              'fde1:53ba:e9a0:de11:1c96:85c6:8728:105c|fe80::182c:1a99:8294:95d3',
              '10.0.0.61',
              'fe80::453f:d728:130e:f9a4',
            ],
            macAddresses: ['AA:BB:CC:DD:EE:01', 'AA:BB:CC:DD:EE:02'],
          },
          {
            id: 2,
            systemName: 'ipv6-only',
            organizationId: 7,
            ipAddresses: [
              'fe80::1',
              '2001:db8::abcd|fe80::dead',
            ],
            macAddresses: ['AA:BB:CC:DD:EE:03'],
          },
          {
            id: 3,
            systemName: 'link-local-only',
            organizationId: 7,
            ipAddresses: ['169.254.99.1', 'fe80::1'],
            macAddresses: [],
          },
        ].map(agent),
      },
    ]);
    try {
      const page = await new NinjaOneDriver().fetchRecords(makeFetchCtx('7'), null);
      const [a, b, c] = page.records;
      // Routable IPv4 wins over link-local IPv4 and IPv6.
      expect(a!.fields.primaryIpAddress).toBe('10.0.0.61');
      expect(a!.fields.primaryMacAddress).toBe('AA:BB:CC:DD:EE:01');
      // No IPv4 → split the `|` slot, prefer non-link-local IPv6.
      expect(b!.fields.primaryIpAddress).toBe('2001:db8::abcd');
      expect(b!.fields.primaryMacAddress).toBe('AA:BB:CC:DD:EE:03');
      // All link-local → fall back to first entry rather than dropping.
      expect(c!.fields.primaryIpAddress).toBe('169.254.99.1');
      // No MACs → no derived primary.
      expect(c!.fields.primaryMacAddress).toBeUndefined();
    } finally {
      fx.restore();
    }
  });

  it('formats bytes and Hz across unit boundaries (MB / GB / TB, MHz / GHz)', async () => {
    // Probe the formatters at the unit boundaries that real NinjaOne
    // hosts hit — sub-GB volumes on small embedded devices, multi-TB
    // server volumes, MHz-only clocks on legacy hardware, multi-GHz
    // clocks on modern silicon.
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      {
        kind: 'json',
        body: [
          {
            id: 1,
            systemName: 'small.lan',
            organizationId: 7,
            memory: { capacity: 4 * 1024 * 1024 * 1024 }, // 4 GB
            processors: [{ clockSpeed: 800_000_000, maxClockSpeed: 1_200_000_000 }],
            volumes: [{ capacity: 524_288_000, freeSpace: 100_000_000 }], // ~500 MB
          },
          {
            id: 2,
            systemName: 'big.lan',
            organizationId: 7,
            memory: { capacity: 256 * 1024 * 1024 * 1024 }, // 256 GB
            system: { totalPhysicalMemory: 256 * 1024 * 1024 * 1024 },
            processors: [{ clockSpeed: 3_500_000_000 }],
            volumes: [{ capacity: 16 * 1024 * 1024 * 1024 * 1024, freeSpace: 1024 * 1024 * 1024 }], // 16 TB / 1 GB
          },
        ].map(agent),
      },
    ]);
    try {
      const page = await new NinjaOneDriver().fetchRecords(makeFetchCtx('7'), null);
      const [small, big] = page.records;
      expect(small!.fields.memoryCapacityHuman).toBe('4.0 GB');
      // Sub-1 GHz clocks render in MHz — clearer than "0.80 GHz".
      expect(small!.fields.processorClockSpeedHuman).toBe('800 MHz');
      expect(small!.fields.processorMaxClockSpeedHuman).toBe('1.20 GHz');
      expect(small!.fields.firstVolumeCapacityHuman).toBe('500.0 MB');
      expect(small!.fields.firstVolumeFreeSpaceHuman).toBe('95.4 MB');

      expect(big!.fields.memoryCapacityHuman).toBe('256.0 GB');
      expect(big!.fields.systemTotalPhysicalMemoryHuman).toBe('256.0 GB');
      expect(big!.fields.processorClockSpeedHuman).toBe('3.50 GHz');
      expect(big!.fields.firstVolumeCapacityHuman).toBe('16.0 TB');
      expect(big!.fields.firstVolumeFreeSpaceHuman).toBe('1.0 GB');
    } finally {
      fx.restore();
    }
  });

  it('formats volumesSummary across edge cases (empty label, missing fs, missing freeSpace, single volume)', async () => {
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      {
        kind: 'json',
        body: [
          // Single-volume host without a filesystem.
          {
            id: 1,
            systemName: 'one.lan',
            organizationId: 7,
            volumes: [
              { name: '/', label: '', capacity: 100_000_000_000, freeSpace: 50_000_000_000 },
            ],
          },
          // Volume with no freeSpace (NinjaOne sometimes omits it on
          // network shares / read-only mounts).
          {
            id: 2,
            systemName: 'two.lan',
            organizationId: 7,
            volumes: [
              { name: 'Z:', label: 'Network', capacity: 1_000_000_000_000, fileSystem: 'CIFS' },
            ],
          },
          // Volume with only a name.
          {
            id: 3,
            systemName: 'three.lan',
            organizationId: 7,
            volumes: [{ name: '/dev/sda1' }],
          },
        ].map(agent),
      },
    ]);
    try {
      const page = await new NinjaOneDriver().fetchRecords(makeFetchCtx('7'), null);
      const [a, b, c] = page.records;
      // No filesystem → no `(fs)` tag, no double space.
      expect(a!.fields.volumesSummary).toBe(
        '/ — 93.1 GB total, 46.6 GB free',
      );
      // No freeSpace → still renders capacity-only line.
      expect(b!.fields.volumesSummary).toBe(
        'Z: Network — 931.3 GB total (CIFS)',
      );
      // Name-only → just the name.
      expect(c!.fields.volumesSummary).toBe('/dev/sda1');
    } finally {
      fx.restore();
    }
  });

  it('throws a clear error when called with an unexpected resourceKey (defensive guard against stale IntegrationResource rows)', async () => {
    // Stale `IntegrationResource` rows from earlier driver iterations
    // would silently double-process every device — once per resource
    // — and create duplicate assets in parallel. The driver advertises
    // only 'records' and 'nms'; anything else hard-fails so the
    // regression surfaces in the run viewer instead of corrupting
    // tenant data.
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
    ]);
    try {
      const ctx = {
        ...makeFetchCtx('7'),
        resourceKey: 'wat',
      } as FetchRecordsContext;
      await expect(
        new NinjaOneDriver().fetchRecords(ctx, null),
      ).rejects.toThrow(/unexpected resourceKey "wat"/);

      await expect(
        new NinjaOneDriver().listSourceFields({
          ...makeCtx(),
          externalOrgId: '7',
          resourceKey: 'wat',
        }),
      ).rejects.toThrow(/unexpected resourceKey "wat"/);
    } finally {
      fx.restore();
    }
  });

  it('records resource: yields only AgentDevice rows (NMS / VirtualMachine / missing-deviceType filtered out)', async () => {
    // Mixed batch matching what NinjaOne returns when a tenant uses
    // both the agent and SNMP / hypervisor discovery. The 'records'
    // resource must yield only the agented endpoint and drop everything
    // else — that's what stops the duplicate-asset pollution we hit
    // when a single resource handled all device types and matchByKey
    // raced across them.
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      {
        kind: 'json',
        body: [
          { id: 1, systemName: 'agented.lan', organizationId: 7, deviceType: 'AgentDevice' },
          { id: 2, systemName: 'switch.lan', organizationId: 7, deviceType: 'NMSDevice' },
          { id: 3, systemName: 'guestvm.lan', organizationId: 7, deviceType: 'VirtualMachine' },
          { id: 4, systemName: 'unknown.lan', organizationId: 7 /* missing deviceType */ },
        ],
      },
    ]);
    try {
      const page = await new NinjaOneDriver().fetchRecords(
        { ...makeFetchCtx('7'), resourceKey: 'records' } as FetchRecordsContext,
        null,
      );
      expect(page.records.map((r) => r.externalId)).toEqual(['1']);
    } finally {
      fx.restore();
    }
  });

  it('nms resource: yields only non-AgentDevice rows (NMS, VirtualMachine, missing-deviceType all kept)', async () => {
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      {
        kind: 'json',
        body: [
          { id: 1, systemName: 'agented.lan', organizationId: 7, deviceType: 'AgentDevice' },
          { id: 2, systemName: 'switch.lan', organizationId: 7, deviceType: 'NMSDevice' },
          { id: 3, systemName: 'guestvm.lan', organizationId: 7, deviceType: 'VirtualMachine' },
          { id: 4, systemName: 'unknown.lan', organizationId: 7 /* missing deviceType */ },
        ],
      },
    ]);
    try {
      const page = await new NinjaOneDriver().fetchRecords(
        { ...makeFetchCtx('7'), resourceKey: 'nms' } as FetchRecordsContext,
        null,
      );
      // Agented device dropped; NMS, VirtualMachine, and the missing-
      // deviceType straggler all kept so a managed endpoint never
      // silently disappears because of a missing field on the upstream.
      expect(page.records.map((r) => r.externalId)).toEqual(['2', '3', '4']);
    } finally {
      fx.restore();
    }
  });

  it('throws DriverRateLimitError when the retry budget is exhausted', async () => {
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      { kind: 'text', status: 429, body: '', headers: { 'Retry-After': '0' } },
      { kind: 'text', status: 429, body: '', headers: { 'Retry-After': '0' } },
      { kind: 'text', status: 429, body: '', headers: { 'Retry-After': '0' } },
    ]);
    try {
      await expect(
        new NinjaOneDriver().fetchRecords(makeFetchCtx(), null),
      ).rejects.toBeInstanceOf(DriverRateLimitError);
    } finally {
      fx.restore();
    }
  });
});
