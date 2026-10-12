import type { DriverOAuthDescriptor } from '@weavestream/shared';
import { DriverAuthError, type IntegrationContext } from '../drivers/integration-driver.js';
import {
  setDefaultFetchForTests,
  setDefaultResolveForTests,
} from '../../common/egress/safe-fetch.js';
import {
  OAuthTokenError,
  __resetOAuthAccessTokenCacheForTests,
  connectedAsFromIdToken,
  exchangeAuthorizationCode,
  getOAuthAccessToken,
  oauthFetch,
  parseStoredOAuthSecret,
  revokeOAuthToken,
} from './oauth-token.js';

const OAUTH: DriverOAuthDescriptor = {
  provider: 'google',
  authorizeUrl: 'https://auth.example.test/authorize',
  tokenUrl: 'https://auth.example.test/token',
  revokeUrl: 'https://auth.example.test/revoke',
  scopes: ['scope.read'],
};
const HTTP = { timeoutMs: 5_000, maxRetries: 2, backoffMs: 1 };

interface Call {
  url: string;
  method: string;
  body?: string;
  headers?: Record<string, string>;
}

function script(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  setDefaultFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
      headers: init?.headers as Record<string, string> | undefined,
    });
    const next = responses[i++];
    if (!next) throw new Error(`unscripted fetch to ${String(input)}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch);
  setDefaultResolveForTests(async () => ['1.2.3.4']);
  return calls;
}

function ctx(overrides: Partial<IntegrationContext> = {}): IntegrationContext {
  return {
    integrationId: 'int-1',
    config: {},
    secret: {
      refreshToken: 'test-refresh-1',
      grantedScopes: ['scope.read'],
      connectedAt: '2026-01-01T00:00:00.000Z',
    },
    oauthClient: { clientId: 'client-1', clientSecret: 'test-client-secret' },
    credentialVersion: 'secret-1@2026-01-01T00:00:00.000Z|app-1@2026-01-01T00:00:00.000Z',
    http: HTTP,
    correlationId: 'corr',
    ...overrides,
  };
}

beforeEach(() => {
  __resetOAuthAccessTokenCacheForTests();
});
afterEach(() => {
  setDefaultFetchForTests(null);
  setDefaultResolveForTests(null);
  jest.useRealTimers();
});

describe('getOAuthAccessToken', () => {
  it('refreshes once, then serves the cached token', async () => {
    const calls = script([{ body: { access_token: 'access-1', expires_in: 3600 } }]);
    await expect(getOAuthAccessToken(ctx(), OAUTH)).resolves.toBe('access-1');
    await expect(getOAuthAccessToken(ctx(), OAUTH)).resolves.toBe('access-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(OAUTH.tokenUrl);
    expect(calls[0]!.method).toBe('POST');
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('test-refresh-1');
    expect(form.get('client_id')).toBe('client-1');
  });

  it('refreshes again once the cached token is near expiry', async () => {
    jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z'), doNotFake: ['setTimeout'] });
    const calls = script([
      { body: { access_token: 'access-1', expires_in: 120 } },
      { body: { access_token: 'access-2', expires_in: 120 } },
    ]);
    await getOAuthAccessToken(ctx(), OAUTH);
    jest.setSystemTime(new Date('2026-01-01T00:01:01Z'));
    await expect(getOAuthAccessToken(ctx(), OAUTH)).resolves.toBe('access-2');
    expect(calls).toHaveLength(2);
  });

  // The cache keys on non-secret row markers, so a changed marker must miss
  // even when the refresh token and client are byte-for-byte the same.
  it.each([
    ['the stored grant is replaced (reconnect)', 'secret-2@2026-02-01T00:00:00.000Z|app-1@2026-01-01T00:00:00.000Z'],
    ['the instance OAuth app is saved again', 'secret-1@2026-01-01T00:00:00.000Z|app-1@2026-02-01T00:00:00.000Z'],
  ])('misses the cache when %s', async (_label, credentialVersion) => {
    const calls = script([
      { body: { access_token: 'access-1', expires_in: 3600 } },
      { body: { access_token: 'access-2', expires_in: 3600 } },
    ]);
    await getOAuthAccessToken(ctx(), OAUTH);
    await expect(getOAuthAccessToken(ctx({ credentialVersion }), OAUTH)).resolves.toBe('access-2');
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['an integration id', { integrationId: undefined }],
    ['a credential version', { credentialVersion: undefined }],
  ])('does not cache without %s', async (_label, overrides) => {
    const calls = script([
      { body: { access_token: 'access-1', expires_in: 3600 } },
      { body: { access_token: 'access-2', expires_in: 3600 } },
    ]);
    await getOAuthAccessToken(ctx(overrides), OAUTH);
    await expect(getOAuthAccessToken(ctx(overrides), OAUTH)).resolves.toBe('access-2');
    expect(calls).toHaveLength(2);
  });

  it('maps invalid_grant to DriverAuthError (Reconnect)', async () => {
    script([{ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been revoked.' } }]);
    const err = await getOAuthAccessToken(ctx(), OAUTH).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverAuthError);
    expect((err as Error).message).toMatch(/Reconnect/);
    // Provider description text never reaches the error.
    expect((err as Error).message).not.toMatch(/revoked\./);
  });

  it('maps invalid_client to DriverAuthError pointing at the App tab', async () => {
    script([{ status: 401, body: { error: 'invalid_client' } }]);
    await expect(getOAuthAccessToken(ctx(), OAUTH)).rejects.toThrow(/App tab/);
  });

  it('surfaces other token failures as OAuthTokenError without provider text', async () => {
    script([{ status: 400, body: { error: 'invalid_request', error_description: 'secret detail' } }]);
    const err = await getOAuthAccessToken(ctx(), OAUTH).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthTokenError);
    expect((err as Error).message).not.toMatch(/secret detail/);
  });

  it('requires the instance OAuth app and a stored grant', async () => {
    await expect(getOAuthAccessToken(ctx({ oauthClient: undefined }), OAUTH)).rejects.toBeInstanceOf(
      DriverAuthError,
    );
    await expect(getOAuthAccessToken(ctx({ secret: {} }), OAUTH)).rejects.toBeInstanceOf(
      DriverAuthError,
    );
  });
});

describe('oauthFetch', () => {
  it('refreshes the token once and retries after a 401', async () => {
    const calls = script([
      { body: { access_token: 'access-1', expires_in: 3600 } },
      { status: 401, body: {} },
      { body: { access_token: 'access-2', expires_in: 3600 } },
      { body: { ok: true } },
    ]);
    const res = await oauthFetch(ctx(), OAUTH, 'https://api.example.test/v1/things', {
      method: 'GET',
      serviceName: 'test',
    });
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.headers?.Authorization)).toEqual([
      undefined,
      'Bearer access-1',
      undefined,
      'Bearer access-2',
    ]);
  });
});

describe('exchangeAuthorizationCode', () => {
  it('posts the PKCE verifier and never retries', async () => {
    const calls = script([{ status: 503, body: {} }]);
    await expect(
      exchangeAuthorizationCode(
        OAUTH,
        { clientId: 'client-1', clientSecret: 'test-client-secret' },
        { code: 'code-1', codeVerifier: 'v'.repeat(43), redirectUri: 'https://app.example.test/cb' },
        HTTP,
        'corr',
      ),
    ).rejects.toBeInstanceOf(OAuthTokenError);
    expect(calls).toHaveLength(1);
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code_verifier')).toBe('v'.repeat(43));
    expect(form.get('redirect_uri')).toBe('https://app.example.test/cb');
  });
});

describe('revokeOAuthToken', () => {
  it('posts the token to the revoke endpoint', async () => {
    const calls = script([{ body: {} }]);
    await expect(revokeOAuthToken(OAUTH, 'test-refresh-1', HTTP, 'corr')).resolves.toBe(true);
    expect(calls[0]!.url).toBe(OAUTH.revokeUrl);
  });

  it('is a no-op without a revoke endpoint', async () => {
    await expect(
      revokeOAuthToken({ ...OAUTH, revokeUrl: undefined }, 't', HTTP, 'corr'),
    ).resolves.toBe(false);
  });
});

describe('helpers', () => {
  it('reads the email claim from an ID token', () => {
    const payload = Buffer.from(JSON.stringify({ email: 'admin@example.test' })).toString('base64url');
    expect(connectedAsFromIdToken(`e30.${payload}.sig`)).toBe('admin@example.test');
    expect(connectedAsFromIdToken('not-a-jwt')).toBeUndefined();
    expect(connectedAsFromIdToken(undefined)).toBeUndefined();
  });

  it('parses only well-formed stored secrets', () => {
    expect(parseStoredOAuthSecret({ apiKey: 'x' })).toBeNull();
    expect(
      parseStoredOAuthSecret({ refreshToken: 'r', grantedScopes: [], connectedAt: 'now' }),
    ).toEqual({ refreshToken: 'r', grantedScopes: [], connectedAt: 'now' });
  });
});
