import { setDefaultFetchForTests, setDefaultResolveForTests } from '../common/egress/safe-fetch.js';
import { CLIENT_FETCH_USER_AGENT, guardedFetch, withoutCookies } from './oauth-provider.service.js';

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
