import {
  DriverAuthError,
  DriverRateLimitError,
  type IntegrationContext,
} from '../integration-driver.js';
import {
  setDefaultFetchForTests,
  setDefaultResolveForTests,
} from '../../../common/egress/safe-fetch.js';
import { BreezePartnerApiClient } from './breeze-partner-api.client.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const REVISION = 'a'.repeat(64);
const SNAPSHOT = '2026-07-14T12:00:00.000Z';
const UPDATED = '2026-07-14T11:00:00.000Z';

type Frame =
  | { status?: number; body: unknown; headers?: Record<string, string> }
  | { error: Error };

function installFetchScript(frames: Frame[]) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let index = 0;
  setDefaultResolveForTests(async () => ['1.2.3.4']);
  setDefaultFetchForTests((async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const frame = frames[index++];
    if (!frame) throw new Error(`Unscripted Breeze request: ${url}`);
    if ('error' in frame) throw frame.error;
    return new Response(typeof frame.body === 'string' ? frame.body : JSON.stringify(frame.body), {
      status: frame.status ?? 200,
      headers: frame.headers,
    });
  }) as typeof fetch);
  return { calls };
}

function envelope(data: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1',
    snapshotAt: SNAPSHOT,
    data,
    nextCursor: null,
    hasMore: false,
    ...overrides,
  };
}

function org(id = ORG) {
  return {
    id,
    orgId: id,
    siteId: null,
    sourceUpdatedAt: UPDATED,
    revision: REVISION,
    name: 'Acme',
    slug: 'acme',
    type: 'customer',
  };
}

function site() {
  return {
    id: SITE,
    orgId: ORG,
    siteId: SITE,
    sourceUpdatedAt: UPDATED,
    revision: REVISION,
    name: 'HQ',
    timezone: 'America/Denver',
    address: null,
    contact: null,
  };
}

function device() {
  return {
    id: DEVICE,
    orgId: ORG,
    siteId: SITE,
    sourceUpdatedAt: UPDATED,
    revision: REVISION,
    hostname: 'ws-01',
    displayName: 'Workstation 01',
    type: { os: 'windows', role: 'workstation', virtual: false, virtualizationPlatform: null },
    operatingSystem: { edition: 'Windows 11 Pro', build: '26100', architecture: 'x64' },
    installation: { enrolledAt: '2025-01-01T00:00:00.000Z' },
    hardwareIdentity: { serialNumber: 'SER-1', manufacturer: 'Dell', model: 'Latitude' },
    stableIdentifiers: { assetTag: 'AT-1', inventoryId: null, externalId: null },
    tags: ['managed'],
    groupIds: [],
    groupMembership: { total: 0, included: 0, complete: true, reason: null },
    linkGroupId: null,
    linkGroupRole: null,
  };
}

function context(overrides: Partial<IntegrationContext> = {}): IntegrationContext {
  return {
    config: { baseUrl: 'https://breeze.example.test/' },
    secret: { apiKey: 'top-secret-key' },
    http: { timeoutMs: 25, maxRetries: 0, backoffMs: 0 },
    correlationId: 'corr-1',
    ...overrides,
  };
}

afterEach(() => {
  setDefaultFetchForTests(null);
  setDefaultResolveForTests(null);
  jest.restoreAllMocks();
});

describe('BreezePartnerApiClient', () => {
  it('builds the exact allowlisted URL and sends the API key only in X-API-Key', async () => {
    const fx = installFetchScript([{ body: envelope([site()]) }]);
    await new BreezePartnerApiClient().fetchPage(context(), {
      resource: 'sites',
      externalOrgId: ORG,
      cursor: null,
      updatedSince: UPDATED,
    });
    expect(fx.calls).toEqual([
      {
        url: `https://breeze.example.test/api/v1/partner-api/sites?orgId=${ORG}&updatedSince=${encodeURIComponent(UPDATED)}&limit=500`,
        headers: { Accept: 'application/json', 'X-API-Key': 'top-secret-key' },
      },
    ]);
    expect(fx.calls[0]!.url).not.toContain('top-secret-key');
  });

  it('uses bounded fan-out parent pages and preserves opaque cursor continuation', async () => {
    const fx = installFetchScript([
      { body: envelope([], { nextCursor: 'fanout-page-2', hasMore: true }) },
      { body: envelope([]) },
    ]);
    const client = new BreezePartnerApiClient();

    const first = await client.fetchPage(context(), {
      resource: 'network-equipment',
      externalOrgId: ORG,
      cursor: null,
      updatedSince: null,
    });
    await client.fetchPage(context(), {
      resource: 'network-equipment',
      externalOrgId: ORG,
      cursor: first.nextCursor,
      updatedSince: null,
    });

    expect(fx.calls).toHaveLength(2);
    expect(fx.calls[0]!.url).toBe(
      `https://breeze.example.test/api/v1/partner-api/device-inventory?orgId=${ORG}&limit=20`,
    );
    expect(fx.calls[1]!.url).toBe(
      `https://breeze.example.test/api/v1/partner-api/device-inventory?orgId=${ORG}&cursor=fanout-page-2&limit=20`,
    );
  });

  it('does not follow redirects or forward X-API-Key to another public origin', async () => {
    const fx = installFetchScript([
      {
        status: 302,
        body: '',
        headers: { Location: 'https://redirected.example.test/steal' },
      },
      { body: envelope([]) },
    ]);
    await expect(new BreezePartnerApiClient().testConnection(context())).rejects.toThrow(
      /Breeze partner API request failed/i,
    );
    expect(fx.calls).toHaveLength(1);
    expect(fx.calls.filter((call) => call.url.startsWith('https://redirected.example.test/')))
      .toHaveLength(0);
  });

  it.each([
    'https://user:password@breeze.example.test',
    'https://breeze.example.test?apiKey=secret',
    'https://breeze.example.test/#secret',
  ])('rejects credentials in baseUrl before network I/O: %s', async (baseUrl) => {
    const fx = installFetchScript([]);
    await expect(
      new BreezePartnerApiClient().testConnection(context({ config: { baseUrl } })),
    ).rejects.toThrow(/baseUrl/i);
    expect(fx.calls).toHaveLength(0);
  });

  it('validates foundational site and device records strictly', async () => {
    installFetchScript([{ body: envelope([site()]) }, { body: envelope([device()]) }]);
    const client = new BreezePartnerApiClient();
    await expect(
      client.fetchPage(context(), {
        resource: 'sites',
        externalOrgId: ORG,
        cursor: null,
        updatedSince: null,
      }),
    ).resolves.toMatchObject({ data: [{ id: SITE }] });
    await expect(
      client.fetchPage(context(), {
        resource: 'devices',
        externalOrgId: ORG,
        cursor: null,
        updatedSince: null,
      }),
    ).resolves.toMatchObject({ data: [{ id: DEVICE }] });
  });

  it.each([
    envelope([site()], { schemaVersion: '2' }),
    envelope([{ ...site(), unexpected: true }]),
    envelope([{ ...site(), id: `${SITE}\0` }]),
    envelope([{ ...site(), sourceUpdatedAt: '2026-07-14T12:00:00.001Z' }]),
    envelope([site()], { nextCursor: 'next', hasMore: false }),
    envelope([site()], { snapshotAt: 'not-an-iso-date' }),
  ])('rejects an invalid strict envelope before returning data', async (body) => {
    installFetchScript([{ body }]);
    await expect(
      new BreezePartnerApiClient().fetchPage(context(), {
        resource: 'sites',
        externalOrgId: ORG,
        cursor: null,
        updatedSince: null,
      }),
    ).rejects.toThrow(/invalid response/i);
  });

  it('rejects an unknown resource before network I/O', async () => {
    const fx = installFetchScript([]);
    await expect(
      new BreezePartnerApiClient().fetchPage(context(), {
        resource: 'unknown' as 'sites',
        externalOrgId: ORG,
        cursor: null,
        updatedSince: null,
      }),
    ).rejects.toThrow(/resource/i);
    expect(fx.calls).toHaveLength(0);
  });

  it('walks organization pages with one snapshot and de-duplicates UUIDs', async () => {
    const fx = installFetchScript([
      { body: envelope([org()], { nextCursor: 'opaque-1', hasMore: true }) },
      { body: envelope([org(), org('44444444-4444-4444-8444-444444444444')]) },
    ]);
    const organizations = await new BreezePartnerApiClient().listOrganizations(context());
    expect(organizations).toHaveLength(2);
    expect(fx.calls[1]!.url).toContain('cursor=opaque-1');
    expect(fx.calls[1]!.url).toContain('limit=500');
  });

  it('rejects unstable snapshots and repeated cursors', async () => {
    installFetchScript([
      { body: envelope([org()], { nextCursor: 'same', hasMore: true }) },
      { body: envelope([], { snapshotAt: '2026-07-14T12:00:01.000Z' }) },
    ]);
    await expect(new BreezePartnerApiClient().listOrganizations(context())).rejects.toThrow(
      /snapshot/i,
    );

    installFetchScript([{ body: envelope([site()], { nextCursor: 'cursor-1', hasMore: true }) }]);
    await expect(
      new BreezePartnerApiClient().fetchPage(context(), {
        resource: 'sites',
        externalOrgId: ORG,
        cursor: 'cursor-1',
        updatedSince: null,
      }),
    ).rejects.toThrow(/cursor/i);
  });

  it('caps organization traversal at 1000 pages', async () => {
    installFetchScript(
      Array.from({ length: 1001 }, (_, index) => ({
        body: envelope([], { nextCursor: `cursor-${index + 1}`, hasMore: true }),
      })),
    );
    await expect(new BreezePartnerApiClient().listOrganizations(context())).rejects.toThrow(
      /1000 pages/i,
    );
  });

  it('uses a bounded organization probe for testConnection', async () => {
    const fx = installFetchScript([{ body: envelope([]) }]);
    await expect(new BreezePartnerApiClient().testConnection(context())).resolves.toBeUndefined();
    expect(fx.calls[0]!.url).toBe(
      'https://breeze.example.test/api/v1/partner-api/organizations?limit=1',
    );
  });

  it.each([401, 403])('maps %i to a sanitized DriverAuthError', async (status) => {
    installFetchScript([{ status, body: `top-secret-key upstream rejected` }]);
    const promise = new BreezePartnerApiClient().testConnection(context());
    await expect(promise).rejects.toBeInstanceOf(DriverAuthError);
    await expect(promise).rejects.not.toThrow(/top-secret-key/);
  });

  it('preserves a 429 retry hint as DriverRateLimitError', async () => {
    installFetchScript([{ status: 429, body: 'slow down', headers: { 'Retry-After': '7' } }]);
    const promise = new BreezePartnerApiClient().testConnection(context());
    await expect(promise).rejects.toMatchObject({
      name: 'DriverRateLimitError',
      retryAfterMs: 7000,
    } satisfies Partial<DriverRateLimitError>);
  });

  it('retries 429 and 5xx responses through the shared guarded transport', async () => {
    const fx = installFetchScript([
      { status: 429, body: 'slow down', headers: { 'Retry-After': '0' } },
      { status: 503, body: 'unavailable' },
      { body: envelope([]) },
    ]);
    await expect(
      new BreezePartnerApiClient().testConnection(
        context({
          http: { timeoutMs: 25, maxRetries: 2, backoffMs: 0 },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(fx.calls).toHaveLength(3);
  });

  it.each([
    { frames: [{ status: 503, body: 'top-secret-key upstream details' }] },
    { frames: [{ status: 200, body: '{malformed json' }] },
    { frames: [{ error: new Error('network top-secret-key') }] },
  ] as Array<{ frames: Frame[] }>)(
    'sanitizes exhausted transport and response failures',
    async ({ frames }) => {
      installFetchScript(frames);
      const promise = new BreezePartnerApiClient().testConnection(context());
      await expect(promise).rejects.toThrow(/Breeze partner API/i);
      await expect(promise).rejects.not.toThrow(/top-secret-key/);
    },
  );
});
