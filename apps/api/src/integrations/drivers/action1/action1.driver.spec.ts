import {
  DriverAuthError,
  DriverRateLimitError,
  type FetchRecordsContext,
  type IntegrationContext,
} from '../integration-driver.js';
import { Action1Driver } from './action1.driver.js';

/**
 * Phase 11 — Action1 driver behavioural tests.
 *
 * The driver hits the live Action1 REST API in production. For tests
 * we install a `globalThis.fetch` shim that returns scripted
 * `Response` objects so we can exercise:
 *   - the OAuth2 token-exchange step,
 *   - listing source orgs / fetching endpoint pages,
 *   - cursor + pagination semantics,
 *   - retry on 429 with `Retry-After`,
 *   - `DriverAuthError` mapping for 401/403,
 *   - `DriverRateLimitError` when the retry budget is exhausted.
 *
 * We don't mock timers because the driver multiplies a small
 * `backoffMs` by `2^attempt`; tests pin `backoffMs = 1` so the worst
 * case stays well under a second.
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
      throw new Error(`Action1 driver test: unscripted fetch to ${url}`);
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

function makeCtx(): IntegrationContext {
  return {
    integrationId: 'int-1',
    config: { baseUrl: 'https://app.action1.com/api/3.0' },
    secret: { apiKey: 'k', apiSecret: 's' },
    correlationId: 'test-corr',
    http: HTTP,
  } as IntegrationContext;
}

function makeFetchCtx(orgId = 'o-1'): FetchRecordsContext {
  return {
    ...makeCtx(),
    externalOrgId: orgId,
    filter: {},
  } as FetchRecordsContext;
}

describe('Action1Driver.testConnection', () => {
  it('exchanges credentials and returns the org count', async () => {
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      {
        kind: 'json',
        body: {
          // Action1 wraps every collection in a `ResultPage` envelope
          // and emits orgs as `{ id, name }`, NOT `{ org_id, org_name }`.
          items: [
            { id: 'o-1', name: 'Acme' },
            { id: 'o-2', name: 'Globex' },
          ],
          total_items: '2',
        },
      },
    ]);
    try {
      const out = await new Action1Driver().testConnection(makeCtx());
      expect(out).toEqual({
        ok: true,
        details: 'Reached Action1 (2 organisations).',
      });
      // Action1's token endpoint lives UNDER the API base, not at the
      // origin root.
      expect(fx.calls[0]!.url).toBe(
        'https://app.action1.com/api/3.0/oauth2/token',
      );
      expect(fx.calls[0]!.method).toBe('POST');
      expect(fx.calls[0]!.body).toContain('client_id=k');
      expect(fx.calls[0]!.body).toContain('client_secret=s');
      // We follow Action1's docs verbatim — `grant_type` is implicit.
      expect(fx.calls[0]!.body).not.toContain('grant_type');
      expect(fx.calls[1]!.url).toBe(
        'https://app.action1.com/api/3.0/organizations?from=0&limit=200',
      );
    } finally {
      fx.restore();
    }
  });

  it('maps 401 from /oauth2/token to DriverAuthError', async () => {
    const fx = installFetchScript([{ kind: 'text', status: 401, body: 'no' }]);
    try {
      await expect(
        new Action1Driver().testConnection(makeCtx()),
      ).rejects.toBeInstanceOf(DriverAuthError);
    } finally {
      fx.restore();
    }
  });
});

describe('Action1Driver.listSourceOrgs', () => {
  it('flattens the Action1 org payload into SourceOrgDto[]', async () => {
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      {
        kind: 'json',
        body: {
          items: [
            {
              id: 'o-9',
              name: 'Wayne Enterprises',
              description: 'Gotham HQ',
            },
            { id: 'o-10', name: 'Stark Industries' },
          ],
          total_items: '2',
        },
      },
    ]);
    try {
      const orgs = await new Action1Driver().listSourceOrgs(makeCtx());
      expect(orgs).toEqual([
        { externalId: 'o-9', name: 'Wayne Enterprises', hint: 'Gotham HQ' },
        { externalId: 'o-10', name: 'Stark Industries', hint: null },
      ]);
    } finally {
      fx.restore();
    }
  });

  it('paginates when the first page is full and stops on a short page', async () => {
    // 200 orgs in the first page (== limit), then a short tail of 5.
    // Action1 pagination is `from`/`limit`, so the driver should walk
    // both pages and concatenate.
    const firstPage = Array.from({ length: 200 }, (_, i) => ({
      id: `o-${i + 1}`,
      name: `Org ${i + 1}`,
    }));
    const secondPage = Array.from({ length: 5 }, (_, i) => ({
      id: `o-${201 + i}`,
      name: `Org ${201 + i}`,
    }));
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      {
        kind: 'json',
        body: { items: firstPage, total_items: '205' },
      },
      {
        kind: 'json',
        body: { items: secondPage, total_items: '205' },
      },
    ]);
    try {
      const orgs = await new Action1Driver().listSourceOrgs(makeCtx());
      expect(orgs).toHaveLength(205);
      expect(orgs[0]).toEqual({
        externalId: 'o-1',
        name: 'Org 1',
        hint: null,
      });
      expect(orgs[204]).toEqual({
        externalId: 'o-205',
        name: 'Org 205',
        hint: null,
      });
      // Token + 2 org-page fetches.
      expect(fx.calls).toHaveLength(3);
      expect(fx.calls[1]!.url).toContain('from=0');
      expect(fx.calls[2]!.url).toContain('from=200');
    } finally {
      fx.restore();
    }
  });
});

describe('Action1Driver.listSourceFields', () => {
  it('probes the live endpoint schema and unions discovered keys with the curated catalogue', async () => {
    // Two endpoints with overlapping + distinct columns. Action1 returns
    // every column when `?fields=*` is set, even ones not in our hard-
    // coded list. The driver must surface them so operators can map
    // any tenant-specific column.
      const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      {
        kind: 'json',
        body: {
          items: [
            {
              id: 'e-1',
              name: 'host-1.lan',
              OS: 'Windows 11 Pro',
              RAM: '16 GB',
              disk: '512 GB',
              MAC: 'aa:bb:cc:dd:ee:ff',
              serial: 'ABC123',
              last_seen: '2026-04-25T05:00:00Z',
              custom_field_xyz: 'tenant-only',
              // Nested objects must be skipped — operators can't map
              // them onto a primitive AssetField.
              network_interfaces: [{ name: 'eth0' }],
            },
            {
              id: 'e-2',
              name: 'host-2.lan',
              OS: 'Windows 10',
              RAM: '8 GB',
              disk: '256 GB',
              serial: 'XYZ789',
              custom_field_xyz: null,
            },
          ],
          total_items: '2',
        },
      },
    ]);
    try {
      const fields = await new Action1Driver().listSourceFields({
        ...makeCtx(),
        externalOrgId: 'o-1',
      });
      const keys = fields.map((f) => f.key);
      expect(keys).toEqual(expect.arrayContaining([
        'name',
        'OS',
        'RAM',
        'disk',
        'MAC',
        'serial',
        'last_seen',
        'custom_field_xyz',
      ]));
      // `id` is the externalId — never user-mappable.
      expect(keys).not.toContain('id');
      // Nested objects/arrays are filtered out.
      expect(keys).not.toContain('network_interfaces');
      // Lower-case `os` / `ram` aren't real Action1 keys — they used
      // to leak in via the curated catalogue and silently zero-out
      // mapped fields. Make sure we never re-introduce them.
      expect(keys).not.toContain('os');
      expect(keys).not.toContain('ram');

      // Curated overrides win on label + hintType.
      const os = fields.find((f) => f.key === 'OS')!;
      expect(os.label).toBe('Operating system');
      expect(os.hintType).toBe('TEXT');
      const lastSeen = fields.find((f) => f.key === 'last_seen')!;
      expect(lastSeen.label).toBe('Last seen');
      expect(lastSeen.hintType).toBe('DATETIME');

      // Auto-derived fields humanise + infer correctly.
      const tenantField = fields.find((f) => f.key === 'custom_field_xyz')!;
      expect(tenantField.label).toBe('Custom Field Xyz');
      expect(tenantField.hintType).toBe('TEXT');

      // `alwaysPresent` reflects sample coverage for non-curated keys.
      // `custom_field_xyz` is null in record 2 → false.
      expect(tenantField.alwaysPresent).toBe(false);

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
      const fields = await new Action1Driver().listSourceFields({
        ...makeCtx(),
        externalOrgId: 'o-1',
      });
      // Curated catalogue is non-empty and uses Action1's actual
      // case-sensitive keys (OS / RAM / serial — NOT os / ram /
      // serial_number, which would silently zero out mapped fields).
      expect(fields.length).toBeGreaterThan(5);
      expect(fields.map((f) => f.key)).toEqual(
        expect.arrayContaining(['name', 'OS', 'RAM', 'serial']),
      );
    } finally {
      fx.restore();
    }
  });
});

describe('Action1Driver.fetchRecords', () => {
  it('paginates via from/limit and stops when total is reached', async () => {
    const firstPage = Array.from({ length: 200 }, (_, i) => ({
      id: `e-${i + 1}`,
      name: `host-${i + 1}`,
      last_seen: '2026-04-25T00:00:00Z',
    }));
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      {
        kind: 'json',
        body: { items: firstPage, total_items: '220' },
      },
      { kind: 'json', body: { access_token: 'tok-1' } },
      {
        kind: 'json',
        body: {
          items: Array.from({ length: 20 }, (_, i) => ({
            id: `e-${201 + i}`,
            name: `host-${201 + i}`,
          })),
          total_items: '220',
        },
      },
    ]);
    try {
      const driver = new Action1Driver();
      const page1 = await driver.fetchRecords(makeFetchCtx(), null);
      expect(page1.records).toHaveLength(200);
      expect(page1.records[0]).toMatchObject({
        externalId: 'e-1',
        displayName: 'host-1',
        updatedAt: '2026-04-25T00:00:00Z',
      });
      expect(page1.hasMore).toBe(true);
      expect(page1.cursor).toBe('200');

      const page2 = await driver.fetchRecords(makeFetchCtx(), page1.cursor);
      expect(page2.records).toHaveLength(20);
      expect(page2.hasMore).toBe(false);
      expect(page2.cursor).toBeNull();

      expect(fx.calls[1]!.url).toContain('from=0');
      expect(fx.calls[1]!.url).toContain('limit=200');
      expect(fx.calls[3]!.url).toContain('from=200');
    } finally {
      fx.restore();
    }
  });

  it('applies the optional groups filter', async () => {
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
      {
        kind: 'json',
        body: {
          items: [
            { id: 'a', name: 'a.lan', group: 'servers' },
            { id: 'b', name: 'b.lan', group: 'workstations' },
            { id: 'c', name: 'c.lan', group: 'servers' },
          ],
          total_items: '3',
        },
      },
    ]);
    try {
      const ctx = {
        ...makeFetchCtx(),
        filter: { groups: ['servers'] },
      } as FetchRecordsContext;
      const page = await new Action1Driver().fetchRecords(ctx, null);
      expect(page.records.map((r) => r.externalId)).toEqual(['a', 'c']);
    } finally {
      fx.restore();
    }
  });

  it('rejects an invalid cursor before issuing any HTTP call', async () => {
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
    ]);
    try {
      await expect(
        new Action1Driver().fetchRecords(makeFetchCtx(), 'banana'),
      ).rejects.toThrow(/Invalid Action1 fetch cursor/);
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
        body: { items: [{ id: 'x', name: 'x.lan' }], total_items: '1' },
      },
    ]);
    try {
      const page = await new Action1Driver().fetchRecords(makeFetchCtx(), null);
      expect(page.records).toEqual([
        {
          externalId: 'x',
          displayName: 'x.lan',
          fields: { id: 'x', name: 'x.lan' },
          updatedAt: null,
        },
      ]);
    } finally {
      fx.restore();
    }
  });

  it('throws DriverRateLimitError when the retry budget is exhausted', async () => {
    const fx = installFetchScript([
      { kind: 'json', body: { access_token: 'tok-1' } },
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
        new Action1Driver().fetchRecords(makeFetchCtx(), null),
      ).rejects.toBeInstanceOf(DriverRateLimitError);
    } finally {
      fx.restore();
    }
  });
});
