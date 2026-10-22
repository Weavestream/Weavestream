import { ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { McpAccessTokenGuard } from './mcp-access-token.guard.js';
import type { McpRequest } from './mcp-principal.js';

const ISSUER = 'https://ws.example.test';
const RESOURCE = `${ISSUER}/mcp`;
const GOOD = { aud: RESOURCE, grantId: 'g-1', accountId: 'u-1', scope: 'mcp' };

function makeGuard({
  token = GOOD as Record<string, unknown> | null,
  connection = {
    id: 'c-1',
    userId: 'u-1',
    clientId: 'https://claude.ai/oauth/mcp-client-metadata',
    redirectHost: 'claude.ai',
    allowWrite: false,
    lastUsedAt: null,
  } as Record<string, unknown> | null,
  user = { isActive: true, mfaEnforcementCompletedAt: new Date() } as Record<string, unknown> | null,
  enabled = true,
  policy = 'claude_chatgpt' as 'claude_chatgpt' | 'any',
  limit = 600,
} = {}) {
  const hits = new Map<string, number>();
  const throttle = {
    increment: jest.fn(async (key: string) => {
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      return { totalHits: n, timeToExpire: 30_000, isBlocked: false, timeToBlockExpire: 0 };
    }),
  };
  // null = the provider finds no such token (unknown, expired or not ours).
  const find = jest.fn().mockResolvedValue(token ?? undefined);
  const oauth = { issuer: ISSUER, resource: RESOURCE, provider: { AccessToken: { find } } };
  const connections = { findActiveByGrant: jest.fn().mockResolvedValue(connection), touch: jest.fn() };
  const prisma = { user: { findUnique: jest.fn().mockResolvedValue(user) } };
  const settings = {
    mcpRemoteEnabled: jest.fn().mockResolvedValue(enabled),
    mcpClientPolicy: jest.fn().mockResolvedValue(policy),
  };
  const env = { values: { GLOBAL_RATE_LIMIT_PER_MIN: limit } };
  const guard = new McpAccessTokenGuard(
    oauth as never,
    connections as never,
    prisma as never,
    settings as never,
    env as never,
    throttle as never,
  );
  return { guard, find, throttle, hits };
}

function ctxFor(headers: Record<string, string> = {}, ip = '160.79.104.10') {
  const req = { headers, ip, socket: {} } as unknown as McpRequest;
  const sent = new Map<string, string>();
  const res = {
    headers: sent,
    setHeader: jest.fn((k: string, v: string) => sent.set(k.toLowerCase(), v)),
    removeHeader: jest.fn((k: string) => sent.delete(k.toLowerCase())),
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  return { ctx, req, res };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe('McpAccessTokenGuard', () => {
  it('without a token: 401 pointing at the resource metadata, no error code', async () => {
    const { guard } = makeGuard();
    const { ctx, res } = ctxFor();
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(res.setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp", scope="mcp"`,
    );
  });

  it('accepts a live token for this resource and sets the principal', async () => {
    const { guard } = makeGuard();
    const { ctx, req } = ctxFor({ ...bearer('tok'), 'user-agent': 'Claude-User' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.mcp).toEqual({
      connectionId: 'c-1',
      userId: 'u-1',
      allowWrite: false,
      ip: '160.79.104.10',
      userAgent: 'Claude-User',
    });
    expect(req).not.toHaveProperty('user');
  });

  it.each([
    ['an API key (keys are not valid on /mcp)', null],
    ['a token for another audience', { ...GOOD, aud: 'https://other.example/mcp' }],
    ['a token without the mcp scope', { ...GOOD, scope: '' }],
    ['a token without a grant', { ...GOOD, grantId: undefined }],
  ])('401 invalid_token for %s', async (_label, token) => {
    const { guard } = makeGuard({ token: token as Record<string, unknown> | null });
    const { ctx, res } = ctxFor(bearer('ws_0123456789abcdef01_secret'));
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(res.setHeader).toHaveBeenCalledWith('WWW-Authenticate', expect.stringContaining('error="invalid_token"'));
  });

  it.each([
    ['the connection is revoked or expired', { connection: null }],
    ['the connection belongs to someone else', { connection: { id: 'c-1', userId: 'u-2', allowWrite: false } }],
    ['the user is deactivated', { user: { isActive: false, mfaEnforcementCompletedAt: new Date() } }],
    ['the user has not finished MFA enrollment', { user: { isActive: true, mfaEnforcementCompletedAt: null } }],
  ])('401 when %s', async (_label, opts) => {
    const { guard } = makeGuard(opts as never);
    await expect(guard.canActivate(ctxFor(bearer('tok')).ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  describe('client policy', () => {
    const dcr = {
      id: 'c-1',
      userId: 'u-1',
      clientId: 'Xk3_registered-id',
      redirectHost: '127.0.0.1',
      allowWrite: false,
      lastUsedAt: null,
    };

    it('401 for another app\'s connection while only Claude and ChatGPT may connect', async () => {
      const { guard } = makeGuard({ connection: dcr });
      const { ctx, res } = ctxFor(bearer('tok'));
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(res.setHeader).toHaveBeenCalledWith('WWW-Authenticate', expect.stringContaining('error="invalid_token"'));
    });

    it('accepts the same connection while any app may connect', async () => {
      const { guard } = makeGuard({ connection: dcr, policy: 'any' });
      await expect(guard.canActivate(ctxFor(bearer('tok')).ctx)).resolves.toBe(true);
    });

    it('accepts a Claude connection in both modes', async () => {
      for (const policy of ['claude_chatgpt', 'any'] as const) {
        const { guard } = makeGuard({ policy });
        await expect(guard.canActivate(ctxFor(bearer('tok')).ctx)).resolves.toBe(true);
      }
    });
  });

  it('403 when remote connections are switched off', async () => {
    const { guard, find } = makeGuard({ enabled: false });
    await expect(guard.canActivate(ctxFor(bearer('tok')).ctx)).rejects.toBeInstanceOf(ForbiddenException);
    expect(find).not.toHaveBeenCalled();
  });

  it('403 for a browser Origin other than the instance, before looking at the token', async () => {
    const { guard, find } = makeGuard();
    await expect(
      guard.canActivate(ctxFor({ ...bearer('tok'), origin: 'https://evil.example' }).ctx),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(find).not.toHaveBeenCalled();
    await expect(guard.canActivate(ctxFor({ ...bearer('tok'), origin: ISSUER }).ctx)).resolves.toBe(true);
  });

  it('a flood of bad tokens from one IP does not block a valid token from that IP', async () => {
    const bad = makeGuard({ token: null });
    for (let i = 0; i < 30; i++) {
      await expect(bad.guard.canActivate(ctxFor(bearer(`junk-${i}`)).ctx)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }
    await expect(bad.guard.canActivate(ctxFor(bearer('junk-31')).ctx)).rejects.toMatchObject({ status: 429 });

    // Same IP, same throttle storage, a real token: its own per-user bucket.
    const good = makeGuard();
    (good.throttle.increment as jest.Mock).mockImplementation(bad.throttle.increment);
    await expect(good.guard.canActivate(ctxFor(bearer('tok')).ctx)).resolves.toBe(true);
    expect([...bad.hits.keys()]).toEqual(['mcp-fail:160.79.104.10', 'mcp-user:u-1']);
  });

  it('valid tokens are limited per user, with Retry-After', async () => {
    const { guard } = makeGuard({ limit: 2 });
    await guard.canActivate(ctxFor(bearer('tok')).ctx);
    await guard.canActivate(ctxFor(bearer('tok')).ctx);
    const third = ctxFor(bearer('tok'));
    await expect(guard.canActivate(third.ctx)).rejects.toBeInstanceOf(HttpException);
    expect(third.res.headers.get('retry-after')).toBe('30');
  });

  it('requests with no or a malformed Authorization header count against the IP too', async () => {
    const { guard, hits } = makeGuard();
    const shapes: Record<string, string>[] = [{}, { authorization: 'Basic abc' }, { authorization: 'Bearer' }, { authorization: 'Bearer ' + 'x'.repeat(600) }];
    for (let i = 0; i < 30; i++) {
      await expect(guard.canActivate(ctxFor(shapes[i % shapes.length]).ctx)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }
    const blocked = ctxFor();
    await expect(guard.canActivate(blocked.ctx)).rejects.toMatchObject({ status: 429 });
    // A rate-limited answer tells the client when to retry, not to sign in.
    expect(blocked.res.headers.get('retry-after')).toBe('30');
    expect(blocked.res.headers.has('www-authenticate')).toBe(false);
    expect([...hits.keys()]).toEqual(['mcp-fail:160.79.104.10']);
  });

  it('a foreign Origin and the switch being off count as refusals as well', async () => {
    const origin = makeGuard();
    await expect(
      origin.guard.canActivate(ctxFor({ ...bearer('tok'), origin: 'https://evil.example' }).ctx),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(origin.hits.get('mcp-fail:160.79.104.10')).toBe(1);

    const off = makeGuard({ enabled: false });
    await expect(off.guard.canActivate(ctxFor(bearer('tok')).ctx)).rejects.toBeInstanceOf(ForbiddenException);
    expect(off.hits.get('mcp-fail:160.79.104.10')).toBe(1);
  });
});
