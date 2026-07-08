import { INTERNAL_TOKEN_HEADER } from '@weavestream/shared';
import { proxyToApi } from './api-proxy';

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
