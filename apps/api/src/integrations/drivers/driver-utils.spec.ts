import { fetchWithRetry } from './driver-utils.js';
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
