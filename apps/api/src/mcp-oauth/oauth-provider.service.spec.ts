import type { Provider } from 'oidc-provider';
import { setDefaultFetchForTests, setDefaultResolveForTests } from '../common/egress/safe-fetch.js';
import { CLIENT_FETCH_USER_AGENT, guardedFetch, OAuthProviderService, withoutCookies } from './oauth-provider.service.js';

describe('withoutCookies', () => {
  const names = new Set(['ws_oauth_session', 'ws_oauth_session.sig']);

  it('drops the provider session cookie and its signature, keeps every other cookie', () => {
    expect(
      withoutCookies(
        'ws_session=abc; ws_oauth_session=s1; ws_oauth_session.sig=x; ws_oauth_interaction=i1; ws_csrf=t',
        names,
      ),
    ).toBe('ws_session=abc; ws_oauth_interaction=i1; ws_csrf=t');
  });

  it('matches names exactly, never by prefix', () => {
    expect(withoutCookies('ws_oauth_session_other=1; xws_oauth_session=2', names)).toBe(
      'ws_oauth_session_other=1; xws_oauth_session=2',
    );
  });

  it('leaves no header when nothing else remains, and passes a missing header through', () => {
    expect(withoutCookies('ws_oauth_session=s1', names)).toBeUndefined();
    expect(withoutCookies(undefined, names)).toBeUndefined();
  });
});

describe('guardedFetch', () => {
  let sent: Headers | undefined;

  beforeEach(() => {
    sent = undefined;
    setDefaultResolveForTests(async () => ['1.2.3.4']);
    setDefaultFetchForTests((async (_input: string | URL | Request, init?: RequestInit) => {
      sent = new Headers(init?.headers);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch);
  });

  afterEach(() => {
    setDefaultFetchForTests(null);
    setDefaultResolveForTests(null);
  });

  it("replaces the library's empty User-Agent with the fixed Weavestream one, keeps other headers", async () => {
    const headers = new Headers({ accept: 'application/json', 'user-agent': '' });
    const res = await guardedFetch('any', 'https://app.example.com/oauth/mcp-client.json', {
      method: 'GET',
      headers,
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(sent?.get('user-agent')).toBe(CLIENT_FETCH_USER_AGENT);
    expect(sent?.get('accept')).toBe('application/json');
  });

  it('sends the User-Agent when the library passes no headers', async () => {
    await (await guardedFetch('claude_chatgpt', 'https://chatgpt.com/oauth/jwks.json')).text();
    expect(sent?.get('user-agent')).toBe(CLIENT_FETCH_USER_AGENT);
  });

  it('still refuses a host the policy does not allow, before any request', async () => {
    await expect(guardedFetch('claude_chatgpt', 'https://app.example.com/oauth/mcp-client.json')).rejects.toThrow(
      /not an allowed client host/,
    );
    expect(sent).toBeUndefined();
  });
});

describe('loopback redirects on the provider', () => {
  // No database: building a client touches only the library's schema.
  const oauth = new OAuthProviderService(
    { values: { APP_URL: 'https://ws.example.test', COOKIE_SIGNING_KEY: 'k'.repeat(48) } } as never,
    {} as never,
    { mcpRemoteEnabled: async () => true, mcpClientPolicy: async () => 'any' } as never,
    {} as never,
  );
  beforeAll(() => oauth.onModuleInit());
  // The library's types leave out the constructor's metadata argument.
  const buildClient = (metadata: Record<string, unknown>) =>
    new (oauth.provider.Client as unknown as new (m: Record<string, unknown>) => InstanceType<Provider['Client']>)(
      metadata,
    );

  // Claude Code's client metadata document, as published (issue #126).
  const claudeCode = {
    client_id: 'https://claude.ai/oauth/claude-code-client-metadata',
    client_name: 'Claude Code',
    redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };

  it('accepts any port on a loopback redirect of a metadata document that names no type', () => {
    const client = buildClient(claudeCode);
    expect(client.applicationType).toBe('native');
    expect(client.redirectUriAllowed('http://localhost:50357/callback')).toBe(true);
    expect(client.redirectUriAllowed('http://127.0.0.1:8765/callback')).toBe(true);
    expect(client.redirectUriAllowed('http://localhost:50357/other')).toBe(false);
    expect(client.redirectUriAllowed('http://evil.example:50357/callback')).toBe(false);
  });

  it('keeps exact matching for an https-only client', () => {
    const client = buildClient({
      ...claudeCode,
      client_id: 'https://claude.ai/oauth/mcp-client-metadata',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    });
    expect(client.applicationType).toBe('web');
    expect(client.redirectUriAllowed('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(client.redirectUriAllowed('https://claude.ai:8443/api/mcp/auth_callback')).toBe(false);
  });

  it('never keeps the trigger property a client sends', () => {
    const client = buildClient({ ...claudeCode, weavestream_loopback_rule: 'x' });
    expect(client.metadata()).not.toHaveProperty('weavestream_loopback_rule');
  });
});
