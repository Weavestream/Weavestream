import { __resetRequestPaceForTests, awaitRequestSlot, fetchWithRetry } from './driver-utils.js';
import { DriverRateLimitError } from './integration-driver.js';
import { setDefaultFetchForTests, setDefaultResolveForTests } from '../../common/egress/safe-fetch.js';

describe('fetchWithRetry', () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];

  beforeEach(() => {
    calls.length = 0;
    setDefaultResolveForTests(async () => ['1.2.3.4']);
    setDefaultFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return url.startsWith('https://api.vendor.example/')
        ? new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/collect' } })
        : new Response('{}', { status: 200 });
    }) as typeof fetch);
  });

  afterEach(() => {
    setDefaultFetchForTests(null);
    setDefaultResolveForTests(null);
  });

  const opts = {
    method: 'GET' as const,
    headers: { Authorization: 'Bearer test-token' },
    timeoutMs: 1_000,
    maxRetries: 2,
    backoffMs: 1,
    correlationId: 'c-1',
    serviceName: 'Vendor',
  };

  it('never follows a redirect by default, so credentials stay with the original host', async () => {
    const res = await fetchWithRetry('https://api.vendor.example/v1/devices', opts);
    expect(res.status).toBe(302);
    expect(calls.map((call) => call.url)).toEqual(['https://api.vendor.example/v1/devices']);
  });

  it('follows only when a caller opts in', async () => {
    const res = await fetchWithRetry('https://api.vendor.example/v1/devices', { ...opts, redirect: 'follow' });
    expect(res.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual(['https://api.vendor.example/v1/devices', 'https://elsewhere.example/collect']);
  });
});

describe('request pace', () => {
  beforeEach(() => __resetRequestPaceForTests());
  afterEach(() => {
    setDefaultFetchForTests(null);
    setDefaultResolveForTests(null);
  });

  it('spaces callers that share a key, and only those', async () => {
    const pace = { key: 'vendor:a', minIntervalMs: 30 };
    const started = Date.now();
    const done: number[] = [];
    await Promise.all([0, 1, 2].map(async () => {
      await awaitRequestSlot(pace);
      done.push(Date.now() - started);
    }));
    done.sort((a, b) => a - b);
    expect(done[0]).toBeLessThan(25);
    expect(done[1]).toBeGreaterThanOrEqual(25);
    expect(done[2]).toBeGreaterThanOrEqual(55);

    const other = Date.now();
    await awaitRequestSlot({ key: 'vendor:b', minIntervalMs: 30 });
    expect(Date.now() - other).toBeLessThan(25);
  });

  it('holds every caller of the key for the Retry-After of a 429', async () => {
    let first = true;
    setDefaultResolveForTests(async () => ['1.2.3.4']);
    setDefaultFetchForTests((async () => {
      if (first) {
        first = false;
        return new Response('', { status: 429, headers: { 'Retry-After': '1' } });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch);
    const pace = { key: 'vendor:c', minIntervalMs: 1 };
    const opts = {
      method: 'GET' as const, timeoutMs: 1_000, maxRetries: 0, backoffMs: 1, correlationId: 'c', serviceName: 'Vendor', pace,
    };
    await expect(fetchWithRetry('https://api.vendor.example/a', opts)).rejects.toBeInstanceOf(DriverRateLimitError);
    const started = Date.now();
    const res = await fetchWithRetry('https://api.vendor.example/b', opts);
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
  });

  it('holds a caller that was already waiting when the 429 arrived', async () => {
    const sentAt: Array<[string, number]> = [];
    const started = Date.now();
    setDefaultResolveForTests(async () => ['1.2.3.4']);
    setDefaultFetchForTests((async (input: string | URL | Request) => {
      const url = String(input);
      sentAt.push([url, Date.now() - started]);
      return url.endsWith('/a')
        ? new Response('', { status: 429, headers: { 'Retry-After': '1' } })
        : new Response('{}', { status: 200 });
    }) as typeof fetch);
    const opts = {
      method: 'GET' as const, timeoutMs: 1_000, maxRetries: 0, backoffMs: 1, correlationId: 'c', serviceName: 'Vendor',
      pace: { key: 'vendor:d', minIntervalMs: 50 },
    };
    // B queues behind A (its slot is 50 ms out) before A's 429 comes back.
    const a = fetchWithRetry('https://api.vendor.example/a', opts).catch((e: unknown) => e);
    const b = fetchWithRetry('https://api.vendor.example/b', opts);
    expect(await a).toBeInstanceOf(DriverRateLimitError);
    expect((await b).status).toBe(200);
    const bSentAt = sentAt.find(([url]) => url.endsWith('/b'))![1];
    expect(bSentAt).toBeGreaterThanOrEqual(950);
  });
});
