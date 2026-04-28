import {
  DriverAuthError,
  DriverRateLimitError,
  type FetchRecordsContext,
  type IntegrationContext,
} from '../integration-driver.js';
import { UniFiSiteManagerDriver } from './unifi.driver.js';

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
      throw new Error(`UniFi driver test: unscripted fetch to ${url}`);
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

const HOST_A = '9C05D6AC0FF7000000000805D60E000000000872D0910000000066234FA1:2119181625';
const HOST_B = 'F492BF90D66200000000051E5AC9000000000559A1F2000000005F95833C:753331971';

function makeCtx(): IntegrationContext {
  return {
    config: { baseUrl: 'https://api.ui.com' },
    secret: { apiKey: 'unifi-key' },
    correlationId: 'test-corr',
    http: HTTP,
  } as IntegrationContext;
}

function makeFetchCtx(hostId = HOST_A): FetchRecordsContext {
  return {
    ...makeCtx(),
    externalOrgId: hostId,
    filter: {},
  } as FetchRecordsContext;
}

describe('UniFiSiteManagerDriver.testConnection', () => {
  it('uses X-API-Key auth and reports site visibility', async () => {
    const fx = installFetchScript([
      {
        kind: 'json',
        body: {
          data: [
            { hostId: HOST_A, hostName: 'Jaffe Chiropractic', devices: [] },
          ],
          nextToken: null,
        },
      },
    ]);
    try {
      const out = await new UniFiSiteManagerDriver().testConnection(makeCtx());
      expect(out).toEqual({
        ok: true,
        details: 'Reached UniFi Site Manager (at least 1 site visible).',
      });
      expect(fx.calls[0]!.url).toBe('https://api.ui.com/v1/devices?pageSize=1');
      expect(fx.calls[0]!.headers).toMatchObject({
        'X-API-Key': 'unifi-key',
        Accept: 'application/json',
      });
    } finally {
      fx.restore();
    }
  });

  it('maps 401/403 to DriverAuthError', async () => {
    const fx = installFetchScript([{ kind: 'text', status: 403, body: 'no' }]);
    try {
      await expect(
        new UniFiSiteManagerDriver().testConnection(makeCtx()),
      ).rejects.toBeInstanceOf(DriverAuthError);
    } finally {
      fx.restore();
    }
  });
});

describe('UniFiSiteManagerDriver.listSourceOrgs', () => {
  it('walks /v1/devices, dedupes hosts, and uses hostName for the friendly label', async () => {
    const fx = installFetchScript([
      {
        kind: 'json',
        body: {
          data: [
            { hostId: HOST_A, hostName: 'Jaffe Chiropractic', devices: [] },
            { hostId: HOST_B, hostName: 'Acme HQ', devices: [] },
          ],
          nextToken: 'next-1',
        },
      },
      {
        kind: 'json',
        body: {
          // HOST_A reappears on a later page (paginated devices) — must
          // not produce a duplicate org.
          data: [{ hostId: HOST_A, hostName: 'Jaffe Chiropractic', devices: [] }],
          nextToken: null,
        },
      },
    ]);
    try {
      const orgs = await new UniFiSiteManagerDriver().listSourceOrgs(makeCtx());
      expect(orgs).toEqual([
        { externalId: HOST_A, name: 'Jaffe Chiropractic', hint: null },
        { externalId: HOST_B, name: 'Acme HQ', hint: null },
      ]);
      expect(fx.calls).toHaveLength(2);
      expect(fx.calls[0]!.url).toBe(
        'https://api.ui.com/v1/devices?pageSize=200',
      );
      expect(fx.calls[1]!.url).toContain('nextToken=next-1');
    } finally {
      fx.restore();
    }
  });

  it('falls back to the hostId when the host has no name and surfaces a hint', async () => {
    const fx = installFetchScript([
      {
        kind: 'json',
        body: {
          data: [{ hostId: HOST_A, devices: [] }],
          nextToken: null,
        },
      },
    ]);
    try {
      const orgs = await new UniFiSiteManagerDriver().listSourceOrgs(makeCtx());
      expect(orgs).toEqual([
        {
          externalId: HOST_A,
          name: HOST_A,
          hint: 'Host name not reported',
        },
      ]);
    } finally {
      fx.restore();
    }
  });
});

describe('UniFiSiteManagerDriver.listSourceFields', () => {
  it('probes nested devices and exposes primitive fields plus the parent host fields', async () => {
    const fx = installFetchScript([
      {
        kind: 'json',
        body: {
          data: [
            {
              hostId: HOST_A,
              hostName: 'Jaffe Chiropractic',
              devices: [
                {
                  id: '6C63F8E43AFD',
                  mac: '6C63F8E43AFD',
                  name: 'USW-24-G2',
                  model: 'USW 24',
                  shortname: 'USL24B',
                  ip: '192.168.0.95',
                  productLine: 'network',
                  status: 'online',
                  version: '7.4.1',
                  firmwareStatus: 'upToDate',
                  isConsole: false,
                  isManaged: true,
                  startupTime: '2026-04-19T15:02:50Z',
                  adoptionTime: '2025-11-17T19:31:19Z',
                  note: '',
                  // Nested objects must be filtered out of the field set.
                  uidb: { iconId: 'abc', images: { default: 'x' } },
                },
              ],
              updatedAt: '2026-04-26T04:10:17Z',
            },
          ],
          nextToken: null,
        },
      },
    ]);
    try {
      const fields = await new UniFiSiteManagerDriver().listSourceFields({
        ...makeCtx(),
        externalOrgId: HOST_A,
      });
      const keys = fields.map((f) => f.key);
      expect(keys).toEqual(
        expect.arrayContaining([
          'name',
          'model',
          'shortname',
          'mac',
          'ip',
          'productLine',
          'status',
          'version',
          'firmwareStatus',
          'startupTime',
          'adoptionTime',
          'isConsole',
          'isManaged',
          'hostId',
          'hostName',
        ]),
      );
      // `id` is the externalId, not user-mappable.
      expect(keys).not.toContain('id');
      // Nested objects are skipped.
      expect(keys).not.toContain('uidb');
      expect(fields.find((f) => f.key === 'startupTime')).toMatchObject({
        label: 'Last boot',
        hintType: 'DATETIME',
      });
      expect(fields.find((f) => f.key === 'isManaged')).toMatchObject({
        hintType: 'BOOLEAN',
      });
      expect(fields.find((f) => f.key === 'ip')).toMatchObject({
        hintType: 'IP_ADDRESS',
      });
    } finally {
      fx.restore();
    }
  });

  it('falls back to the curated catalogue when the probe fails', async () => {
    const fx = installFetchScript([
      { kind: 'text', status: 500, body: 'oops' },
      { kind: 'text', status: 500, body: 'oops' },
      { kind: 'text', status: 500, body: 'oops' },
    ]);
    try {
      const fields = await new UniFiSiteManagerDriver().listSourceFields({
        ...makeCtx(),
        externalOrgId: HOST_A,
      });
      expect(fields.length).toBeGreaterThan(5);
      expect(fields.map((f) => f.key)).toEqual(
        expect.arrayContaining([
          'name',
          'model',
          'mac',
          'ip',
          'version',
          'startupTime',
        ]),
      );
    } finally {
      fx.restore();
    }
  });
});

describe('UniFiSiteManagerDriver.fetchRecords', () => {
  it('flattens the host group devices, filters by hostId, and paginates via nextToken', async () => {
    const driver = new UniFiSiteManagerDriver();
    const fx = installFetchScript([
      {
        kind: 'json',
        body: {
          data: [
            {
              hostId: HOST_A,
              hostName: 'Jaffe Chiropractic',
              updatedAt: '2026-04-26T04:10:17Z',
              devices: [
                {
                  id: '6C63F8E43AFD',
                  mac: '6C63F8E43AFD',
                  name: 'USW-24-G2',
                  model: 'USW 24',
                  ip: '192.168.0.95',
                  status: 'online',
                  version: '7.4.1',
                  startupTime: '2026-04-19T15:02:50Z',
                  uidb: { iconId: 'abc' },
                },
                {
                  id: '802AA80223C7',
                  mac: '802AA80223C7',
                  name: 'AC LR',
                  model: 'AC LR',
                  status: 'online',
                  version: '6.8.2',
                  startupTime: '2026-04-19T15:02:46Z',
                },
              ],
            },
            {
              // The Site Manager API doesn't honour every hostIds[] filter
              // tightly; some responses include unrelated hosts. The driver
              // must drop them client-side.
              hostId: HOST_B,
              hostName: 'Acme HQ',
              devices: [{ id: 'DEAD', mac: 'DEAD', name: 'Other' }],
            },
          ],
          nextToken: 'page-2',
        },
      },
      {
        kind: 'json',
        body: {
          data: [
            {
              hostId: HOST_A,
              hostName: 'Jaffe Chiropractic',
              updatedAt: '2026-04-26T04:10:17Z',
              devices: [
                {
                  id: '9C05D6AC0FF7',
                  mac: '9C05D6AC0FF7',
                  name: 'Jaffe Chiropractic',
                  model: 'UCG Ultra',
                  isConsole: true,
                  isManaged: true,
                },
              ],
            },
          ],
          nextToken: null,
        },
      },
    ]);
    try {
      const page1 = await driver.fetchRecords(makeFetchCtx(), null);
      expect(page1.records).toHaveLength(2);
      expect(page1.records[0]).toMatchObject({
        externalId: '6C63F8E43AFD',
        displayName: 'USW-24-G2',
        updatedAt: '2026-04-19T15:02:50.000Z',
      });
      expect(page1.records[0]!.fields).toMatchObject({
        model: 'USW 24',
        ip: '192.168.0.95',
        status: 'online',
        version: '7.4.1',
        hostId: HOST_A,
        hostName: 'Jaffe Chiropractic',
      });
      // Nested objects are not propagated as primitive fields.
      expect(page1.records[0]!.fields).not.toHaveProperty('uidb');
      expect(page1.hasMore).toBe(true);
      expect(page1.cursor).toBe('page-2');

      const page2 = await driver.fetchRecords(makeFetchCtx(), page1.cursor);
      expect(page2.records).toHaveLength(1);
      expect(page2.records[0]).toMatchObject({
        externalId: '9C05D6AC0FF7',
        displayName: 'Jaffe Chiropractic',
      });
      expect(page2.records[0]!.fields).toMatchObject({
        isConsole: true,
        isManaged: true,
        hostName: 'Jaffe Chiropractic',
      });
      expect(page2.hasMore).toBe(false);
      expect(page2.cursor).toBeNull();

      expect(fx.calls).toHaveLength(2);
      expect(fx.calls[0]!.url).toContain(`hostIds%5B%5D=${encodeURIComponent(HOST_A)}`);
      expect(fx.calls[1]!.url).toContain('nextToken=page-2');
    } finally {
      fx.restore();
    }
  });

  it('applies optional productLine and managed filters', async () => {
    const fx = installFetchScript([
      {
        kind: 'json',
        body: {
          data: [
            {
              hostId: HOST_A,
              hostName: 'Jaffe Chiropractic',
              devices: [
                {
                  id: 'switch-1',
                  mac: 'switch-1',
                  name: 'Switch 1',
                  productLine: 'network',
                  isManaged: true,
                },
                {
                  id: 'cam-1',
                  mac: 'cam-1',
                  name: 'Cam',
                  productLine: 'protect',
                  isManaged: true,
                },
                {
                  id: 'switch-2',
                  mac: 'switch-2',
                  name: 'Unmanaged switch',
                  productLine: 'network',
                  isManaged: false,
                },
              ],
            },
          ],
          nextToken: null,
        },
      },
    ]);
    try {
      const page = await new UniFiSiteManagerDriver().fetchRecords(
        {
          ...makeFetchCtx(),
          filter: { productLines: ['network'], managedOnly: true },
        } as FetchRecordsContext,
        null,
      );
      expect(page.records.map((r) => r.externalId)).toEqual(['switch-1']);
    } finally {
      fx.restore();
    }
  });

  it('rejects malformed filter blobs before issuing HTTP calls', async () => {
    const fx = installFetchScript([]);
    try {
      await expect(
        new UniFiSiteManagerDriver().fetchRecords(
          {
            ...makeFetchCtx(),
            filter: { productLines: 'network' },
          } as unknown as FetchRecordsContext,
          null,
        ),
      ).rejects.toThrow(/Expected array/);
      expect(fx.calls).toHaveLength(0);
    } finally {
      fx.restore();
    }
  });

  it('throws DriverRateLimitError when the retry budget is exhausted', async () => {
    const fx = installFetchScript([
      {
        kind: 'text',
        status: 429,
        body: '',
        headers: { 'Retry-After': '0' },
      },
      {
        kind: 'text',
        status: 429,
        body: '',
        headers: { 'Retry-After': '0' },
      },
      {
        kind: 'text',
        status: 429,
        body: '',
        headers: { 'Retry-After': '0' },
      },
    ]);
    try {
      await expect(
        new UniFiSiteManagerDriver().fetchRecords(makeFetchCtx(), null),
      ).rejects.toBeInstanceOf(DriverRateLimitError);
    } finally {
      fx.restore();
    }
  });
});
