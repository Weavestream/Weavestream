import { INTERNAL_TOKEN_HEADER } from '@weavestream/shared';
import { proxyToApi } from './api-proxy';
import { INBOUND_XFF_HEADER, WEB_TRUST_PROXY_HOPS_HEADER } from './client-ip';

// Integration coverage for proxyToApi itself (the deny happens on the
// final constructed upstream URL, before any fetch). A NextRequest is
// duck-typed to just the surface proxyToApi touches; the real Headers
// global gives us .entries()/.get() for free.
type ReqOpts = {
  method?: string;
  pathname?: string;
  search?: string;
  headers?: Record<string, string>;
};

function makeReq(opts: ReqOpts = {}): Parameters<typeof proxyToApi>[0] {
  const { method = 'GET', pathname = '/api/v1/x', search = '', headers = {} } = opts;
  return {
    method,
    body: undefined,
    headers: new Headers(headers),
    nextUrl: { pathname, search, host: 'app.example.com', protocol: 'http:' },
  } as unknown as Parameters<typeof proxyToApi>[0];
}

describe('proxyToApi — internal-only deny', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('{"rules":[]}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
  });

  afterEach(() => fetchSpy.mockRestore());

  it('returns 404 for /api/v1/ip-rules/active BEFORE calling fetch', async () => {
    const res = await proxyToApi(
      makeReq({ pathname: '/api/v1/ip-rules/active' }),
      '/api/v1/ip-rules/active',
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('denies the same target reached via /health/.. traversal', async () => {
    const res = await proxyToApi(
      makeReq({ pathname: '/health/../api/v1/ip-rules/active' }),
      '/health/../api/v1/ip-rules/active',
    );
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('404 body instance is the public path, never the api:4000 upstream URL', async () => {
    const res = await proxyToApi(
      makeReq({ pathname: '/api/v1/ip-rules/active', search: '?x=1' }),
      '/api/v1/ip-rules/active',
    );
    const body = (await res.json()) as { status: number; instance: string };
    expect(body.status).toBe(404);
    expect(body.instance).toBe('/api/v1/ip-rules/active?x=1');
    expect(body.instance).not.toContain('api:4000');
  });

  it('forwards an allowed path to the API (fetch called once)', async () => {
    const res = await proxyToApi(
      makeReq({ pathname: '/api/v1/assets' }),
      '/api/v1/assets',
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('strips a browser-supplied internal token before forwarding', async () => {
    await proxyToApi(
      makeReq({
        pathname: '/api/v1/assets',
        headers: { [INTERNAL_TOKEN_HEADER]: 'smuggled-value' },
      }),
      '/api/v1/assets',
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const outgoing = init.headers as Headers;
    expect(outgoing.get(INTERNAL_TOKEN_HEADER)).toBeNull();
  });
});

describe('proxyToApi — connection diagnostics headers', () => {
  const WHOAMI = '/api/v1/security/whoami';
  const savedHops = process.env.TRUST_PROXY_HOPS;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (savedHops === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = savedHops;
  });

  function forwardedHeaders(): Headers {
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    return init.headers as Headers;
  }

  it("sends whoami the web tier's own hop count, never the browser's", async () => {
    process.env.TRUST_PROXY_HOPS = '2';
    await proxyToApi(
      makeReq({
        pathname: WHOAMI,
        headers: {
          [WEB_TRUST_PROXY_HOPS_HEADER]: '9', // browser-supplied: must not win
          [INBOUND_XFF_HEADER]: '198.51.100.7, 172.18.0.4', // stashed by proxy.ts
        },
      }),
      WHOAMI,
    );
    const outgoing = forwardedHeaders();
    expect(outgoing.get(WEB_TRUST_PROXY_HOPS_HEADER)).toBe('2');
    expect(outgoing.get(INBOUND_XFF_HEADER)).toBe('198.51.100.7, 172.18.0.4');
  });

  it('reports the default of 1 when TRUST_PROXY_HOPS is unset', async () => {
    delete process.env.TRUST_PROXY_HOPS;
    await proxyToApi(makeReq({ pathname: WHOAMI }), WHOAMI);
    expect(forwardedHeaders().get(WEB_TRUST_PROXY_HOPS_HEADER)).toBe('1');
  });

  it('strips both display-only headers from every other endpoint', async () => {
    process.env.TRUST_PROXY_HOPS = '2';
    await proxyToApi(
      makeReq({
        pathname: '/api/v1/assets',
        headers: {
          [WEB_TRUST_PROXY_HOPS_HEADER]: '9',
          [INBOUND_XFF_HEADER]: '1.2.3.4',
        },
      }),
      '/api/v1/assets',
    );
    const outgoing = forwardedHeaders();
    expect(outgoing.get(WEB_TRUST_PROXY_HOPS_HEADER)).toBeNull();
    expect(outgoing.get(INBOUND_XFF_HEADER)).toBeNull();
  });
});
