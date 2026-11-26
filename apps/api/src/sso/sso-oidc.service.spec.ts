import type { EnvService } from '../config/env.service.js';
import {
  EgressBlockedError,
  resetEgressGuardForTests,
  setDefaultFetchForTests,
  setDefaultResolveForTests,
} from '../common/egress/safe-fetch.js';
import { fakeSsoConfig } from './sso-config.fake.js';
import { fetcherFor, SsoOidcService, SsoProviderError } from './sso-oidc.service.js';

const ISSUER = 'https://login.example.test/tenant-1/v2.0';
const META = {
  issuer: ISSUER,
  authorization_endpoint: 'https://login.example.test/tenant-1/oauth2/v2.0/authorize',
  token_endpoint: 'https://login.example.test/tenant-1/oauth2/v2.0/token',
  jwks_uri: 'https://login.example.test/tenant-1/discovery/v2.0/keys',
};

function makeService(overrides: Record<string, unknown> = {}) {
  const env = {
    values: {
      API_URL: 'https://wiki.example.test/api/',
      SSO_OIDC_ISSUER: ISSUER,
      SSO_OIDC_CLIENT_ID: 'client-abc',
      SSO_OIDC_CLIENT_SECRET: 'placeholder-secret',
      SSO_OIDC_SCOPES: 'openid profile email',
      ...overrides,
    },
  } as unknown as EnvService;
  return new SsoOidcService(fakeSsoConfig(env.values as Record<string, unknown>));
}

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

describe('SsoOidcService', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('is disabled without an issuer', async () => {
    expect(await makeService({ SSO_OIDC_ISSUER: undefined }).enabled()).toBe(false);
    expect(await makeService().enabled()).toBe(true);
  });

  it('builds the redirect URI from API_URL', () => {
    expect(makeService().redirectUri()).toBe('https://wiki.example.test/api/v1/auth/sso/callback');
  });

  describe('discovery', () => {
    it('fetches the well-known document once and caches it', async () => {
      fetchMock.mockResolvedValue(jsonResponse(META));
      const svc = makeService();
      await svc.metadata();
      await svc.metadata();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0]).toBe(`${ISSUER}/.well-known/openid-configuration`);
      expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: 'error' });
      expect(fetchMock.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
    });

    it('shares one request between concurrent callers', async () => {
      fetchMock.mockResolvedValue(jsonResponse(META));
      const svc = makeService();
      await Promise.all([svc.metadata(), svc.metadata(), svc.metadata()]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not cache a failure', async () => {
      fetchMock
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(jsonResponse(META));
      const svc = makeService();
      await expect(svc.metadata()).rejects.toMatchObject({ reason: 'discovery_failed' });
      await expect(svc.metadata()).resolves.toMatchObject({ issuer: ISSUER });
    });

    it('refuses a document that describes a different issuer', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ...META, issuer: 'https://evil.example.test/' }));
      await expect(makeService().metadata()).rejects.toBeInstanceOf(SsoProviderError);
    });

    it('refuses a non-2xx response and an incomplete document', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 500 }));
      await expect(makeService().metadata()).rejects.toMatchObject({ reason: 'discovery_failed' });
      fetchMock.mockResolvedValueOnce(jsonResponse({ issuer: ISSUER }));
      await expect(makeService().metadata()).rejects.toMatchObject({ reason: 'discovery_failed' });
    });

    it('refuses plain-http endpoints for a public issuer', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ ...META, token_endpoint: 'http://login.example.test/token' }),
      );
      await expect(makeService().metadata()).rejects.toMatchObject({ reason: 'discovery_failed' });
    });

    it('allows plain http only when issuer and endpoints are both loopback', async () => {
      const local = 'http://localhost:8080/realms/dev';
      fetchMock.mockResolvedValue(
        jsonResponse({
          issuer: local,
          authorization_endpoint: 'http://localhost:8080/realms/dev/auth',
          token_endpoint: 'http://localhost:8080/realms/dev/token',
          jwks_uri: 'http://localhost:8080/realms/dev/certs',
        }),
      );
      await expect(makeService({ SSO_OIDC_ISSUER: local }).metadata()).resolves.toBeDefined();
    });
  });

  describe('authorizationUrl', () => {
    const params = { state: 'st', nonce: 'no', challenge: 'ch' };

    it('sends the authorization-code + PKCE S256 request', async () => {
      fetchMock.mockResolvedValue(jsonResponse(META));
      const url = new URL(
        await makeService().authorizationUrl({ ...params, reauthenticate: false }),
      );
      expect(`${url.origin}${url.pathname}`).toBe(META.authorization_endpoint);
      const q = url.searchParams;
      expect(q.get('client_id')).toBe('client-abc');
      expect(q.get('response_type')).toBe('code');
      expect(q.get('redirect_uri')).toBe('https://wiki.example.test/api/v1/auth/sso/callback');
      expect(q.get('scope')).toBe('openid profile email');
      expect(q.get('state')).toBe('st');
      expect(q.get('nonce')).toBe('no');
      expect(q.get('code_challenge')).toBe('ch');
      expect(q.get('code_challenge_method')).toBe('S256');
      expect(q.has('prompt')).toBe(false);
      expect(q.has('max_age')).toBe(false);
      // The client secret and the PKCE verifier never travel in the URL.
      expect(url.toString()).not.toContain('placeholder-secret');
    });

    it('asks the provider to let the person pick the account for a self-service link', async () => {
      fetchMock.mockResolvedValue(jsonResponse(META));
      const q = new URL(
        await makeService().authorizationUrl({ ...params, reauthenticate: false, selectAccount: true }),
      ).searchParams;
      expect(q.get('prompt')).toBe('select_account');
      expect(q.has('max_age')).toBe(false);
    });

    it('forces re-authentication for step-up', async () => {
      fetchMock.mockResolvedValue(jsonResponse(META));
      const q = new URL(await makeService().authorizationUrl({ ...params, reauthenticate: true }))
        .searchParams;
      expect(q.get('prompt')).toBe('login');
      expect(q.get('max_age')).toBe('0');
    });
  });

  describe('exchangeCode', () => {
    beforeEach(() => {
      fetchMock.mockImplementation(async (input: unknown) =>
        String(input).endsWith('/.well-known/openid-configuration')
          ? jsonResponse(META)
          : jsonResponse({ id_token: 'the.id.token', access_token: 'ignored' }),
      );
    });

    it('posts the code and PKCE verifier with a timeout and returns only the id_token', async () => {
      const idToken = await makeService().exchangeCode('the-code', 'the-verifier');
      expect(idToken).toBe('the.id.token');

      const [url, init] = fetchMock.mock.calls[1]!;
      expect(url).toBe(META.token_endpoint);
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const form = init.body as URLSearchParams;
      expect(Object.fromEntries(form)).toEqual({
        grant_type: 'authorization_code',
        code: 'the-code',
        redirect_uri: 'https://wiki.example.test/api/v1/auth/sso/callback',
        client_id: 'client-abc',
        client_secret: 'placeholder-secret',
        code_verifier: 'the-verifier',
      });
    });

    it('fails on a non-2xx token response', async () => {
      fetchMock.mockImplementation(async (input: unknown) =>
        String(input).endsWith('/.well-known/openid-configuration')
          ? jsonResponse(META)
          : jsonResponse({ error: 'invalid_grant' }, { ok: false, status: 400 }),
      );
      await expect(makeService().exchangeCode('c', 'v')).rejects.toMatchObject({
        reason: 'token_exchange_failed',
      });
    });

    it('fails on a response without an id_token', async () => {
      fetchMock.mockImplementation(async (input: unknown) =>
        String(input).endsWith('/.well-known/openid-configuration')
          ? jsonResponse(META)
          : jsonResponse({ access_token: 'only' }),
      );
      await expect(makeService().exchangeCode('c', 'v')).rejects.toMatchObject({
        reason: 'token_exchange_failed',
      });
    });

    it('fails on a network error without leaking its message', async () => {
      fetchMock.mockImplementation(async (input: unknown) => {
        if (String(input).endsWith('/.well-known/openid-configuration')) return jsonResponse(META);
        throw new Error('connect ECONNREFUSED with client_secret=placeholder-secret');
      });
      const err = await makeService()
        .exchangeCode('c', 'v')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SsoProviderError);
      expect((err as Error).message).toBe('token_exchange_failed');
    });
  });
});

describe('fetcherFor (SSRF posture by config source)', () => {
  afterEach(() => resetEgressGuardForTests());

  it('env source: the global fetch, redirects refused (unchanged behaviour)', async () => {
    const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}));
    await fetcherFor('env')('https://idp.example.test/x', { method: 'GET' });
    expect(spy).toHaveBeenCalledWith('https://idp.example.test/x', expect.objectContaining({ redirect: 'error' }));
    spy.mockRestore();
  });

  it('database source: goes through the egress guard and refuses private addresses', async () => {
    const spy = jest.spyOn(globalThis, 'fetch');
    setDefaultResolveForTests(async () => ['169.254.169.254']);
    await expect(fetcherFor('database')('https://idp.example.test/x', { method: 'GET' })).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('database source: does not follow redirects', async () => {
    setDefaultResolveForTests(async () => ['93.184.216.34']);
    const impl = jest.fn(async () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } }));
    setDefaultFetchForTests(impl as never);
    const res = await fetcherFor('database')('https://idp.example.test/x', { method: 'GET' });
    expect(res.status).toBe(302);
    expect(impl).toHaveBeenCalledTimes(1);
  });
});

describe('SsoOidcService with a changing configuration', () => {
  it('does not serve one issuer\'s discovery document for another', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    const cfg = { v: { SSO_OIDC_ISSUER: ISSUER, SSO_OIDC_CLIENT_ID: 'c', SSO_OIDC_CLIENT_SECRET: 's' } as Record<string, unknown> };
    const svc = new SsoOidcService({
      get: async () => fakeSsoConfigValues(cfg.v),
      callbackUrl: () => 'https://wiki.example.test/api/v1/auth/sso/callback',
    } as never);
    fetchMock.mockResolvedValueOnce(jsonResponse(META));
    await svc.metadata();
    const other = 'https://login.example.test/tenant-2/v2.0';
    cfg.v = { ...cfg.v, SSO_OIDC_ISSUER: other };
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...META, issuer: other }));
    expect((await svc.metadata()).issuer).toBe(other);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRestore();
  });
});

async function fakeSsoConfigValues(v: Record<string, unknown>) {
  return fakeSsoConfig(v).get();
}
