import { INTERNAL_TOKEN_HEADER } from '@weavestream/shared';

/**
 * `reportIpBlock` — the proxy-side half of web-observed IP denials.
 * Asserts the invariants the API side depends on: internal token
 * header, the blocked IP in the BODY (never in forwarding headers —
 * `IpRuleGuard` would 403 the report itself), per-(ip,cidr) cooldown,
 * and that every failure is swallowed.
 *
 * Module state (cooldown map, memoized token) is reset via
 * `jest.resetModules()` + dynamic import per test.
 */

type ReportModule = typeof import('./ip-block-report');

async function loadModule(cookieKey = 'unit-test-signing-key'): Promise<ReportModule> {
  jest.resetModules();
  process.env.COOKIE_SIGNING_KEY = cookieKey;
  return import('./ip-block-report');
}

function okResponse(): Response {
  return new Response(null, { status: 204 });
}

describe('reportIpBlock', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env.COOKIE_SIGNING_KEY;
  });

  it('POSTs the report with the internal token and the blocked IP in the body only', async () => {
    const mod = await loadModule();
    await mod.reportIpBlock({
      ip: '203.0.113.5',
      cidr: '203.0.113.0/24',
      priority: 3,
      path: '/login',
      userAgent: 'UA/1.0',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/ip-rules/blocked-report');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(typeof headers[INTERNAL_TOKEN_HEADER]).toBe('string');
    expect(headers[INTERNAL_TOKEN_HEADER]!.length).toBeGreaterThan(0);
    // The denied client's IP must never ride in forwarding headers —
    // IpRuleGuard evaluates them first and would 403 the report.
    const headerNames = Object.keys(headers).map((h) => h.toLowerCase());
    expect(headerNames).not.toContain('x-forwarded-for');
    expect(headerNames).not.toContain('x-real-ip');

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.ip).toBe('203.0.113.5');
    expect(body.cidr).toBe('203.0.113.0/24');
  });

  it('cools down per (ip, cidr): repeats are suppressed, distinct pairs are not', async () => {
    const mod = await loadModule();
    await mod.reportIpBlock({ ip: '1.2.3.4', cidr: '1.2.3.0/24' });
    await mod.reportIpBlock({ ip: '1.2.3.4', cidr: '1.2.3.0/24' });
    await mod.reportIpBlock({ ip: '1.2.3.4', cidr: '1.2.3.0/24' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await mod.reportIpBlock({ ip: '1.2.3.4', cidr: '0.0.0.0/0' });
    await mod.reportIpBlock({ ip: '5.6.7.8', cidr: '1.2.3.0/24' });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('swallows fetch failures and keeps reporting other subjects', async () => {
    const mod = await loadModule();
    fetchSpy.mockRejectedValueOnce(new Error('api unreachable'));
    await expect(
      mod.reportIpBlock({ ip: '1.1.1.1', cidr: '1.1.1.0/24' }),
    ).resolves.toBeUndefined();

    fetchSpy.mockResolvedValue(okResponse());
    await mod.reportIpBlock({ ip: '2.2.2.2', cidr: '2.2.2.0/24' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('swallows non-2xx responses', async () => {
    const mod = await loadModule();
    fetchSpy.mockResolvedValue(new Response(null, { status: 403 }));
    await expect(
      mod.reportIpBlock({ ip: '1.1.1.1', cidr: '1.1.1.0/24' }),
    ).resolves.toBeUndefined();
  });

  it('does nothing when COOKIE_SIGNING_KEY is not visible', async () => {
    const mod = await loadModule('');
    await mod.reportIpBlock({ ip: '1.2.3.4', cidr: '1.2.3.0/24' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('caps the cooldown map and evicts oldest-first', async () => {
    const mod = await loadModule();
    for (let i = 0; i < 1000; i++) {
      await mod.reportIpBlock({ ip: `10.0.${Math.floor(i / 250)}.${i % 250}`, cidr: `c-${i}` });
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1000);

    // 1001st distinct pair evicts the oldest entry…
    await mod.reportIpBlock({ ip: '10.9.9.9', cidr: 'c-new' });
    expect(fetchSpy).toHaveBeenCalledTimes(1001);
    // …so the first pair is reportable again (map stayed bounded).
    await mod.reportIpBlock({ ip: '10.0.0.0', cidr: 'c-0' });
    expect(fetchSpy).toHaveBeenCalledTimes(1002);
  });
});
