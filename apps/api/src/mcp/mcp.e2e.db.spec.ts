import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AppModule } from '../app.module.js';
import { AuditLogService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { EnvService } from '../config/env.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { setDefaultFetchForTests, setDefaultResolveForTests } from '../common/egress/safe-fetch.js';
import { startInternalListener } from '../common/internal-listener.js';
import { McpConnectionsService } from '../mcp-oauth/mcp-connections.service.js';
import { OAuthConsentService } from '../mcp-oauth/oauth-consent.service.js';
import { OAuthProviderService } from '../mcp-oauth/oauth-provider.service.js';
import { McpDelegationService } from './mcp-delegation.service.js';
import { MCP_INTERNAL_ORIGIN } from './internal-tool-api.js';

/**
 * The remote MCP endpoint end to end, in the real `AppModule`: every global
 * guard, interceptor and filter, the internal listener, Postgres and Redis.
 * Tokens come from the real OAuth flow; only the consent step is called on
 * the service directly (its session, CSRF and step-up guards have their own
 * specs). The SDK client talks to `/api/v1/mcp` like Claude or ChatGPT would.
 *
 * Audit rows go to an in-memory sink through the real `AuditLogService` code
 * (so tenant-context stamping is exercised): `audit_log` is append-only, and
 * real rows would also make the test users undeletable.
 *
 * Opt-in via `WEAVESTREAM_RUN_DB_INTEGRATION_TESTS=1`, like every DB spec.
 */
const describeIfDb =
  process.env.WEAVESTREAM_RUN_DB_INTEGRATION_TESTS === '1' ? describe : describe.skip;

const CLAUDE = 'https://claude.ai/oauth/mcp-client-metadata';
const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback';

const ID = (n: string) => `4d100000-0000-4000-8000-${n.padStart(12, '0')}`;
const CO_X = ID('c1');
const CO_Y = ID('c2');
const USER_A = ID('a1'); // FULL on X
const USER_B = ID('a2'); // FULL on Y
const USER_C = ID('a3'); // CLIENT_USER of X

const ALL_TOOLS = [
  'whoami', 'list_companies', 'search', 'list_layouts', 'get_layout', 'list_assets', 'get_asset',
  'create_asset', 'update_asset', 'list_domains', 'get_domain', 'list_passwords', 'get_password',
  'list_articles', 'get_article', 'create_article', 'update_article',
];
const WRITE_TOOLS = ['create_asset', 'update_asset', 'create_article', 'update_article'];

type AuditRow = Record<string, unknown>;

/** Real `AuditLogService` code, writing into memory instead of `audit_log`. */
class RecordingAuditLogService extends AuditLogService {
  readonly rows: AuditRow[] = [];
  private readonly sink = {
    auditLog: {
      create: async ({ data }: { data: AuditRow }) => {
        this.rows.push(data);
        return { id: ID(String(this.rows.length + 9000)), createdAt: new Date(), ...data };
      },
      createMany: async ({ data }: { data: AuditRow[] }) => {
        this.rows.push(...data);
        return { count: data.length };
      },
    },
  };
  constructor() {
    super(undefined as never);
    (this as unknown as { prisma: unknown }).prisma = this.sink;
  }
  override logWithClient(_tx: unknown, entry: Parameters<AuditLogService['logWithClient']>[1]) {
    return super.logWithClient(this.sink as never, entry);
  }
  override logManyWithClient(_tx: unknown, entries: Parameters<AuditLogService['logManyWithClient']>[1]) {
    return super.logManyWithClient(this.sink as never, entries);
  }
}

const b64url = (b: Buffer) => b.toString('base64url');

describeIfDb('remote MCP endpoint (DB integration, full app)', () => {
  let app: NestExpressApplication;
  let internal: Server;
  let consentServer: Server;
  let base = '';
  let consentBase = '';
  let prisma: PrismaService;
  let oauth: OAuthProviderService;
  let consent: OAuthConsentService;
  let connections: McpConnectionsService;
  let delegations: McpDelegationService;
  const audit = new RecordingAuditLogService();

  const actorOf = (id: string): AuthedUser => ({
    id,
    email: `${id}@mcp-e2e-spec.example`,
    role: id === USER_C ? 'CLIENT_USER' : 'OPERATOR',
    globalAccess: id === USER_C ? null : 'NONE',
    platformCapabilities: [],
    sessionId: ID('e1'),
    mfaEnforcementCompletedAt: new Date(),
    mfaPending: false,
  });

  async function freePort(): Promise<number> {
    const s = createServer();
    await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
    const { port } = s.address() as AddressInfo;
    await new Promise((ok) => s.close(ok));
    return port;
  }

  /** Connect `user` through the real OAuth flow; returns its access token. */
  async function connect(user: string, allowWrite: boolean): Promise<string> {
    const verifier = b64url(randomBytes(32));
    const q = new URLSearchParams({
      client_id: CLAUDE,
      redirect_uri: CLAUDE_CB,
      response_type: 'code',
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      state: 's',
      scope: 'mcp',
      resource: oauth.resource,
    });
    const jar: string[] = [];
    const keep = (res: Response) => {
      for (const c of res.headers.getSetCookie()) jar.push(c.split(';')[0]!);
    };
    const auth = await fetch(`${base}/api/v1/oauth/auth?${q}`, { redirect: 'manual' });
    keep(auth);
    const uid = auth.headers.get('location')!.split('/').pop()!;
    const approved = await fetch(`${consentBase}/approve/${uid}`, {
      method: 'POST',
      headers: { cookie: jar.join('; '), 'x-user': user, 'x-allow-write': String(allowWrite) },
    });
    const { redirectTo } = (await approved.json()) as { redirectTo: string };
    const resume = await fetch(`${base}${new URL(redirectTo).pathname}`, {
      redirect: 'manual',
      headers: { cookie: jar.join('; ') },
    });
    const code = new URL(resume.headers.get('location')!).searchParams.get('code')!;
    const token = await fetch(`${base}/api/v1/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLAUDE,
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: CLAUDE_CB,
        resource: oauth.resource,
      }),
    });
    return ((await token.json()) as { access_token: string }).access_token;
  }

  /** An MCP client as ChatGPT or Claude would run it, from a given client IP. */
  async function mcpClient(accessToken: string, clientIp = '203.0.113.9') {
    const client = new Client({ name: 'e2e', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/api/v1/mcp`), {
        requestInit: {
          headers: { authorization: `Bearer ${accessToken}`, 'x-forwarded-for': clientIp, 'user-agent': 'Claude-User' },
        },
      }),
    );
    return client;
  }

  const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? '';
  const json = (r: unknown) => JSON.parse(text(r)) as unknown;

  beforeAll(async () => {
    // The real `EnvService` validates the full env. CI has no `.env` (only
    // DATABASE_URL / REDIS_URL), so fill what is absent with throwaway
    // values; a local `.env` keeps priority. Jest gives each spec file its
    // own `process.env` copy, so nothing leaks into other specs.
    process.env.APP_URL ??= 'http://localhost:3000';
    process.env.API_URL ??= 'http://localhost:3000/api';
    for (const key of [
      'JWT_SIGNING_KEY', 'MFA_ENCRYPTION_KEY', 'COOKIE_SIGNING_KEY', 'CSRF_SIGNING_KEY',
      'PASSWORD_ENCRYPTION_KEY', 'INTEGRATION_SECRET_KEY', 'SMTP_SECRET_KEY',
    ]) {
      process.env[key] ??= randomBytes(32).toString('base64');
    }

    setDefaultResolveForTests(async () => ['93.184.216.34']);
    setDefaultFetchForTests((async (input: string | URL) => {
      if (String(input) !== CLAUDE) return new Response('not found', { status: 404 });
      return new Response(
        JSON.stringify({
          client_id: CLAUDE,
          client_name: 'Claude',
          redirect_uris: [CLAUDE_CB],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch);

    const internalPort = await freePort();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuditLogService)
      .useValue(audit)
      .overrideProvider(MCP_INTERNAL_ORIGIN)
      .useValue(`http://127.0.0.1:${internalPort}`)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    // The parts of `main.ts` the request path depends on.
    app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);
    app.set('query parser', 'simple');
    app.use(cookieParser(app.get(EnvService).values.COOKIE_SIGNING_KEY));
    app.useBodyParser('json', { limit: '2mb' });
    app.useBodyParser('urlencoded', { extended: true, limit: '2mb' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.setGlobalPrefix('api', { exclude: ['health', 'health/*path'] });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    internal = await startInternalListener(app.getHttpAdapter().getInstance(), internalPort);

    prisma = app.get(PrismaService);
    oauth = app.get(OAuthProviderService);
    consent = app.get(OAuthConsentService);
    connections = app.get(McpConnectionsService);
    delegations = app.get(McpDelegationService);
    // On for this app instance only; the instance setting is not touched.
    jest.spyOn(app.get(SettingsService), 'mcpRemoteEnabled').mockResolvedValue(true);

    // The consent decision, called on the service as the user in `x-user`.
    consentServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const uid = (req.url ?? '').split('/').pop()!;
      req.url = `/api/v1/oauth-consent/${uid}/approve`;
      const out = await consent.approve(
        actorOf(String(req.headers['x-user'])),
        uid,
        req.headers['x-allow-write'] === 'true',
        req,
        res,
        { ip: '203.0.113.9', userAgent: 'e2e' },
      );
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out));
    });
    await new Promise<void>((ok) => consentServer.listen(0, '127.0.0.1', ok));
    consentBase = `http://127.0.0.1:${(consentServer.address() as AddressInfo).port}`;

    await prisma.company.createMany({
      data: [
        { id: CO_X, name: 'MCP e2e X', slug: 'mcp-e2e-x' },
        { id: CO_Y, name: 'MCP e2e Y', slug: 'mcp-e2e-y' },
      ],
      skipDuplicates: true,
    });
    await prisma.user.createMany({
      data: [USER_A, USER_B, USER_C].map((id) => ({
        id,
        email: `${id}@mcp-e2e-spec.example`,
        name: 'MCP e2e',
        role: id === USER_C ? ('CLIENT_USER' as const) : ('OPERATOR' as const),
        globalAccess: id === USER_C ? null : ('NONE' as const),
        mfaEnforcementCompletedAt: new Date(),
      })),
      skipDuplicates: true,
    });
    await prisma.membership.createMany({
      data: [
        { userId: USER_A, companyId: CO_X, role: 'FULL' as const },
        { userId: USER_B, companyId: CO_Y, role: 'FULL' as const },
        { userId: USER_C, companyId: CO_X, role: 'READONLY' as const },
      ],
    });
  });

  afterAll(async () => {
    const grants = await prisma.mcpConnection.findMany({
      where: { userId: { in: [USER_A, USER_B, USER_C] } },
      select: { grantId: true },
    });
    await prisma.oAuthArtifact.deleteMany({ where: { grantId: { in: grants.map((g) => g.grantId) } } });
    for (const id of [USER_A, USER_B, USER_C]) {
      await prisma.oAuthArtifact.deleteMany({ where: { kind: 'Session', payload: { path: ['accountId'], equals: id } } });
    }
    await prisma.articleVersion?.deleteMany?.({ where: { article: { companyId: { in: [CO_X, CO_Y] } } } });
    await prisma.article.deleteMany({ where: { companyId: { in: [CO_X, CO_Y] } } });
    await prisma.company.deleteMany({ where: { id: { in: [CO_X, CO_Y] } } });
    await prisma.user.deleteMany({ where: { id: { in: [USER_A, USER_B, USER_C] } } });
    setDefaultFetchForTests(null);
    setDefaultResolveForTests(null);
    internal?.close();
    consentServer?.close();
    await app?.close();
  });

  it('answers 401 with the resource metadata pointer, 405 to GET, and serves the metadata', async () => {
    const res = await fetch(`${base}/api/v1/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${oauth.issuer}/.well-known/oauth-protected-resource/mcp", scope="mcp"`,
    );
    expect((await fetch(`${base}/api/v1/mcp`)).status).toBe(405);
    const meta = await (await fetch(`${base}/api/v1/mcp/resource-metadata`)).json();
    expect(meta).toMatchObject({ resource: oauth.resource, authorization_servers: [oauth.issuer] });
  });

  it('a read-only connection lists the 13 read tools and cannot reach a write', async () => {
    const client = await mcpClient(await connect(USER_A, false));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(ALL_TOOLS.filter((n) => !WRITE_TOOLS.includes(n)).sort());

    const before = await prisma.article.count({ where: { companyId: CO_X } });
    const r = await client.callTool({
      name: 'create_article',
      arguments: { companyId: CO_X, title: 'no', markdownSource: '# no' },
    });
    expect(r.isError).toBe(true);
    expect(await prisma.article.count({ where: { companyId: CO_X } })).toBe(before);

    // Reads go through every REST guard as user A, scoped to A's company.
    const companies = json(await client.callTool({ name: 'list_companies', arguments: {} })) as {
      items?: { id: string }[];
    };
    const ids = (companies.items ?? (companies as unknown as { id: string }[])).map((c) => c.id);
    expect(ids).toContain(CO_X);
    expect(ids).not.toContain(CO_Y);
    const who = json(await client.callTool({ name: 'whoami', arguments: {} })) as { id?: string; user?: { id: string } };
    expect(who.id ?? who.user?.id).toBe(USER_A);
    await client.close();
  });

  it('the REST layer refuses a write from a read-only connection on its own', async () => {
    await connect(USER_A, false);
    const conn = await prisma.mcpConnection.findFirstOrThrow({
      where: { userId: USER_A, allowWrite: false, revokedAt: null },
    });
    // As if the MCP layer had a bug: a handle for a POST on a read-only grant.
    const path = `/api/v1/companies/${CO_X}/articles`;
    const handle = delegations.mint({ connectionId: conn.id, userId: USER_A, method: 'POST', path });
    const res = await fetch(`${new URL(path, `http://127.0.0.1:${(internal.address() as AddressInfo).port}`)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${handle}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', markdownSource: '# x', editorMode: 'markdown', visibleToClients: false }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { detail?: string }).detail).toMatch(/connection is read-only/);
  });

  it('a write connection creates a hidden article, audited as the user through the connection, from the client IP', async () => {
    const client = await mcpClient(await connect(USER_A, true));
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(WRITE_TOOLS));
    const r = await client.callTool({
      name: 'create_article',
      arguments: { companyId: CO_X, title: 'Runbook from Claude', markdownSource: '# Hello' },
    });
    expect(r.isError).not.toBe(true);
    const created = await prisma.article.findFirstOrThrow({ where: { companyId: CO_X, title: 'Runbook from Claude' } });
    expect(created.visibleToClients).toBe(false);

    const conn = await prisma.mcpConnection.findFirstOrThrow({
      where: { userId: USER_A, allowWrite: true, revokedAt: null },
    });
    const row = audit.rows.find((a) => a.action === 'article.create' && a.entityId === created.id);
    expect(row).toMatchObject({
      actorId: USER_A,
      mcpConnectionId: conn.id,
      apiKeyId: null,
      ip: '203.0.113.9',
      userAgent: 'Claude-User',
    });

    // A client user of the same company does not see the hidden article.
    const asClient = await mcpClient(await connect(USER_C, false));
    const listed = text(await asClient.callTool({ name: 'list_articles', arguments: { companyId: CO_X } }));
    expect(listed).not.toContain(created.id);
    await asClient.close();
    await client.close();
  });

  it('another tenant\'s company is refused at the REST layer', async () => {
    const client = await mcpClient(await connect(USER_B, true));
    const r = await client.callTool({ name: 'list_articles', arguments: { companyId: CO_X } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Weavestream returned 403/);
    await client.close();
  });

  it('concurrent connections of different users never see each other', async () => {
    const [a, b] = await Promise.all([
      connect(USER_A, false).then((t) => mcpClient(t)),
      connect(USER_B, false).then((t) => mcpClient(t)),
    ]);
    const calls = Array.from({ length: 12 }, (_, i) => (i % 2 ? b : a));
    const results = await Promise.all(calls.map((c) => c.callTool({ name: 'whoami', arguments: {} })));
    results.forEach((r, i) => {
      const who = json(r) as { id?: string; user?: { id: string } };
      expect(who.id ?? who.user?.id).toBe(i % 2 ? USER_B : USER_A);
    });
    await Promise.all([a.close(), b.close()]);
  });

  it('a revoked connection is refused on the next request', async () => {
    const token = await connect(USER_A, false);
    const client = await mcpClient(token);
    await client.callTool({ name: 'whoami', arguments: {} });
    const conn = await prisma.mcpConnection.findFirstOrThrow({
      where: { userId: USER_A, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    await connections.revokeOwn(actorOf(USER_A), conn.id, { ip: '203.0.113.9', userAgent: 'e2e' });
    const res = await fetch(`${base}/api/v1/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('the access token is worthless on the REST API, and a handle on the public port', async () => {
    const token = await connect(USER_A, true);
    const rest = await fetch(`${base}/api/v1/companies`, { headers: { authorization: `Bearer ${token}` } });
    expect(rest.status).toBe(401);

    const conn = await prisma.mcpConnection.findFirstOrThrow({
      where: { userId: USER_A, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const handle = delegations.mint({ connectionId: conn.id, userId: USER_A, method: 'GET', path: '/api/v1/companies' });
    const viaPublic = await fetch(`${base}/api/v1/companies`, { headers: { authorization: `Bearer ${handle}` } });
    expect(viaPublic.status).toBe(401);
  });

  it('requests without a credential are rate limited per IP, and the 429 carries Retry-After', async () => {
    // A fresh client IP per run, so a rerun inside the 1-minute window starts clean.
    const ip = `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
    const post = () =>
      fetch(`${base}/api/v1/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'x-forwarded-for': ip,
        },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      });
    for (let i = 0; i < 30; i++) expect((await post()).status).toBe(401);
    const limited = await post();
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(limited.headers.get('www-authenticate')).toBeNull();
  });

  it('an API key is not accepted on /mcp', async () => {
    const res = await fetch(`${base}/api/v1/mcp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ws_0123456789abcdef01_c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    expect(res.status).toBe(401);
  });
});
