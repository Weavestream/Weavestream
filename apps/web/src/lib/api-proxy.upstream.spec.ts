import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * proxyToApi against a real HTTP upstream, through Node's own fetch (undici),
 * so the Fetch spec's 401 handling is the real one, not a mock.
 */
describe('proxyToApi — relaying a 401 to a POST with a body', () => {
  let server: Server;
  const seen: { cookie?: string; authorization?: string; body: string }[] = [];
  let proxyToApi: typeof import('./api-proxy').proxyToApi;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ cookie: req.headers.cookie, authorization: req.headers.authorization, body });
        res.writeHead(401, {
          'content-type': 'application/problem+json',
          'www-authenticate': 'Bearer resource_metadata="https://ws.example/.well-known/oauth-protected-resource/mcp", scope="mcp"',
        });
        res.end('{"status":401}');
      });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    process.env.API_INTERNAL_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    jest.resetModules();
    ({ proxyToApi } = await import('./api-proxy'));
  });

  afterAll(() => {
    server.close();
    delete process.env.API_INTERNAL_URL;
  });

  it('passes the 401 and its challenge through instead of failing with a 500', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"tools/list"}'));
        c.close();
      },
    });
    const req = {
      method: 'POST',
      body,
      headers: new Headers({
        'content-type': 'application/json',
        cookie: 'ws_session=abc',
        authorization: 'Bearer ws_0123_secret',
      }),
      nextUrl: { pathname: '/mcp', search: '', host: 'ws.example', protocol: 'https:' },
    } as unknown as Parameters<typeof proxyToApi>[0];

    const res = await proxyToApi(req, '/api/v1/mcp');

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
    // The request reached the API whole: body, cookie and credential.
    expect(seen.at(-1)).toEqual({
      cookie: 'ws_session=abc',
      authorization: 'Bearer ws_0123_secret',
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
  });
});
