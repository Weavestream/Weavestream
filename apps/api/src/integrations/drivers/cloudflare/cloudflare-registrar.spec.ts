// Mock the egress layer itself so no test can ever reach api.cloudflare.com.
const mockFetch = jest.fn();
jest.mock('../driver-utils.js', () => ({
  fetchWithRetry: (url: string) => mockFetch(url),
}));

import { CloudflareApiClient } from './cloudflare-api.client.js';
import { DriverAuthError } from '../integration-driver.js';
import { CloudflareDriver } from './cloudflare.driver.js';

const CTX = {
  apiToken: 't',
  http: { timeoutMs: 1000, maxRetries: 0, backoffMs: 0 },
  correlationId: 'c',
};

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Route table: first matching substring wins. */
function stubFetch(routes: Array<[string, () => Response]>) {
  mockFetch.mockImplementation(async (url: string) => {
    const hit = routes.find(([frag]) => url.includes(frag));
    if (!hit) throw new Error(`unexpected fetch ${url}`);
    return hit[1]();
  });
}

const ok = <T>(result: T, result_info?: object) => ({ success: true, errors: [], result, result_info });

const zonesPage = (zones: object[]) =>
  respond(200, ok(zones, { page: 1, total_pages: 1, total_count: zones.length }));

describe('CloudflareApiClient registrar', () => {
  const api = new CloudflareApiClient();
  afterEach(() => mockFetch.mockReset());

  it('reads registrations from the supported API, following the cursor to the end', async () => {
    stubFetch([
      ['/zones?', () => zonesPage([])],
      // Most specific first: the second page is requested with the cursor.
      ['registrar/registrations?per_page=50&cursor=c2', () => respond(200, ok([{ domain_name: 'b.com' }], { cursor: '' }))],
      ['registrar/registrations?per_page=50', () => respond(200, ok([{ domain_name: 'A.com' }], { cursor: 'c2' }))],
    ]);
    const out = await api.listRegistrarDomains('acct', CTX);
    expect(out.map((d) => d.name).sort()).toEqual(['a.com', 'b.com']);
    // The retired endpoints are never called.
    for (const [url] of mockFetch.mock.calls) expect(url).not.toMatch(/registrar\/domains/);
  });

  it('maps a registration and takes nameservers from its zone', async () => {
    stubFetch([
      ['/zones?', () => zonesPage([{ name: 'acme.dev', status: 'active', name_servers: ['X.NS.CLOUDFLARE.COM'] }])],
      [
        'registrar/registrations?',
        () =>
          respond(
            200,
            ok(
              [
                {
                  domain_name: 'acme.dev',
                  status: 'active',
                  auto_renew: true,
                  locked: true,
                  created_at: '2021-03-01T00:00:00Z',
                  expires_at: '2027-03-01T00:00:00Z',
                  privacy_mode: 'redaction',
                },
              ],
              { cursor: '' },
            ),
          ),
      ],
    ]);
    const [d] = await api.listRegistrarDomains('acct', CTX);
    expect(d).toEqual({
      name: 'acme.dev',
      cloudflareRegistration: true,
      registrar: 'Cloudflare',
      autoRenew: true,
      locked: true,
      registeredAt: new Date('2021-03-01T00:00:00Z'),
      expiresAt: new Date('2027-03-01T00:00:00Z'),
      registryStatuses: ['active'],
      nameservers: ['x.ns.cloudflare.com'],
      hasZone: true,
    });
  });

  it('keeps a live zone registered elsewhere, without registrar facts, and drops deleted zones', async () => {
    stubFetch([
      [
        '/zones?',
        () =>
          zonesPage([
            { name: 'ext.com', status: 'active', name_servers: ['a.ns.cloudflare.com'] },
            { name: 'deleted.com', status: 'deleted' },
          ]),
      ],
      ['registrar/registrations?', () => respond(200, ok([], { cursor: '' }))],
    ]);
    const out = await api.listRegistrarDomains('acct', CTX);
    expect(out).toEqual([
      expect.objectContaining({
        name: 'ext.com',
        cloudflareRegistration: false,
        registrar: null,
        autoRenew: null,
        expiresAt: null,
        hasZone: true,
      }),
    ]);
  });

  it.each([
    ['a 400', 400],
    ['a 404', 404],
    ['a 5xx', 502],
  ])('fails the whole listing on %s instead of returning empty registrar facts', async (_l, status) => {
    stubFetch([
      ['/zones?', () => zonesPage([{ name: 'acme.dev', status: 'active' }])],
      [
        'registrar/registrations?',
        () => respond(status, { success: false, errors: [{ code: 10000, message: 'Bad Request' }], result: null }),
      ],
    ]);
    await expect(api.listRegistrarDomains('acct', CTX)).rejects.toThrow(/Bad Request \(code 10000\)/);
  });

  it('fails on a repeated cursor instead of looping', async () => {
    stubFetch([
      ['/zones?', () => zonesPage([])],
      ['registrar/registrations?', () => respond(200, ok([{ domain_name: 'a.com' }], { cursor: 'same' }))],
    ]);
    await expect(api.listRegistrarDomains('acct', CTX)).rejects.toThrow(/repeated a page cursor/);
  });

  it("reports Cloudflare's own reason on a 403, with the permission hint", async () => {
    stubFetch([
      ['/zones?', () => zonesPage([])],
      [
        'registrar/registrations?',
        () =>
          respond(403, {
            success: false,
            errors: [{ code: 10000, message: 'Authentication error' }],
            result: null,
          }),
      ],
    ]);
    const p = api.listRegistrarDomains('acct', CTX);
    await expect(p).rejects.toBeInstanceOf(DriverAuthError);
    await expect(api.listRegistrarDomains('acct', CTX)).rejects.toThrow(
      /returned 403: Authentication error \(code 10000\)\. Registrar sync needs/,
    );
  });
});

describe('CloudflareDriver.testConnection', () => {
  const driver = new CloudflareDriver(new CloudflareApiClient());
  const http = CTX.http;
  const secret = { apiToken: 't' };
  const CO = '00000000-0000-4000-8000-0000000000aa';
  afterEach(() => mockFetch.mockReset());

  it('checks only the Gateway lists while domain sync is off', async () => {
    stubFetch([['/gateway/lists', () => respond(200, ok([]))]]);
    await expect(driver.testConnection({ accountId: 'acct' }, secret, http, 'c')).resolves.toMatchObject({
      ok: true,
    });
    for (const [url] of mockFetch.mock.calls) expect(url).toMatch(/gateway\/lists/);
  });

  it('also checks zone and registrar access once domain sync is on', async () => {
    stubFetch([
      ['/gateway/lists', () => respond(200, ok([]))],
      ['/zones?', () => zonesPage([{ name: 'a.com', status: 'active' }])],
      ['registrar/registrations?', () => respond(200, ok([], { cursor: '' }))],
    ]);
    const res = await driver.testConnection({ accountId: 'acct', domainsCompanyId: CO }, secret, http, 'c');
    expect(res.details).toMatch(/zone and registrar access confirmed/);
  });

  it('fails when the token lacks registrar access, saying which check failed', async () => {
    stubFetch([
      ['/gateway/lists', () => respond(200, ok([]))],
      ['/zones?', () => zonesPage([])],
      ['registrar/registrations?', () => respond(403, { success: false, errors: [], result: null })],
    ]);
    const p = driver.testConnection({ accountId: 'acct', domainsCompanyId: CO }, secret, http, 'c');
    await expect(p).rejects.toBeInstanceOf(DriverAuthError);
    await expect(
      driver.testConnection({ accountId: 'acct', domainsCompanyId: CO }, secret, http, 'c'),
    ).rejects.toThrow(/^Domain sync check failed: .*403/);
  });

  it('passes a domains-only token while domain sync is on, and says Gateway lists are not reachable', async () => {
    stubFetch([
      ['/gateway/lists', () => respond(403, { success: false, errors: [], result: null })],
      ['/zones?', () => zonesPage([{ name: 'a.com', status: 'active' }])],
      ['registrar/registrations?', () => respond(200, ok([], { cursor: '' }))],
    ]);
    const res = await driver.testConnection({ accountId: 'acct', domainsCompanyId: CO }, secret, http, 'c');
    expect(res.details).toMatch(/no Zero Trust access, which only IP lists need/);
    expect(res.details).toMatch(/zone and registrar access confirmed/);
  });

  it('still fails a token without Zero Trust access while domain sync is off', async () => {
    stubFetch([['/gateway/lists', () => respond(403, { success: false, errors: [], result: null })]]);
    await expect(driver.testConnection({ accountId: 'acct' }, secret, http, 'c')).rejects.toBeInstanceOf(
      DriverAuthError,
    );
  });
});
