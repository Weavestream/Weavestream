// Mock the egress layer itself so no test can ever reach api.cloudflare.com.
const mockFetch = jest.fn();
jest.mock('../driver-utils.js', () => ({
  fetchWithRetry: (url: string) => mockFetch(url),
}));

import { CloudflareApiClient } from './cloudflare-api.client.js';
import { DriverAuthError } from '../integration-driver.js';

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

describe('CloudflareApiClient registrar', () => {
  const api = new CloudflareApiClient();
  afterEach(() => mockFetch.mockReset());

  it('unions zones with the registrar list, which on real accounts drops rows', async () => {
    stubFetch([
      [
        '/zones?',
        () =>
          respond(
            200,
            ok(
              [
                { name: 'zone-only.com', status: 'active', name_servers: ['a.ns.cloudflare.com'] },
                { name: 'deleted.com', status: 'deleted' },
              ],
              { page: 1, total_pages: 1 },
            ),
          ),
      ],
      // Page 1 has a row, page 2 is empty: stop there regardless of total_pages.
      ['registrar/domains?per_page=50&page=1', () => respond(200, ok([{ name: 'reg-only.com' }]))],
      ['registrar/domains?per_page=50&page=2', () => respond(200, ok([]))],
    ]);

    const out = await api.listRegistrarCandidates('acct', CTX);
    expect([...out.keys()].sort()).toEqual(['reg-only.com', 'zone-only.com']);
    expect(out.get('zone-only.com')).toEqual({ hasZone: true, zoneNameservers: ['a.ns.cloudflare.com'] });
  });

  it('maps a registered domain', async () => {
    stubFetch([
      [
        'registrar/domains/acme.dev',
        () =>
          respond(
            200,
            ok({
              name: 'acme.dev',
              cloudflare_registration: true,
              current_registrar: 'Cloudflare',
              auto_renew: true,
              locked: true,
              registered_at: '2021-03-01T00:00:00Z',
              expires_at: '2027-03-01T00:00:00Z',
              registry_statuses: 'clientTransferProhibited, serverDeleteProhibited',
            }),
          ),
      ],
    ]);
    const d = await api.getRegistrarDomain(
      'acct',
      'acme.dev',
      { hasZone: true, zoneNameservers: ['X.NS.CLOUDFLARE.COM'] },
      CTX,
    );
    expect(d).toMatchObject({
      cloudflareRegistration: true,
      autoRenew: true,
      expiresAt: new Date('2027-03-01T00:00:00Z'),
      registryStatuses: ['clientTransferProhibited', 'serverDeleteProhibited'],
      nameservers: ['x.ns.cloudflare.com'],
    });
  });

  it('returns null for a name that moved to another account (mostly-null record, no zone)', async () => {
    stubFetch([
      ['registrar/domains/moved.com', () => respond(200, ok({ name: 'moved.com', current_registrar: null }))],
    ]);
    await expect(
      api.getRegistrarDomain('acct', 'moved.com', { hasZone: false, zoneNameservers: [] }, CTX),
    ).resolves.toBeNull();
  });

  it('keeps a zone whose registration is elsewhere', async () => {
    stubFetch([['registrar/domains/ext.com', () => respond(404, { success: false, errors: [] })]]);
    await expect(
      api.getRegistrarDomain('acct', 'ext.com', { hasZone: true, zoneNameservers: [] }, CTX),
    ).resolves.toMatchObject({ name: 'ext.com', cloudflareRegistration: false, expiresAt: null });
  });

  it('aborts on a 5xx instead of treating the domain as gone', async () => {
    stubFetch([['registrar/domains/flaky.com', () => respond(502, { success: false, errors: [] })]]);
    await expect(
      api.getRegistrarDomain('acct', 'flaky.com', { hasZone: false, zoneNameservers: [] }, CTX),
    ).rejects.toThrow(/failed/);
  });

  it('aborts the whole sync on an auth failure, naming the registrar permission', async () => {
    stubFetch([['registrar/domains/x.com', () => respond(403, { success: false, errors: [] })]]);
    const p = api.getRegistrarDomain('acct', 'x.com', { hasZone: true, zoneNameservers: [] }, CTX);
    await expect(p).rejects.toBeInstanceOf(DriverAuthError);
    await expect(
      api.getRegistrarDomain('acct', 'x.com', { hasZone: true, zoneNameservers: [] }, CTX),
    ).rejects.toThrow(/Registrar: Domains » Read/);
  });
});
