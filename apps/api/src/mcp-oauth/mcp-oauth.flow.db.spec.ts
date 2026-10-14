import { createHash, generateKeyPairSync, randomBytes, sign as signData } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { setDefaultFetchForTests, setDefaultResolveForTests } from '../common/egress/safe-fetch.js';
import { McpConnectionsService } from './mcp-connections.service.js';
import { OAuthProviderService } from './oauth-provider.service.js';
import { OAuthConsentService } from './oauth-consent.service.js';
import { OAuthProviderController } from './oauth-provider.controller.js';

/**
 * The remote MCP authorization server end to end, against Postgres: the real
 * provider, the real Prisma adapter, the consent service and the connection
 * service. Session, CSRF and step-up guards are not in this path (they have
 * their own specs); the consent routes here take the user from a test header.
 *
 * Opt-in via `WEAVESTREAM_RUN_DB_INTEGRATION_TESTS=1`, like every DB spec:
 * importing `@prisma/client` loads the workspace `.env`, so without the flag
 * a bare `pnpm test` would mutate the development database.
 */
const describeIfDb =
  process.env.WEAVESTREAM_RUN_DB_INTEGRATION_TESTS === '1' ? describe : describe.skip;

const ISSUER = 'https://ws.example.test';
const RESOURCE = `${ISSUER}/mcp`;
const CLAUDE = 'https://claude.ai/oauth/mcp-client-metadata';
const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback';
const GPT = 'https://chatgpt.com/oauth/client.json';
const GPT_CB = 'https://chatgpt.com/connector_platform_oauth_redirect';
const GPT_JWKS = 'https://chatgpt.com/oauth/jwks.json';

const USER_A = '3c100000-0000-4000-8000-00000000a001';
const USER_B = '3c100000-0000-4000-8000-00000000a002';

const actorOf = (id: string): AuthedUser => ({
  id,
  email: `${id}@mcp-oauth-spec.example`,
  role: 'OPERATOR',
  globalAccess: 'FULL',
  platformCapabilities: [],
  sessionId: `${id.slice(0, -4)}e001`,
  mfaEnforcementCompletedAt: new Date(),
  mfaPending: false,
});

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

describeIfDb('remote MCP OAuth flow (DB integration)', () => {
  const prisma = new PrismaService();
  const audit = { logWithClient: jest.fn().mockResolvedValue(undefined), log: jest.fn() };
  let enabled = true;
  const settings = { mcpRemoteEnabled: async () => enabled };
  const env = { values: { APP_URL: ISSUER, COOKIE_SIGNING_KEY: 'k'.repeat(48) } };
  const connections = new McpConnectionsService(prisma, audit as never);
  const oauth = new OAuthProviderService(env as never, prisma, settings as never, connections);
  const consent = new OAuthConsentService(oauth, connections, settings as never);
  const controller = new OAuthProviderController(oauth);
  let server: Server;
  let base = '';

  // ChatGPT authenticates with a signed client assertion (private_key_jwt).
  const gptKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const docs: Record<string, unknown> = {
    [CLAUDE]: {
      client_id: CLAUDE,
      client_name: 'Claude',
      redirect_uris: [CLAUDE_CB],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
    [GPT]: {
      client_id: GPT,
      client_name: 'ChatGPT',
      redirect_uris: [GPT_CB],
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_signing_alg: 'RS256',
      jwks_uri: GPT_JWKS,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
    [GPT_JWKS]: { keys: [{ ...gptKey.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] },
  };
  const fetched: string[] = [];

  /** Test routes: the provider controller, and the consent service as the user in `x-test-user`. */
  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://local');
    const r = req as IncomingMessage & { originalUrl: string; path: string };
    r.originalUrl = req.url ?? '/';
    r.path = url.pathname;
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    try {
      if (url.pathname.startsWith('/api/v1/oauth/')) {
        await controller.handle(r as never, res as never);
        return;
      }
      const m = url.pathname.match(/^\/api\/v1\/oauth-consent\/([\w-]+)\/(details|approve|deny)$/);
      if (!m) return json(404, {});
      const actor = actorOf(String(req.headers['x-test-user']));
      const meta = { ip: '203.0.113.5', userAgent: 'jest' };
      if (m[2] === 'details') return json(200, await consent.details(actor, m[1]!, req, res));
      if (m[2] === 'deny') return json(200, await consent.deny(m[1]!, req, res));
      const body = await new Promise<string>((ok) => {
        let s = '';
        req.on('data', (c) => (s += c));
        req.on('end', () => ok(s));
      });
      const allowWrite = (JSON.parse(body || '{}') as { allowWrite?: boolean }).allowWrite === true;
      return json(200, await consent.approve(actor, m[1]!, allowWrite, req, res, meta));
    } catch (err) {
      if (err instanceof HttpException) return json(err.getStatus(), { message: err.message });
      // Unexpected errors go to the test log, not the response, as in production.
      console.error(err);
      return json(500, { message: 'Internal server error' });
    }
  }

  /** A browser: path-scoped cookie jar, redirects not followed. */
  class Browser {
    cookies: { name: string; value: string; path: string }[] = [];
    async go(pathOrUrl: string, init: RequestInit = {}) {
      const u = new URL(pathOrUrl, ISSUER);
      const headers = new Headers(init.headers);
      const jar = this.cookies
        .filter((c) => u.pathname === c.path || u.pathname.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`))
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
      if (jar) headers.set('cookie', jar);
      const res = await fetch(`${base}${u.pathname}${u.search}`, { ...init, headers, redirect: 'manual' });
      for (const sc of res.headers.getSetCookie()) {
        const [nv, ...attrs] = sc.split(';').map((s) => s.trim());
        const i = nv!.indexOf('=');
        const path = attrs.find((a) => a.toLowerCase().startsWith('path='))?.slice(5) ?? '/';
        const name = nv!.slice(0, i);
        this.cookies = this.cookies.filter((c) => !(c.name === name && c.path === path));
        if (nv!.slice(i + 1)) this.cookies.push({ name, value: nv!.slice(i + 1), path });
      }
      return res;
    }
  }

  async function authorize(browser: Browser, clientId: string, redirectUri: string, extra: Record<string, string> = {}) {
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const state = b64url(randomBytes(8));
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      scope: 'mcp',
      resource: RESOURCE,
      ...extra,
    });
    const res = await browser.go(`/api/v1/oauth/auth?${q}`);
    const location = res.headers.get('location');
    const uid = location ? new URL(location, ISSUER).pathname.split('/').pop()! : '';
    return { res, location, uid, verifier, state, clientId, redirectUri };
  }

  async function approve(browser: Browser, flow: { uid: string }, user = USER_A, allowWrite = false) {
    const res = await browser.go(`/api/v1/oauth-consent/${flow.uid}/approve`, {
      method: 'POST',
      headers: { 'x-test-user': user, 'content-type': 'application/json' },
      body: JSON.stringify({ allowWrite }),
    });
    const body = (await res.json()) as { redirectTo?: string; message?: string };
    if (!body.redirectTo) return { status: res.status, body, callback: null as URL | null };
    const resumed = await browser.go(body.redirectTo);
    const location = resumed.headers.get('location');
    return { status: res.status, body, callback: location ? new URL(location) : null };
  }

  function clientAuth(clientId: string): Record<string, string> {
    if (clientId !== GPT) return { client_id: clientId };
    const header = b64url(JSON.stringify({ alg: 'RS256', kid: 'k1' }));
    const now = Math.floor(Date.now() / 1000);
    const claims = b64url(
      JSON.stringify({ iss: GPT, sub: GPT, aud: ISSUER, jti: b64url(randomBytes(16)), iat: now, exp: now + 60 }),
    );
    const sig = b64url(signData('sha256', Buffer.from(`${header}.${claims}`), gptKey.privateKey));
    return {
      client_id: clientId,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: `${header}.${claims}.${sig}`,
    };
  }

  async function token(clientId: string, params: Record<string, string>, auth = clientAuth(clientId)) {
    const res = await fetch(`${base}/api/v1/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...auth, ...params }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, string> };
  }

  const exchange = (flow: { clientId: string; verifier: string; redirectUri: string }, code: string) =>
    token(flow.clientId, {
      grant_type: 'authorization_code',
      code,
      code_verifier: flow.verifier,
      redirect_uri: flow.redirectUri,
      resource: RESOURCE,
    });
  const refresh = (clientId: string, refreshToken: string) =>
    token(clientId, { grant_type: 'refresh_token', refresh_token: refreshToken, resource: RESOURCE });

  /** What `/mcp` will check: a live token for this resource, on a live connection. */
  async function usable(accessToken: string): Promise<boolean> {
    const at = await oauth.provider.AccessToken.find(accessToken);
    if (!at || at.aud !== RESOURCE || !at.grantId) return false;
    return (await connections.findActiveByGrant(at.grantId)) !== null;
  }

  async function connect(user = USER_A, clientId = CLAUDE, redirectUri = CLAUDE_CB) {
    const browser = new Browser();
    const flow = await authorize(browser, clientId, redirectUri);
    const approved = await approve(browser, flow, user);
    const code = approved.callback?.searchParams.get('code');
    if (!code) throw new Error(`no code: ${JSON.stringify(approved.body)}`);
    const tokens = await exchange(flow, code);
    return { browser, flow, approved, code, tokens };
  }

  beforeAll(async () => {
    setDefaultResolveForTests(async () => ['93.184.216.34']);
    setDefaultFetchForTests((async (input: string | URL) => {
      const url = String(input);
      fetched.push(url);
      const doc = docs[url];
      return doc
        ? new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('not found', { status: 404 });
    }) as typeof fetch);
    await prisma.user.createMany({
      data: [USER_A, USER_B].map((id) => ({
        id,
        email: `${id}@mcp-oauth-spec.example`,
        name: 'MCP OAuth spec',
        mfaEnforcementCompletedAt: new Date(),
      })),
      skipDuplicates: true,
    });
    await oauth.onModuleInit();
    server = createServer((req, res) => void route(req, res));
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.close();
    setDefaultFetchForTests(null);
    setDefaultResolveForTests(null);
    const grants = await prisma.mcpConnection.findMany({
      where: { userId: { in: [USER_A, USER_B] } },
      select: { grantId: true },
    });
    await prisma.oAuthArtifact.deleteMany({ where: { grantId: { in: grants.map((g) => g.grantId) } } });
    for (const id of [USER_A, USER_B]) {
      await prisma.oAuthArtifact.deleteMany({ where: { kind: 'Session', payload: { path: ['accountId'], equals: id } } });
    }
    await prisma.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
    await prisma.$disconnect();
  });

  beforeEach(() => {
    enabled = true;
    jest.restoreAllMocks();
  });

  it('publishes OAuth metadata only, with the pinned issuer', async () => {
    const res = await fetch(`${base}/api/v1/oauth/.well-known/openid-configuration`, {
      headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' },
    });
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.issuer).toBe(ISSUER);
    expect(meta.token_endpoint).toBe(`${ISSUER}/api/v1/oauth/token`);
    expect(meta.scopes_supported).toEqual(['mcp']);
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
    expect(meta.client_id_metadata_document_supported).toBe(true);
    expect(meta.authorization_response_iss_parameter_supported).toBe(true);
    for (const key of ['registration_endpoint', 'userinfo_endpoint', 'jwks_uri', 'pushed_authorization_request_endpoint']) {
      expect(meta).not.toHaveProperty(key);
    }
    expect((await fetch(`${base}/api/v1/oauth/jwks`)).status).toBe(404);
  });

  it('connects Claude: read-only by default, code with iss, no ID token, tokens stored only by hash', async () => {
    const { approved, flow, tokens } = await connect();
    expect(approved.callback!.origin + approved.callback!.pathname).toBe(CLAUDE_CB);
    expect(approved.callback!.searchParams.get('state')).toBe(flow.state);
    expect(approved.callback!.searchParams.get('iss')).toBe(ISSUER);
    expect(tokens.status).toBe(200);
    expect(tokens.json.scope).toBe('mcp');
    expect(tokens.json).not.toHaveProperty('id_token');
    expect(await usable(tokens.json.access_token!)).toBe(true);

    const at = await oauth.provider.AccessToken.find(tokens.json.access_token!);
    const connection = await prisma.mcpConnection.findUnique({ where: { grantId: at!.grantId! } });
    expect(connection).toMatchObject({
      userId: USER_A,
      clientId: CLAUDE,
      clientName: 'Claude',
      redirectHost: 'claude.ai',
      allowWrite: false,
      revokedAt: null,
    });

    const rows = await prisma.oAuthArtifact.findMany({ where: { grantId: at!.grantId! } });
    const dump = JSON.stringify(rows);
    for (const value of [tokens.json.access_token!, tokens.json.refresh_token!]) {
      expect(dump).not.toContain(value);
    }
  });

  it('connects ChatGPT with a signed client assertion', async () => {
    const { tokens } = await connect(USER_A, GPT, GPT_CB);
    expect(tokens.status).toBe(200);
    expect(await usable(tokens.json.access_token!)).toBe(true);
    expect(fetched).toEqual(expect.arrayContaining([GPT, GPT_JWKS]));
  });

  it('a second Weavestream user in the same browser gets their own connection', async () => {
    const browser = new Browser();
    const first = await authorize(browser, CLAUDE, CLAUDE_CB);
    expect((await approve(browser, first, USER_A)).callback?.searchParams.get('code')).toBeTruthy();

    // The provider now remembers A in this browser; B signs in to Weavestream
    // and connects. No provider logout form, no visit to its logout routes.
    const second = await authorize(browser, CLAUDE, CLAUDE_CB);
    const approved = await approve(browser, second, USER_B);
    expect(approved.callback?.origin).toBe('https://claude.ai');
    expect(approved.callback?.pathname).toBe('/api/mcp/auth_callback');
    const tokens = await exchange(second, approved.callback!.searchParams.get('code')!);
    expect(tokens.status).toBe(200);
    expect(await usable(tokens.json.access_token!)).toBe(true);

    const at = await oauth.provider.AccessToken.find(tokens.json.access_token!);
    expect(at!.accountId).toBe(USER_B);
    const connection = await prisma.mcpConnection.findUniqueOrThrow({ where: { grantId: at!.grantId! } });
    expect(connection.userId).toBe(USER_B);
  });

  describe('overlapping authorizations in one browser', () => {
    /** Approve a pending request as `user` and prove the result is that user's live connection. */
    async function finish(browser: Browser, flow: Awaited<ReturnType<typeof authorize>>, user: string) {
      const approved = await approve(browser, flow, user);
      // A callback to the client, never the provider's logout form.
      expect(approved.callback?.origin).toBe('https://claude.ai');
      expect(approved.callback?.pathname).toBe('/api/mcp/auth_callback');
      const tokens = await exchange(flow, approved.callback!.searchParams.get('code')!);
      expect(tokens.status).toBe(200);
      expect(await usable(tokens.json.access_token!)).toBe(true);
      const at = await oauth.provider.AccessToken.find(tokens.json.access_token!);
      expect(at!.accountId).toBe(user);
      const connection = await prisma.mcpConnection.findUniqueOrThrow({ where: { grantId: at!.grantId! } });
      expect(connection.userId).toBe(user);
    }

    it('two requests opened before either finishes: A approves one, then B the other', async () => {
      const browser = new Browser();
      const first = await authorize(browser, CLAUDE, CLAUDE_CB);
      const second = await authorize(browser, CLAUDE, CLAUDE_CB);
      await finish(browser, first, USER_A);
      // The browser now carries A's provider session; the second request's
      // snapshot is from before that and names no one.
      await finish(browser, second, USER_B);
    });

    it('requests opened while B was remembered: A approves one, then B the other', async () => {
      const browser = new Browser();
      await finish(browser, await authorize(browser, CLAUDE, CLAUDE_CB), USER_B);
      // Both snapshots name B's session.
      const first = await authorize(browser, CLAUDE, CLAUDE_CB);
      const second = await authorize(browser, CLAUDE, CLAUDE_CB);
      await finish(browser, first, USER_A);
      // B's snapshot points at a session that no longer exists.
      await finish(browser, second, USER_B);
    });

    it('the same user in two tabs keeps both requests working', async () => {
      const browser = new Browser();
      await finish(browser, await authorize(browser, CLAUDE, CLAUDE_CB), USER_A);
      const first = await authorize(browser, CLAUDE, CLAUDE_CB);
      const second = await authorize(browser, CLAUDE, CLAUDE_CB);
      await finish(browser, first, USER_A);
      await finish(browser, second, USER_A);
    });
  });

  it('one ChatGPT client assertion sent twice at once authenticates only one exchange', async () => {
    // Two separate, otherwise valid codes, so code replay protection cannot
    // be what refuses the second exchange.
    const flows = [];
    for (const _ of [1, 2]) {
      const browser = new Browser();
      const flow = await authorize(browser, GPT, GPT_CB);
      const code = (await approve(browser, flow)).callback!.searchParams.get('code')!;
      flows.push({ flow, code });
    }
    const assertion = clientAuth(GPT);
    // Hold both requests between the library's "is this assertion new?"
    // read and its save, so each one reads before either one writes.
    const replay = oauth.provider.ReplayDetection;
    const find = replay.find.bind(replay);
    jest.spyOn(replay, 'find').mockImplementation(async (...args: Parameters<typeof find>) => {
      const found = await find(...args);
      await new Promise((ok) => setTimeout(ok, 100));
      return found;
    });
    const results = await Promise.all(
      flows.map(({ flow, code }) =>
        token(
          GPT,
          {
            grant_type: 'authorization_code',
            code,
            code_verifier: flow.verifier,
            redirect_uri: flow.redirectUri,
            resource: RESOURCE,
          },
          assertion,
        ),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(results.find((r) => r.status === 401)!.json.error).toBe('invalid_client');
    jest.restoreAllMocks();

    // And used again later, it is still refused.
    const browser = new Browser();
    const flow = await authorize(browser, GPT, GPT_CB);
    const code = (await approve(browser, flow)).callback!.searchParams.get('code')!;
    const later = await token(
      GPT,
      { grant_type: 'authorization_code', code, code_verifier: flow.verifier, redirect_uri: flow.redirectUri, resource: RESOURCE },
      assertion,
    );
    expect(later).toMatchObject({ status: 401, json: { error: 'invalid_client' } });
  });

  it('refuses a client_id off the allowlist without fetching it', async () => {
    const flow = await authorize(new Browser(), 'https://evil.example/client.json', 'https://evil.example/cb');
    expect(flow.res.status).toBe(400);
    expect(fetched.some((u) => new URL(u).hostname === 'evil.example')).toBe(false);
  });

  it('refuses a consent from another browser (session swap)', async () => {
    const attacker = new Browser();
    const flow = await authorize(attacker, CLAUDE, CLAUDE_CB);
    const victim = new Browser();
    const before = await prisma.mcpConnection.count({ where: { userId: USER_B } });
    const res = await victim.go(`/api/v1/oauth-consent/${flow.uid}/approve`, {
      method: 'POST',
      headers: { 'x-test-user': USER_B, 'content-type': 'application/json' },
      body: '{"allowWrite":true}',
    });
    expect(res.status).toBe(400);
    expect(await prisma.mcpConnection.count({ where: { userId: USER_B } })).toBe(before);
  });

  it('deny returns access_denied with iss and creates nothing', async () => {
    const browser = new Browser();
    const flow = await authorize(browser, CLAUDE, CLAUDE_CB);
    const before = await prisma.mcpConnection.count();
    const res = await browser.go(`/api/v1/oauth-consent/${flow.uid}/deny`, {
      method: 'POST',
      headers: { 'x-test-user': USER_A },
    });
    const { redirectTo } = (await res.json()) as { redirectTo: string };
    const back = new URL((await browser.go(redirectTo)).headers.get('location')!);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('iss')).toBe(ISSUER);
    expect(await prisma.mcpConnection.count()).toBe(before);
  });

  it('a replayed code revokes the connection', async () => {
    const { flow, code, tokens } = await connect();
    const again = await exchange(flow, code);
    expect(again).toMatchObject({ status: 400, json: { error: 'invalid_grant' } });
    expect(await usable(tokens.json.access_token!)).toBe(false);
  });

  it('refresh rotates; a replayed refresh token revokes the connection', async () => {
    const { tokens } = await connect();
    const r1 = await refresh(CLAUDE, tokens.json.refresh_token!);
    expect(r1.status).toBe(200);
    expect(r1.json.refresh_token).not.toBe(tokens.json.refresh_token);

    const replay = await refresh(CLAUDE, tokens.json.refresh_token!);
    expect(replay).toMatchObject({ status: 400, json: { error: 'invalid_grant' } });
    expect((await refresh(CLAUDE, r1.json.refresh_token!)).status).toBe(400);
    expect(await usable(r1.json.access_token!)).toBe(false);
    // The event handler records the revocation asynchronously.
    await new Promise((ok) => setTimeout(ok, 200));
    expect(audit.logWithClient).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'auth.mcp_connection.revoke',
        after: expect.objectContaining({ reason: 'token_reuse', targetUserId: USER_A }),
      }),
    );
  });

  it.each(['code', 'refresh'] as const)(
    'two simultaneous %s exchanges: at most one succeeds and nothing is usable afterwards',
    async (kind) => {
      let results: Awaited<ReturnType<typeof token>>[];
      if (kind === 'code') {
        const browser = new Browser();
        const flow = await authorize(browser, CLAUDE, CLAUDE_CB);
        const code = (await approve(browser, flow)).callback!.searchParams.get('code')!;
        results = await Promise.all([exchange(flow, code), exchange(flow, code)]);
      } else {
        const { tokens } = await connect();
        results = await Promise.all([
          refresh(CLAUDE, tokens.json.refresh_token!),
          refresh(CLAUDE, tokens.json.refresh_token!),
        ]);
      }
      const issued = results.filter((r) => r.status === 200);
      expect(issued.length).toBeLessThanOrEqual(1);
      // Both failing is also correct: the loser revokes the grant and can
      // stop the winner before it issues tokens.
      for (const r of issued) {
        expect(await usable(r.json.access_token!)).toBe(false);
        expect((await refresh(CLAUDE, r.json.refresh_token!)).status).toBe(400);
      }
    },
  );

  it('tokens outlive the 10-minute provider browser session', async () => {
    const { tokens } = await connect();
    const real = Date.now.bind(Date);
    jest.spyOn(Date, 'now').mockImplementation(() => real() + 11 * 60_000);
    expect(await usable(tokens.json.access_token!)).toBe(true);
    expect((await refresh(CLAUDE, tokens.json.refresh_token!)).status).toBe(200);
  });

  it('revoking the connection stops refresh and the access token', async () => {
    const { tokens } = await connect();
    const at = await oauth.provider.AccessToken.find(tokens.json.access_token!);
    const connection = await prisma.mcpConnection.findUniqueOrThrow({ where: { grantId: at!.grantId! } });

    // Another user cannot revoke it (IDOR): 404, still live.
    await expect(
      connections.revokeOwn(actorOf(USER_B), connection.id, { ip: '203.0.113.5', userAgent: 'jest' }),
    ).rejects.toThrow('Connection not found');
    expect(await usable(tokens.json.access_token!)).toBe(true);

    await connections.revokeOwn(actorOf(USER_A), connection.id, { ip: '203.0.113.5', userAgent: 'jest' });
    expect(await usable(tokens.json.access_token!)).toBe(false);
    expect((await refresh(CLAUDE, tokens.json.refresh_token!)).status).toBe(400);
    expect(await prisma.oAuthArtifact.count({ where: { grantId: connection.grantId } })).toBe(0);
  });

  it('a deactivated user, or the switch turned off, gets no new token', async () => {
    const first = await connect();
    enabled = false;
    expect((await refresh(CLAUDE, first.tokens.json.refresh_token!)).status).toBe(400);
    enabled = true;
    // The switch suspends, it does not revoke: back on, the same refresh
    // token and the connection work again.
    const resumed = await refresh(CLAUDE, first.tokens.json.refresh_token!);
    expect(resumed.status).toBe(200);
    expect(await usable(resumed.json.access_token!)).toBe(true);

    const second = await connect();
    await prisma.user.update({ where: { id: USER_A }, data: { isActive: false } });
    try {
      expect((await refresh(CLAUDE, second.tokens.json.refresh_token!)).status).toBe(400);
    } finally {
      await prisma.user.update({ where: { id: USER_A }, data: { isActive: true } });
    }
  });
});
