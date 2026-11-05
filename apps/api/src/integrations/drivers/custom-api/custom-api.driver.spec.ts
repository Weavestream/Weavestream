import { BadRequestException } from '@nestjs/common';
import {
  customApiDefinitionSchema,
  driverDescriptorSchema,
  integrationSectionSchema,
  type CustomApiDefinitionInput,
} from '@weavestream/shared';
import {
  DriverAuthError,
  DriverResourceUnavailableError,
  type FetchRecordsContext,
  type IntegrationContext,
} from '../integration-driver.js';
import { setDefaultFetchForTests, setDefaultResolveForTests } from '../../../common/egress/safe-fetch.js';
import { __resetRunCacheForTests } from '../run-cache.js';
import { sourceRecordUrl } from '../source-urls.js';
import { CustomApiDriver } from './custom-api.driver.js';
import {
  CustomApiRequestError,
  __customApiTokenCacheForTests,
  __resetCustomApiTokenCacheForTests,
  buildRequestTarget,
} from './custom-api.http.js';
import { decodePageState, encodePageState, nextFromLinkHeader } from './custom-api.pagination.js';
import { MASK, runProbe, sampleValue } from './custom-api.probe.js';

const BASE = 'https://inventory.example.com/api';
const TOKEN = 'test-bearer-token';
const SNAPSHOT = '2026-11-05T12:00:00.000Z';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Reply = { status?: number; body?: unknown; raw?: string; headers?: Record<string, string> };
type Handler = (url: URL, call: Call) => Reply;

/** Scripted fetch: each request goes to `handler`; DNS is stubbed to a public IP so the egress guard stays on. */
function installFetch(handler: Handler): Call[] {
  const calls: Call[] = [];
  setDefaultFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    const reply = handler(new URL(url), call);
    const body = reply.raw ?? JSON.stringify(reply.body ?? {});
    return new Response(body, { status: reply.status ?? 200, headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) } });
  }) as typeof fetch);
  setDefaultResolveForTests(async () => ['1.2.3.4']);
  return calls;
}

function definition(overrides: Partial<CustomApiDefinitionInput> = {}): CustomApiDefinitionInput {
  return {
    version: 1,
    baseUrl: BASE,
    auth: { method: 'bearer' },
    headers: [{ name: 'X-Tenant', secret: true }],
    organizations: {
      mode: 'endpoint',
      request: { path: '/groups' },
      recordsPath: 'groups',
      idPath: 'id',
      namePath: 'name',
    },
    resources: {
      items: {
        enabled: true,
        request: { path: '/devices', query: { group: '{orgId}', cursor: '{cursor}' } },
        recordsPath: 'devices',
        pagination: { style: 'cursor', cursorPath: 'next' },
        idPath: 'id',
        namePath: 'name',
        matchPath: 'system.serial',
        fields: [
          { key: 'hostname', label: 'Hostname', path: 'hostname', type: 'TEXT' },
          { key: 'agent_version', label: 'Agent version', path: 'agent', type: 'TEXT' },
          { key: 'last_contact', label: 'Last contact', path: 'seen', type: 'DATETIME' },
          { key: 'cores', label: 'Cores', path: 'cores', type: 'NUMBER' },
        ],
        recordUrl: 'https://app.example.com/devices/{id}',
      },
    },
    ...overrides,
  };
}

let seq = 0;
function ctx(def: CustomApiDefinitionInput = definition(), secret: Record<string, unknown> = { token: TOKEN, 'header:x-tenant': 'tenant-1' }, extra: Partial<IntegrationContext> = {}): IntegrationContext {
  seq += 1;
  return {
    config: def as unknown as Record<string, unknown>,
    secret,
    http: { timeoutMs: 5_000, maxRetries: 0, backoffMs: 1 },
    correlationId: `corr-${seq}`,
    integrationId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    credentialVersion: 'secret-1@2026-11-01T00:00:00.000Z|no-app',
    ...extra,
  };
}

function fetchCtx(base: IntegrationContext, resourceKey = 'items', externalOrgId = 'g1'): FetchRecordsContext {
  return { ...base, externalOrgId, resourceKey, filter: {}, mode: 'full', updatedSince: null, snapshotAt: SNAPSHOT };
}

const device = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: `pc-${id}`,
  hostname: `pc-${id}.corp`,
  agent: '1.2.3',
  seen: '2026-11-01T10:00:00Z',
  cores: '8',
  system: { serial: `SN${id}`, ip: '10.0.0.5' },
  ...extra,
});

const driver = new CustomApiDriver();

afterEach(() => {
  setDefaultFetchForTests(null);
  setDefaultResolveForTests(null);
  __resetRunCacheForTests();
  __resetCustomApiTokenCacheForTests();
});

describe('descriptor', () => {
  it('validates and marks the API definition capability', () => {
    expect(() => driverDescriptorSchema.parse(driver.descriptor)).not.toThrow();
    expect(driver.descriptor.capabilities.apiDefinition).toBe(true);
    expect(driver.descriptor.secretBoundConfigKeys).toEqual(['baseUrl', 'auth.tokenUrl']);
    expect(driver.descriptor.secretFields.every((field) => !field.required)).toBe(true);
    expect(JSON.stringify(driver.descriptor)).not.toMatch(/ninja|level|breeze|herman/i);
  });

  it('has 1 Items resource that links to existing assets by its match keys, with no Map layouts or Differences', () => {
    expect(driver.descriptor.resources).toHaveLength(1);
    const [items] = driver.descriptor.resources;
    expect(items).toMatchObject({ key: 'items', targetKind: 'asset', matchFirst: true });
    expect(items!.matchSuggestions).toBeUndefined();
    expect(items!.standardFields).toBeUndefined();
  });
});

describe('buildRequestTarget', () => {
  const request = (path: string, query: Record<string, string> = {}) => ({ method: 'GET' as const, path, query });

  it('joins the path to the Base URL path prefix and encodes each value once', () => {
    const target = buildRequestTarget(BASE, request('/groups/{orgId}/devices', { q: '{orgId}' }), { orgId: 'a b/c?d' });
    expect(target.url).toBe('https://inventory.example.com/api/groups/a%20b%2Fc%3Fd/devices?q=a+b%2Fc%3Fd');
  });

  it('leaves out a query parameter whose placeholder has no value', () => {
    expect(buildRequestTarget(BASE, request('/d', { cursor: '{cursor}', g: 'x' }), {}).url).toBe(`${BASE}/d?g=x`);
  });

  it('refuses a value that would climb out of the path prefix or change the host', () => {
    expect(() => buildRequestTarget(BASE, request('/{orgId}/x'), { orgId: '..' })).toThrow(CustomApiRequestError);
    expect(buildRequestTarget(BASE, request('/{orgId}'), { orgId: '//evil.example' }).url).toBe(`${BASE}/%2F%2Fevil.example`);
    expect(buildRequestTarget(BASE, request('/{orgId}'), { orgId: '../../x' }).url).toBe(`${BASE}/..%2F..%2Fx`);
    expect(() => buildRequestTarget(BASE, request('/../secret'), {})).toThrow(/leaves the Base URL/);
  });

  it('fills POST body string values and drops an unset placeholder value', () => {
    const target = buildRequestTarget(BASE, { method: 'POST', path: '/search', query: {}, body: { group: '{orgId}', after: '{cursor}', n: 1 } }, { orgId: 'g1' });
    expect(JSON.parse(target.body!)).toEqual({ group: 'g1', n: 1 });
  });
});

describe('authentication', () => {
  function oneRecordApi() {
    return (url: URL): Reply => {
      if (url.pathname.endsWith('/groups')) return { body: { groups: [{ id: 'g1', name: 'Acme' }] } };
      return { body: { devices: [device(1)] } };
    };
  }

  it.each([
    ['bearer', { method: 'bearer' }, { token: TOKEN }, ['authorization', `Bearer ${TOKEN}`]],
    ['header', { method: 'header', headerName: 'X-Api-Key' }, { value: 'k-123' }, ['x-api-key', 'k-123']],
    ['basic', { method: 'basic', username: 'svc' }, { password: 'pw' }, ['authorization', `Basic ${Buffer.from('svc:pw').toString('base64')}`]],
  ])('%s sends its header', async (_name, auth, secret, [header, value]) => {
    installFetchCalls(oneRecordApi());
    const def = definition({ auth: auth as never, headers: [] });
    await driver.listSourceOrgs(ctx(def, secret));
    const sent = lastCall();
    expect(sent.headers[header!]).toBe(value);
  });

  it('none sends no credentials', async () => {
    installFetchCalls(oneRecordApi());
    await driver.listSourceOrgs(ctx(definition({ auth: { method: 'none' }, headers: [] }), {}));
    expect(lastCall().headers.authorization).toBeUndefined();
  });

  it('sends secret headers from the secret bundle, and refuses when they are missing', async () => {
    installFetchCalls(oneRecordApi());
    await driver.listSourceOrgs(ctx());
    expect(lastCall().headers['x-tenant']).toBe('tenant-1');
    await expect(driver.listSourceOrgs(ctx(definition(), { token: TOKEN }))).rejects.toBeInstanceOf(DriverAuthError);
  });

  it('maps 401 and 403 to DriverAuthError with fixed text', async () => {
    installFetchCalls(() => ({ status: 401, body: { error: 'upstream secret detail' } }));
    const error = await driver.listSourceOrgs(ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DriverAuthError);
    expect((error as Error).message).toBe('The API refused the credentials (401).');
  });

  it('never puts upstream body text into an error', async () => {
    installFetchCalls(() => ({ status: 500, body: { error: 'stack trace at db.internal:5432' } }));
    await expect(driver.listSourceOrgs(ctx())).rejects.toThrow('The API returned an error (500).');
    installFetchCalls(() => ({ raw: '<html>not json</html>' }));
    await expect(driver.listSourceOrgs(ctx())).rejects.toThrow('The API did not return JSON.');
  });
});

/** installFetch, keeping the calls for lastCall(). */
let currentCalls: Call[] = [];
function installFetchCalls(handler: Handler): Call[] {
  currentCalls = installFetch(handler);
  return currentCalls;
}
function lastCall(): Call {
  return currentCalls[currentCalls.length - 1]!;
}

describe('OAuth client credentials', () => {
  const TOKEN_URL = 'https://login.example.net/oauth/token';
  const oauthDef = (overrides: Record<string, unknown> = {}) =>
    definition({ auth: { method: 'oauth_client_credentials', tokenUrl: TOKEN_URL, scope: 'read', ...overrides } as never, headers: [] });
  const oauthSecret = { clientId: 'client-1', clientSecret: 'client-secret-1' };

  function api(opts: { tokens?: string[]; rejectToken?: (call: Call) => boolean; dataStatus?: (call: Call) => number } = {}) {
    let issued = 0;
    const tokens = opts.tokens ?? ['tok-1', 'tok-2', 'tok-3', 'tok-4'];
    return installFetchCalls((url, call) => {
      if (url.toString() === TOKEN_URL) {
        if (opts.rejectToken?.(call)) return { status: 401, body: {} };
        const token = tokens[issued] ?? `tok-${issued + 1}`;
        issued += 1;
        return { body: { access_token: token, expires_in: 3600, token_type: 'Bearer' } };
      }
      return { status: opts.dataStatus?.(call) ?? 200, body: { groups: [{ id: 'g1', name: 'Acme' }] } };
    });
  }

  it('posts the client credentials in the body by default, or as Basic', async () => {
    const calls = api();
    await driver.listSourceOrgs(ctx(oauthDef(), oauthSecret));
    const tokenCall = calls.find((c) => c.url === TOKEN_URL)!;
    expect(new URLSearchParams(tokenCall.body)).toEqual(new URLSearchParams({ grant_type: 'client_credentials', scope: 'read', client_id: 'client-1', client_secret: 'client-secret-1' }));
    expect(calls.at(-1)!.headers.authorization).toBe('Bearer tok-1');

    __resetCustomApiTokenCacheForTests();
    const basicCalls = api();
    await driver.listSourceOrgs(ctx(oauthDef({ clientAuth: 'basic' }), oauthSecret));
    const basicToken = basicCalls.find((c) => c.url === TOKEN_URL)!;
    expect(basicToken.headers.authorization).toBe(`Basic ${Buffer.from('client-1:client-secret-1').toString('base64')}`);
    expect(basicToken.body).not.toContain('client_secret');
  });

  it('caches the token per integration and reuses it', async () => {
    const calls = api();
    const c = ctx(oauthDef(), oauthSecret);
    await driver.listSourceOrgs(c);
    await driver.listSourceOrgs({ ...c, correlationId: 'again' });
    expect(calls.filter((call) => call.url === TOKEN_URL)).toHaveLength(1);
  });

  it('gets a new token once after a 401, then gives up with DriverAuthError', async () => {
    let dataCalls = 0;
    const calls = api({ dataStatus: () => (dataCalls++ === 0 ? 401 : 200) });
    await driver.listSourceOrgs(ctx(oauthDef(), oauthSecret));
    expect(calls.filter((call) => call.url === TOKEN_URL)).toHaveLength(2);
    expect(calls.at(-1)!.headers.authorization).toBe('Bearer tok-2');

    __resetCustomApiTokenCacheForTests();
    const always = api({ dataStatus: () => 401 });
    await expect(driver.listSourceOrgs(ctx(oauthDef(), oauthSecret))).rejects.toBeInstanceOf(DriverAuthError);
    expect(always.filter((call) => call.url === TOKEN_URL)).toHaveLength(2);
  });

  it('maps a refused token request to DriverAuthError', async () => {
    api({ rejectToken: () => true });
    await expect(driver.listSourceOrgs(ctx(oauthDef(), oauthSecret))).rejects.toThrow('The token endpoint refused the client credentials (401).');
  });

  it('caps the token response at 64 KiB', async () => {
    installFetchCalls((url) => (url.toString() === TOKEN_URL ? { raw: JSON.stringify({ access_token: 'x', pad: 'p'.repeat(70 * 1024) }) } : { body: { groups: [] } }));
    await expect(driver.listSourceOrgs(ctx(oauthDef(), oauthSecret))).rejects.toThrow('The response is too large.');
  });

  describe('cache isolation', () => {
    it('a Test of a changed host never gets the production token, and leaves the cache as it was', async () => {
      const calls = api({ tokens: ['prod-token', 'draft-token'] });
      const production = ctx(oauthDef(), oauthSecret);
      await driver.listSourceOrgs(production);
      const cached = __customApiTokenCacheForTests().get(`id:${production.integrationId}`);
      expect(cached?.token).toBe('prod-token');
      const before = { ...cached! };

      const DRAFT_TOKEN_URL = 'https://login.other.example/oauth/token';
      calls.length = 0;
      installFetchCalls((url) => {
        if (url.toString() === DRAFT_TOKEN_URL) return { body: { access_token: 'draft-token', expires_in: 3600 } };
        return { body: { groups: [{ id: 'g9', name: 'Other' }] } };
      });
      const draft = customApiDefinitionSchema.parse({
        ...definition({ baseUrl: 'https://other-host.example/api', headers: [] }),
        auth: { method: 'oauth_client_credentials', tokenUrl: DRAFT_TOKEN_URL },
      });
      const outcome = await runProbe({
        definition: draft,
        secret: { clientId: 'client-2', clientSecret: 'client-secret-2' },
        section: 'organizations',
        http: production.http,
        correlationId: 'probe-1',
      });
      expect(outcome.ok).toBe(true);
      const sent = currentCalls;
      expect(sent.some((call) => call.url === DRAFT_TOKEN_URL)).toBe(true);
      expect(sent.every((call) => call.headers.authorization !== 'Bearer prod-token')).toBe(true);
      expect(sent.find((call) => call.url.startsWith('https://other-host.example'))!.headers.authorization).toBe('Bearer draft-token');
      expect(__customApiTokenCacheForTests().get(`id:${production.integrationId}`)).toEqual(before);
      expect(__customApiTokenCacheForTests().size).toBe(1);
    });

    it('a Test for a new integration never writes the shared cache', async () => {
      api();
      const draft = customApiDefinitionSchema.parse(oauthDef());
      await runProbe({ definition: draft, secret: oauthSecret, section: 'organizations', http: ctx().http, correlationId: 'probe-2' });
      expect(__customApiTokenCacheForTests().size).toBe(0);
    });

    it.each([
      ['tokenUrl', { tokenUrl: 'https://login.example.net/oauth/v2/token' }],
      ['scope', { scope: 'read write' }],
      ['clientAuth', { clientAuth: 'basic' }],
    ])('a saved change to %s with the same credential version gets a new token', async (_name, change) => {
      const calls = installFetchCalls((url) => {
        if (url.pathname.includes('/oauth/')) return { body: { access_token: `tok-${url.pathname}-${Math.random()}`, expires_in: 3600 } };
        return { body: { groups: [] } };
      });
      const c = ctx(oauthDef(), oauthSecret);
      await driver.listSourceOrgs(c);
      await driver.listSourceOrgs({ ...c, config: oauthDef(change) as unknown as Record<string, unknown> });
      expect(calls.filter((call) => call.url.includes('/oauth/'))).toHaveLength(2);
    });

    it('a changed client secret with the same credential version gets a new token', async () => {
      const calls = api();
      const c = ctx(oauthDef(), oauthSecret);
      await driver.listSourceOrgs(c);
      await driver.listSourceOrgs({ ...c, secret: { clientId: 'client-1', clientSecret: 'rotated' } });
      expect(calls.filter((call) => call.url === TOKEN_URL)).toHaveLength(2);
    });
  });
});

describe('pagination', () => {
  async function walk(def: CustomApiDefinitionInput, handler: Handler): Promise<{ ids: string[]; calls: Call[] }> {
    const calls = installFetchCalls((url, call) => (url.pathname.endsWith('/groups') ? { body: { groups: [{ id: 'g1', name: 'A' }] } } : handler(url, call)));
    const c = fetchCtx(ctx(def));
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i += 1) {
      const page = await driver.fetchRecords(c, cursor);
      ids.push(...page.records.map((r) => (r as { externalId: string }).externalId));
      if (!page.hasMore) break;
      cursor = page.cursor;
    }
    return { ids, calls: calls.filter((call) => !call.url.includes('/groups')) };
  }

  const withPagination = (pagination: unknown, query: Record<string, string>) =>
    definition({
      resources: {
        items: { ...(definition().resources.items as object), pagination, request: { path: '/devices', query: { group: '{orgId}', ...query } } } as never,
      },
    });

  it('cursor: follows the cursor until it is missing, leaving it out on the first page', async () => {
    const { ids, calls } = await walk(definition(), (url) => {
      const cursor = url.searchParams.get('cursor');
      if (!cursor) return { body: { devices: [device(1)], next: 'c2' } };
      if (cursor === 'c2') return { body: { devices: [device(2)], next: '' } };
      return { body: { devices: [] } };
    });
    expect(ids).toEqual(['1', '2']);
    expect(calls[0]!.url).not.toContain('cursor=');
    expect(calls[1]!.url).toContain('cursor=c2');
  });

  it('cursor: stops with an error when the API sends a cursor it already used', async () => {
    await expect(walk(definition(), () => ({ body: { devices: [device(1)], next: 'same' } }))).rejects.toThrow('The API returned the same page again. The run stopped.');
  });

  it.each([
    ['an object', { cursor: 'second-page' }],
    ['a list', ['c2']],
    ['true', true],
    ['false', false],
  ])('cursor: a cursor that is %s stops the run with an error, never a silent end', async (_label, next) => {
    await expect(walk(definition(), () => ({ body: { devices: [device(1)], next } })))
      .rejects.toThrow('The API sent a next-page cursor that is not text or a number. The run stopped.');
  });

  it('cursor: a null, empty or missing cursor ends the walk; a number is a cursor', async () => {
    for (const end of [{ next: null }, { next: '' }, {}]) {
      const { ids } = await walk(definition(), () => ({ body: { devices: [device(1)], ...end } }));
      expect(ids).toEqual(['1']);
    }
    const { ids } = await walk(definition(), (url) => (url.searchParams.get('cursor') === '2'
      ? { body: { devices: [device(2)] } }
      : { body: { devices: [device(1)], next: 2 } }));
    expect(ids).toEqual(['1', '2']);
  });

  it('next_url: a link that is not text stops the run with an error', async () => {
    const def = withPagination({ style: 'next_url', nextUrlPath: 'links.next' }, {});
    await expect(walk(def, () => ({ body: { devices: [device(1)], links: { next: { href: 'devices?p=2' } } } })))
      .rejects.toThrow('The API sent a next-page link that is not text. The run stopped.');
    await expect(walk(def, () => ({ body: { devices: [device(1)], links: { next: 2 } } })))
      .rejects.toThrow('The API sent a next-page link that is not text. The run stopped.');
  });

  it.each([
    ['page', { style: 'page', pageSize: 2 }, { page: '{page}' }],
    ['offset', { style: 'offset', pageSize: 2 }, { offset: '{offset}' }],
  ])('%s: an API that ignores the page value and sends the same full page stops the run', async (_label, pagination, query) => {
    const def = withPagination(pagination, query);
    const result = walk(def, () => ({ body: { devices: [device(1), device(2)] } }));
    await expect(result).rejects.toThrow('The API returned the same page again. The run stopped.');
  });

  it('page: the same records on page 2 stop the run after 2 requests', async () => {
    const def = withPagination({ style: 'page', pageSize: 2 }, { page: '{page}' });
    const calls = installFetchCalls((url) => (url.pathname.endsWith('/groups')
      ? { body: { groups: [{ id: 'g1' }] } }
      : { body: { devices: [device(1), device(2)] } }));
    const c = fetchCtx(ctx(def));
    const first = await driver.fetchRecords(c, null);
    expect(first.hasMore).toBe(true);
    await expect(driver.fetchRecords(c, first.cursor)).rejects.toThrow('The API returned the same page again. The run stopped.');
    expect(calls.filter((call) => call.url.includes('/devices'))).toHaveLength(2);
  });

  it('page: stops on a short page and counts from firstPage', async () => {
    const def = withPagination({ style: 'page', pageSize: 2, firstPage: 1 }, { page: '{page}', size: '{limit}' });
    const { ids, calls } = await walk(def, (url) => {
      const page = Number(url.searchParams.get('page'));
      return { body: { devices: page === 1 ? [device(1), device(2)] : page === 2 ? [device(3)] : [] } };
    });
    expect(ids).toEqual(['1', '2', '3']);
    expect(calls.map((c) => new URL(c.url).searchParams.get('page'))).toEqual(['1', '2']);
    expect(new URL(calls[0]!.url).searchParams.get('size')).toBe('2');
  });

  it('page: stops when totalPath is reached', async () => {
    const def = withPagination({ style: 'page', pageSize: 2, totalPath: 'total' }, { page: '{page}' });
    const { calls } = await walk(def, () => ({ body: { devices: [device(1), device(2)], total: 2 } }));
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['page', { style: 'page', pageSize: 1_000, totalPath: 'total' }, { page: '{page}' }, (url: URL) => Number(url.searchParams.get('page')) - 1],
    ['offset', { style: 'offset', pageSize: 1_000, totalPath: 'total' }, { offset: '{offset}' }, (url: URL) => Number(url.searchParams.get('offset'))],
  ])('%s: with totalPath, a page shorter than pageSize does not end the walk early', async (_label, pagination, query, index) => {
    // The API sends 1 record per page whatever pageSize asks for; the total says 3.
    const def = withPagination(pagination, query);
    const { ids, calls } = await walk(def, (url) => {
      const i = index(url);
      return { body: { devices: i < 3 ? [device(i + 1)] : [], total: 3 } };
    });
    expect(ids).toEqual(['1', '2', '3']);
    expect(calls).toHaveLength(3);
  });

  it('cursor: a next-page value longer than 8,192 characters stops the run with an error', async () => {
    await expect(walk(definition(), () => ({ body: { devices: [device(1)], next: 'c'.repeat(8_193) } })))
      .rejects.toThrow('The API sent a next-page value longer than 8,192 characters. The run stopped.');
  });

  it('offset: moves by the records on each page and stops on an empty page', async () => {
    const def = withPagination({ style: 'offset', pageSize: 2 }, { offset: '{offset}' });
    const { ids, calls } = await walk(def, (url) => {
      const offset = Number(url.searchParams.get('offset'));
      return { body: { devices: offset < 4 ? [device(offset + 1), device(offset + 2)] : [] } };
    });
    expect(ids).toEqual(['1', '2', '3', '4']);
    expect(calls.map((c) => new URL(c.url).searchParams.get('offset'))).toEqual(['0', '2', '4']);
  });

  it('next_url: follows a relative or absolute link on the Base URL', async () => {
    const def = withPagination({ style: 'next_url', nextUrlPath: 'links.next' }, {});
    const { ids } = await walk(def, (url) => {
      if (!url.searchParams.get('p')) return { body: { devices: [device(1)], links: { next: 'devices?p=2' } } };
      if (url.searchParams.get('p') === '2') return { body: { devices: [device(2)], links: { next: `${BASE}/devices?p=3` } } };
      return { body: { devices: [device(3)], links: { next: null } } };
    });
    expect(ids).toEqual(['1', '2', '3']);
  });

  it('next_url: a link to another host stops the run and is never followed', async () => {
    const def = withPagination({ style: 'next_url', nextUrlPath: 'next' }, {});
    let followed = false;
    await expect(walk(def, (url) => {
      if (url.host !== 'inventory.example.com') followed = true;
      return { body: { devices: [device(1)], next: 'https://evil.example/api/devices?p=2' } };
    })).rejects.toThrow(/different host/);
    expect(followed).toBe(false);
  });

  it('next_url: a link outside the Base URL path prefix stops the run', async () => {
    const def = withPagination({ style: 'next_url', nextUrlPath: 'next' }, {});
    await expect(walk(def, () => ({ body: { devices: [device(1)], next: 'https://inventory.example.com/admin/devices' } }))).rejects.toThrow(/different host or path/);
  });

  it('link_header: follows rel="next" and refuses a cross-origin link', async () => {
    const def = withPagination({ style: 'link_header' }, {});
    const { ids } = await walk(def, (url) => (url.searchParams.get('p') === '2'
      ? { body: { devices: [device(2)] } }
      : { body: { devices: [device(1)] }, headers: { link: `<${BASE}/devices?p=2>; rel="next", <${BASE}/devices?p=9>; rel="last"` } }));
    expect(ids).toEqual(['1', '2']);
    await expect(walk(def, () => ({ body: { devices: [device(1)] }, headers: { link: '<https://evil.example/x>; rel="next"' } }))).rejects.toThrow(/different host/);
  });

  it('parses Link headers', () => {
    expect(nextFromLinkHeader('<https://a/x?p=2>; rel="next"')).toBe('https://a/x?p=2');
    expect(nextFromLinkHeader('<https://a/1>; rel="prev", <https://a/3>; rel="next last"')).toBe('https://a/3');
    expect(nextFromLinkHeader('<https://a/1>; rel="prev"')).toBeNull();
    expect(nextFromLinkHeader(null)).toBeNull();
  });

  it('none: one request', async () => {
    const def = withPagination({ style: 'none' }, {});
    const { calls } = await walk(def, () => ({ body: { devices: [device(1)], next: 'ignored' } }));
    expect(calls).toHaveLength(1);
  });

  it('the cursor holds the style and the next value only, and a foreign style restarts', () => {
    const encoded = encodePageState({ style: 'cursor', next: 'abc' });
    expect(JSON.parse(Buffer.from(encoded!, 'base64').toString('utf8'))).toEqual({ style: 'cursor', next: 'abc' });
    expect(decodePageState(encoded, 'cursor')).toEqual({ style: 'cursor', next: 'abc' });
    expect(decodePageState(encoded, 'page')).toBeNull();
    expect(decodePageState('not-base64-json', 'cursor')).toBeNull();
  });

  it('refuses a records path that does not find a list', async () => {
    await expect(walk(definition(), () => ({ body: { devices: { not: 'a list' } } }))).rejects.toThrow('The records path did not find a list in the response.');
  });

  it('refuses more than 10,000 records on one page', async () => {
    await expect(walk(definition(), () => ({ body: { devices: Array.from({ length: 10_001 }, (_, i) => ({ id: i })) } }))).rejects.toThrow(/10,000 records/);
  });
});

describe('organizations', () => {
  it('endpoint: reads idPath and namePath and skips records without an id', async () => {
    installFetchCalls(() => ({ body: { groups: [{ id: 'g1', name: 'Acme' }, { id: 7 }, { name: 'no id' }, { id: { x: 1 } }] } }));
    await expect(driver.listSourceOrgs(ctx())).resolves.toEqual([
      { externalId: 'g1', name: 'Acme', hint: null },
      { externalId: '7', name: '7', hint: null },
    ]);
  });

  it('single: one organization without a request', async () => {
    const calls = installFetchCalls(() => ({ body: {} }));
    const def = definition({ organizations: { mode: 'single' } });
    (def.resources.items as { request: unknown }).request = { path: '/devices', query: { cursor: '{cursor}' } };
    await expect(driver.listSourceOrgs(ctx(def))).resolves.toEqual([{ externalId: 'default', name: 'All records', hint: null }]);
    expect(calls).toHaveLength(0);
  });

  it('field: collects distinct organization values and gives each org its own records', async () => {
    const def = definition({ organizations: { mode: 'field' } });
    Object.assign(def.resources.items as object, {
      request: { path: '/devices', query: { cursor: '{cursor}' } },
      orgIdPath: 'tenant.id',
      orgNamePath: 'tenant.name',
    });
    installFetchCalls(() => ({
      body: {
        devices: [
          device(1, { tenant: { id: 't1', name: 'One' } }),
          device(2, { tenant: { id: 't2', name: 'Two' } }),
          device(3, { tenant: { id: 't1', name: 'One' } }),
        ],
      },
    }));
    await expect(driver.listSourceOrgs(ctx(def))).resolves.toEqual([
      { externalId: 't1', name: 'One', hint: null },
      { externalId: 't2', name: 'Two', hint: null },
    ]);
    const page = await driver.fetchRecords(fetchCtx(ctx(def), 'items', 't1'), null);
    expect(page.records.map((r) => (r as { externalId: string }).externalId)).toEqual(['1', '3']);
  });

  it('refuses to fetch for an organization the API does not list (tenant isolation)', async () => {
    installFetchCalls((url) => (url.pathname.endsWith('/groups') ? { body: { groups: [{ id: 'g1' }] } } : { body: { devices: [] } }));
    await expect(driver.fetchRecords(fetchCtx(ctx(), 'items', 'g-other'), null)).rejects.toBeInstanceOf(DriverAuthError);
    const single = definition({ organizations: { mode: 'single' } });
    (single.resources.items as { request: unknown }).request = { path: '/devices', query: { cursor: '{cursor}' } };
    await expect(driver.fetchRecords(fetchCtx(ctx(single), 'items', 'g1'), null)).rejects.toBeInstanceOf(DriverAuthError);
  });

  it('endpoint: a resource scoped only by orgIdPath never gives one organization the records of another', async () => {
    const def = definition();
    Object.assign(def.resources.items as object, {
      request: { path: '/devices', query: { cursor: '{cursor}' } },
      orgIdPath: 'groupId',
    });
    // The API ignores the organization: every request returns every device.
    installFetchCalls((url) => (url.pathname.endsWith('/groups')
      ? { body: { groups: [{ id: 'g1' }, { id: 'g2' }] } }
      : { body: { devices: [device(1, { groupId: 'g1' }), device(2, { groupId: 'g2' }), device(3, { groupId: 'g1' })] } }));
    const ids = async (org: string) => (await driver.fetchRecords(fetchCtx(ctx(def), 'items', org), null))
      .records.map((r) => (r as { externalId: string }).externalId);
    expect(await ids('g1')).toEqual(['1', '3']);
    expect(await ids('g2')).toEqual(['2']);
  });

  it('endpoint: refuses to sync a resource with neither {orgId} nor orgIdPath, so 2 organizations never share records', async () => {
    const def = definition();
    Object.assign(def.resources.items as object, { request: { path: '/devices', query: { cursor: '{cursor}' } } });
    const calls = installFetchCalls((url) => (url.pathname.endsWith('/groups')
      ? { body: { groups: [{ id: 'g1' }, { id: 'g2' }] } }
      : { body: { devices: [device(1)] } }));
    for (const org of ['g1', 'g2']) {
      await expect(driver.fetchRecords(fetchCtx(ctx(def), 'items', org), null)).rejects.toThrow('The saved API definition is not valid.');
    }
    expect(calls).toHaveLength(0);
  });

  it('endpoint: drops records whose orgIdPath names another organization (IDOR backstop)', async () => {
    const def = definition();
    Object.assign(def.resources.items as object, { orgIdPath: 'groupId' });
    installFetchCalls((url) => (url.pathname.endsWith('/groups')
      ? { body: { groups: [{ id: 'g1' }] } }
      : { body: { devices: [device(1, { groupId: 'g1' }), device(2, { groupId: 'g2' }), device(3)] } }));
    const page = await driver.fetchRecords(fetchCtx(ctx(def)), null);
    expect(page.records.map((r) => (r as { externalId: string }).externalId)).toEqual(['1']);
  });
});

describe('Test connection and Check setup', () => {
  function singleDefinition(): CustomApiDefinitionInput {
    const def = definition({ organizations: { mode: 'single' } });
    (def.resources.items as { request: unknown }).request = { path: '/devices', query: { cursor: '{cursor}' } };
    return def;
  }

  it('single: both checks read the first page of the first enabled resource', async () => {
    const calls = installFetchCalls(() => ({ body: { devices: [device(1)], next: 'c2' } }));
    await expect(driver.testConnection(ctx(singleDefinition()))).resolves.toEqual({ ok: true, details: 'Connected to the API (1 organizations).' });
    await expect(driver.diagnose({ mode: 'connection', ctx: ctx(singleDefinition()) } as never)).resolves.toMatchObject({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.url.startsWith(`${BASE}/devices`) && call.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('single: refused credentials fail both checks', async () => {
    installFetchCalls(() => ({ status: 401, body: {} }));
    await expect(driver.testConnection(ctx(singleDefinition()))).rejects.toBeInstanceOf(DriverAuthError);
    const check = await driver.diagnose({ mode: 'connection', ctx: ctx(singleDefinition()) } as never);
    expect(check.ok).toBe(false);
    expect(check.failures[0]).toMatchObject({ stepId: 'credentials' });
  });

  it('single: a network failure fails both checks', async () => {
    setDefaultFetchForTests((async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    setDefaultResolveForTests(async () => ['1.2.3.4']);
    await expect(driver.testConnection(ctx(singleDefinition()))).rejects.toThrow();
    await expect(driver.diagnose({ mode: 'connection', ctx: ctx(singleDefinition()) } as never)).resolves.toMatchObject({ ok: false });
  });

  it('single: with no resource turned on, both checks fail without a request', async () => {
    const calls = installFetchCalls(() => ({ body: {} }));
    const def = definition({ organizations: { mode: 'single' }, resources: { items: { enabled: false } } });
    await expect(driver.testConnection(ctx(def))).rejects.toBeInstanceOf(CustomApiRequestError);
    await expect(driver.diagnose({ mode: 'connection', ctx: ctx(def) } as never)).resolves.toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });

  it('endpoint: refused credentials fail both checks', async () => {
    installFetchCalls(() => ({ status: 403, body: {} }));
    await expect(driver.testConnection(ctx())).rejects.toBeInstanceOf(DriverAuthError);
    await expect(driver.diagnose({ mode: 'connection', ctx: ctx() } as never)).resolves.toMatchObject({ ok: false });
  });
});

describe('records', () => {
  function onePage(items: unknown[], def = definition()) {
    installFetchCalls((url) => (url.pathname.endsWith('/groups') ? { body: { groups: [{ id: 'g1' }] } } : { body: { devices: items, licenses: items } }));
    return driver.fetchRecords(fetchCtx(ctx(def)), null);
  }

  it('Items: name, match_key and every field go into fields; the section shows the fields', async () => {
    const page = await onePage([device(1)]);
    const record = page.records[0] as { externalId: string; displayName: string; fields: Record<string, unknown>; section: unknown };
    expect(record.externalId).toBe('1');
    expect(record.fields).toEqual({ name: 'pc-1', match_key: 'SN1', hostname: 'pc-1.corp', agent_version: '1.2.3', last_contact: '2026-11-01T10:00:00.000Z', cores: 8 });
    expect(integrationSectionSchema.safeParse(record.section).success).toBe(true);
    const section = integrationSectionSchema.parse(record.section);
    expect(section.title).toBe('Custom API');
    expect(section.groups.map((g) => g.key)).toEqual(['details']);
    expect(section.groups[0]!.rows).toEqual([
      { kind: 'text', label: 'Hostname', value: 'pc-1.corp' },
      { kind: 'text', label: 'Agent version', value: '1.2.3' },
      { kind: 'datetime', label: 'Last contact', value: '2026-11-01T10:00:00.000Z' },
      { kind: 'number', label: 'Cores', value: 8 },
    ]);
  });

  it('reads single values only, caps strings, and skips records with no usable id', async () => {
    const long = 'x'.repeat(5_000);
    const page = await onePage([
      device(1, { name: { nested: true }, hostname: long, system: { serial: ['a'], ip: '10.0.0.5' } }),
      { name: 'no id' },
      device(1),
    ]);
    expect(page.records).toHaveLength(1);
    const fields = (page.records[0] as { fields: Record<string, unknown> }).fields;
    expect(fields.name).toBe('1');
    expect(fields.match_key).toBeNull();
    expect((fields.hostname as string).length).toBe(1_000);
  });

  it('Items of any kind: typed fields, and no match_key when no match path is set', async () => {
    const def = definition({
      resources: {
        items: {
          enabled: true,
          request: { path: '/licenses', query: { g: '{orgId}' } },
          recordsPath: 'licenses',
          idPath: 'id',
          namePath: 'name',
          fields: [
            { key: 'seats', label: 'Seats', path: 'seats', type: 'NUMBER' },
            { key: 'active', label: 'Active', path: 'active', type: 'BOOLEAN' },
            { key: 'portal', label: 'Portal', path: 'url', type: 'URL' },
          ],
        },
      },
    });
    installFetchCalls((url) => (url.pathname.endsWith('/groups')
      ? { body: { groups: [{ id: 'g1' }] } }
      : { body: { licenses: [{ id: 'L1', name: 'Office', seats: 5, active: 'true', url: 'https://portal.example/l/1' }] } }));
    const page = await driver.fetchRecords(fetchCtx(ctx(def), 'items'), null);
    const record = page.records[0] as { fields: Record<string, unknown>; section: unknown };
    expect(record.fields).toEqual({ name: 'Office', seats: 5, active: true, portal: 'https://portal.example/l/1' });
    const section = integrationSectionSchema.parse(record.section);
    expect(section.groups[0]!.rows).toContainEqual({ kind: 'link', label: 'Portal', value: 'https://portal.example/l/1' });
  });

  it('Items turned off in the definition is skipped by the runner', async () => {
    const def = definition();
    def.resources.items = { enabled: false };
    await expect(driver.fetchRecords(fetchCtx(ctx(def), 'items'), null)).rejects.toBeInstanceOf(DriverResourceUnavailableError);
  });

  it('listSourceFields: Name, Match key when a match path is set, then each field', async () => {
    const items = await driver.listSourceFields({ ...ctx(), externalOrgId: 'g1', resourceKey: 'items' });
    expect(items.map((f) => f.key)).toEqual(['name', 'match_key', 'hostname', 'agent_version', 'last_contact', 'cores']);
    const def = definition({
      resources: {
        items: {
          enabled: true,
          request: { path: '/x', query: { g: '{orgId}' } },
          idPath: 'id',
          namePath: 'name',
          fields: [{ key: 'seats', label: 'Seats', path: 'seats', type: 'NUMBER' }],
        },
      },
    });
    const other = await driver.listSourceFields({ ...ctx(def), externalOrgId: 'g1', resourceKey: 'items' });
    expect(other).toEqual([
      { key: 'name', label: 'Name', hintType: 'TEXT', alwaysPresent: true },
      { key: 'seats', label: 'Seats', hintType: 'NUMBER', alwaysPresent: false },
    ]);
  });

  it('builds the Open in link from recordUrl, on any HTTPS host, with the id encoded', () => {
    const config = customApiDefinitionSchema.parse(definition());
    expect(sourceRecordUrl('custom-api', { externalId: 'g1:items:a/b c', externalOrgId: 'g1', resourceKey: 'items', config })).toBe('https://app.example.com/devices/a%2Fb%20c');
    expect(sourceRecordUrl('custom-api', { externalId: 'g1:devices:1', externalOrgId: 'g1', resourceKey: 'devices', config })).toBeUndefined();
    expect(sourceRecordUrl('custom-api', { externalId: 'g1:items:1', externalOrgId: 'g1', resourceKey: 'items', config: { broken: true } })).toBeUndefined();
  });
});

describe('validateConfiguration', () => {
  const valid = definition() as unknown as Record<string, unknown>;

  it('needs a valid definition', () => {
    expect(() => driver.validateConfiguration({ version: 2 }, { token: 't' })).toThrow(BadRequestException);
  });

  it('needs exactly the secret keys of the auth method and the secret headers', () => {
    expect(() => driver.validateConfiguration(valid, { token: 't', 'header:x-tenant': 'x' })).not.toThrow();
    expect(() => driver.validateConfiguration(valid, { token: 't' })).toThrow(/Enter all of: Token, Header x-tenant/);
    expect(() => driver.validateConfiguration(valid, { token: 't', 'header:x-tenant': 'x', password: 'old' })).toThrow(BadRequestException);
    expect(() => driver.validateConfiguration(valid, null)).toThrow(BadRequestException);
    expect(() => driver.validateConfiguration(valid, { token: '', 'header:x-tenant': 'x' })).toThrow(BadRequestException);
  });

  it('needs no secret, and refuses a left-over one, when the definition has no authentication', () => {
    const none = definition({ auth: { method: 'none' }, headers: [] }) as unknown as Record<string, unknown>;
    expect(() => driver.validateConfiguration(none, null)).not.toThrow();
    expect(() => driver.validateConfiguration(none, {})).not.toThrow();
    expect(() => driver.validateConfiguration(none, { token: 'stale' })).toThrow(/uses no credentials/);
    expect(driver.requiresSecret(none)).toBe(false);
    expect(driver.requiresSecret(valid)).toBe(true);
    expect(driver.requiresSecret({ broken: true })).toBe(true);
  });
});

describe('Test probe', () => {
  const parsed = () => customApiDefinitionSchema.parse(definition());
  const probe = (section: 'organizations' | 'items', items: unknown[], orgId?: string) => {
    installFetchCalls((url) => (url.pathname.endsWith('/groups') ? { body: { groups: items } } : { body: { devices: items, next: 'more' } }));
    return runProbe({ definition: parsed(), secret: { token: TOKEN, 'header:x-tenant': 't' }, section, orgId, http: ctx().http, correlationId: 'p' });
  };

  it('returns the count, more pages, up to 5 records and the key list', async () => {
    const outcome = await probe('items', Array.from({ length: 12 }, (_, i) => device(i + 1)), 'g1');
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.recordCount).toBe(12);
    expect(outcome.hasMore).toBe(true);
    expect(outcome.records).toHaveLength(5);
    expect(outcome.records[0]).toMatchObject({ id: '1', name: 'pc-1', match: 'SN1' });
    expect(outcome.records[0]!.fields.find((f) => f.key === 'cores')).toEqual({ key: 'cores', label: 'Cores', path: 'cores', value: '8', masked: false, warning: null });
    expect(outcome.keys.map((k) => k.path)).toContain('system.serial');
  });

  it('flags a mapped field with no value or with an object', async () => {
    const outcome = await probe('items', [device(1, { agent: undefined, seen: { at: 1 } })], 'g1');
    if (!outcome.ok) throw new Error(outcome.message);
    const fields = outcome.records[0]!.fields;
    expect(fields.find((f) => f.key === 'agent_version')!.warning).toBe('missing');
    expect(fields.find((f) => f.key === 'last_contact')!.warning).toBe('not_scalar');
  });

  it('masks a short value under a sensitive key, in the key list and in mapped fields', async () => {
    const def = definition();
    (def.resources.items as { fields: unknown[] }).fields = [{ key: 'notes', label: 'Notes', path: 'creds.apiToken', type: 'TEXT' }];
    installFetchCalls(() => ({ body: { devices: [device(1, { password: 'hunter2', creds: { apiToken: 'abc123' } })] } }));
    const outcome = await runProbe({ definition: customApiDefinitionSchema.parse(def), secret: { token: TOKEN, 'header:x-tenant': 't' }, section: 'items', orgId: 'g1', http: ctx().http, correlationId: 'p' });
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.keys.find((k) => k.path === 'password')).toEqual({ path: 'password', type: 'string', sample: MASK, masked: true });
    expect(outcome.keys.find((k) => k.path === 'creds.apiToken')!.sample).toBe(MASK);
    expect(outcome.records[0]!.fields.find((f) => f.key === 'notes')).toMatchObject({ value: MASK, masked: true });
    expect(JSON.stringify(outcome)).not.toContain('hunter2');
    expect(JSON.stringify(outcome)).not.toContain('abc123');
  });

  it('masks a long secret before it is cut, and anything the scan cannot clear', () => {
    const jwt = `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(100)}`;
    expect(sampleValue(['description'], jwt)).toEqual({ value: MASK, masked: true });
    expect(sampleValue(['description'], `${'x'.repeat(90)} Bearer abcdefghijklmnop`)).toEqual({ value: MASK, masked: true });
    expect(sampleValue(['hostname'], 'pc-1')).toEqual({ value: 'pc-1', masked: false });
    expect(sampleValue(['hostname'], 'y'.repeat(200)).value).toHaveLength(80);
  });

  it('organizations: lists the first page', async () => {
    const outcome = await probe('organizations', [{ id: 'g1', name: 'Acme' }]);
    expect(outcome).toMatchObject({ ok: true, recordCount: 1, records: [{ id: 'g1', name: 'Acme' }] });
  });

  it('asks for an organization id in endpoint mode, and reports API errors as fixed text', async () => {
    await expect(probe('items', [])).resolves.toMatchObject({ ok: false, message: expect.stringMatching(/organization id/) });
    installFetchCalls(() => ({ status: 403, body: { detail: 'secret upstream text' } }));
    const outcome = await runProbe({ definition: parsed(), secret: { token: TOKEN, 'header:x-tenant': 't' }, section: 'items', orgId: 'g1', http: ctx().http, correlationId: 'p' });
    expect(outcome).toEqual({ ok: false, section: 'items', message: 'The API refused the credentials (403).', status: 403 });
  });

  it('never returns the raw body', async () => {
    const outcome = await probe('items', [device(1, { blob: { deep: { very: 'raw-marker' } } })], 'g1');
    if (!outcome.ok) throw new Error(outcome.message);
    expect(Object.keys(outcome).sort()).toEqual(['hasMore', 'keys', 'ok', 'recordCount', 'records', 'section']);
  });
});
