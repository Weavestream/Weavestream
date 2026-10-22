import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from './auth.guard.js';
import { McpDelegationService } from '../../mcp/mcp-delegation.service.js';
import { internalListenerHandler } from '../../common/internal-listener.js';

const ENV = {
  values: {
    SESSION_COOKIE_NAME: 'ws_session',
    SESSION_MAX_AGE_DAYS: 30,
    ACCESS_TOKEN_TTL_MIN: 15,
    APP_URL: 'http://localhost',
  },
} as never;

const CLAUDE_CONNECTION = {
  id: 'c-1',
  userId: 'u-1',
  allowWrite: false,
  clientId: 'https://claude.ai/oauth/mcp-client-metadata',
  redirectHost: 'claude.ai',
};
/** A connection from an app that registered itself, on a loopback redirect. */
const DCR_CONNECTION = { ...CLAUDE_CONNECTION, clientId: 'Xk3_registered-id', redirectHost: '127.0.0.1' };

function makeGuard(
  rotateResult: unknown,
  {
    apiKeysEnabled = true,
    key = null,
    mcpRemoteEnabled = true,
    mcpClientPolicy = 'claude_chatgpt',
    connection = CLAUDE_CONNECTION,
  }: {
    apiKeysEnabled?: boolean;
    key?: unknown;
    mcpRemoteEnabled?: boolean;
    mcpClientPolicy?: 'claude_chatgpt' | 'any';
    connection?: { id: string; userId: string; allowWrite: boolean; clientId: string; redirectHost: string } | null;
  } = {},
) {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as never;
  // No access cookie is sent, so verifyAccessToken is never reached and the
  // guard falls straight through to the silent-refresh (rotation) path.
  const tokens = { verifyAccessToken: jest.fn() } as never;
  const auth = { rotateRefresh: jest.fn().mockResolvedValue(rotateResult) };
  const prisma = {
    session: {
      findUnique: jest.fn().mockResolvedValue({
        id: 's-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 1_000_000_000),
        mfaPending: false,
      }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'u-1',
        email: 'u@example.com',
        role: 'OPERATOR',
        isActive: true,
        globalAccess: null,
        platformCapabilities: [],
        mfaEnforcementCompletedAt: new Date(),
      }),
    },
  } as never;
  // API-key verification is not exercised by these cookie-path specs; the
  // stub returns null so the guard always falls through to the cookie branch.
  const apiKeys = {
    verify: jest.fn().mockResolvedValue(key),
    touch: jest.fn().mockResolvedValue(undefined),
  };
  const settings = {
    apiKeysEnabled: jest.fn().mockResolvedValue(apiKeysEnabled),
    mcpRemoteEnabled: jest.fn().mockResolvedValue(mcpRemoteEnabled),
    mcpClientPolicy: jest.fn().mockResolvedValue(mcpClientPolicy),
  };
  const delegations = new McpDelegationService();
  const mcpConnections = { findActiveById: jest.fn().mockResolvedValue(connection) };
  const guard = new AuthGuard(
    reflector,
    tokens,
    auth as never,
    prisma,
    ENV,
    apiKeys as never,
    settings as never,
    delegations,
    mcpConnections as never,
  );
  return { guard, auth, apiKeys, settings, delegations, mcpConnections, prisma };
}

function makeCtx() {
  const req = {
    signedCookies: { ws_session: 'rt' },
    ip: '127.0.0.1',
    headers: {},
  } as unknown as Request;
  const res = { cookie: jest.fn(), clearCookie: jest.fn() } as unknown as Response;
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
  return { ctx, req, res };
}

const cookieNamesSet = (res: Response) =>
  (res.cookie as jest.Mock).mock.calls.map((c) => c[0] as string);

describe('AuthGuard silent refresh rotation', () => {
  it('rotates on the silent path: sets BOTH access and session cookies, keeps the user logged in', async () => {
    const { guard, auth } = makeGuard({
      accessToken: 'new-jwt',
      refreshToken: 'new-refresh-token',
      payload: { sub: 'u-1', sid: 's-1', role: 'OPERATOR' },
    });
    const { ctx, res } = makeCtx();

    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    expect(auth.rotateRefresh).toHaveBeenCalledWith('rt', '127.0.0.1', 'unknown', {
      audit: false,
    });
    const names = cookieNamesSet(res);
    expect(names).toContain('ws_session_access');
    expect(names).toContain('ws_session');
  });

  it('sets only the access cookie on the concurrent-refresh grace path', async () => {
    const { guard } = makeGuard({
      accessToken: 'new-jwt',
      payload: { sub: 'u-1', sid: 's-1', role: 'OPERATOR' },
    });
    const { ctx, res } = makeCtx();

    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    const names = cookieNamesSet(res);
    expect(names).toContain('ws_session_access');
    expect(names).not.toContain('ws_session');
  });

  it('401s when rotation fails (revoked/expired/reused session)', async () => {
    const { guard } = makeGuard(null);
    const { ctx } = makeCtx();

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AuthGuard bearer handling', () => {
  const ROTATED = {
    accessToken: 'new-jwt',
    refreshToken: 'new-refresh-token',
    payload: { sub: 'u-1', sid: 's-1', role: 'OPERATOR' },
  };

  it('ignores a Bearer that is not a Weavestream key and authenticates the cookie', async () => {
    // An SSO proxy (oauth2-proxy, Cloudflare Access) in front of the app may
    // add its own JWT as Bearer on every request. Treating that as a failed
    // API key would log every browser out.
    const { guard, apiKeys } = makeGuard(ROTATED);
    const { ctx, req } = makeCtx();
    req.headers.authorization = 'Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig';

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(apiKeys.verify).not.toHaveBeenCalled();
  });

  it('fails closed on a dead ws_ key instead of falling back to cookies', async () => {
    const { guard, apiKeys } = makeGuard(ROTATED);
    const { ctx, req } = makeCtx();
    req.headers.authorization = 'Bearer ws_deadbeef_secret';

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(apiKeys.verify).toHaveBeenCalled();
  });

  const LIVE_KEY = {
    id: 'k-1',
    userId: 'u-1',
    allowPasswordReveal: false,
    allowWrite: false,
    lastUsedAt: null,
  };

  it('refuses every key while API keys are turned off, without looking it up', async () => {
    const { guard, apiKeys } = makeGuard(ROTATED, { apiKeysEnabled: false, key: LIVE_KEY });
    const { ctx, req } = makeCtx();
    req.headers.authorization = 'Bearer ws_0123456789abcdef01_secret';

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(apiKeys.verify).not.toHaveBeenCalled();
  });

  it('refuses a live key whose owner is deactivated, without falling back to cookies', async () => {
    const { guard } = makeGuard(ROTATED, { key: LIVE_KEY });
    const { ctx, req } = makeCtx();
    req.headers.authorization = 'Bearer ws_0123456789abcdef01_secret';
    const prisma = (guard as unknown as { prisma: { user: { findUnique: jest.Mock } } }).prisma;
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-1', isActive: false });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('carries the key\'s write permission onto the principal', async () => {
    const { guard } = makeGuard(ROTATED, { key: LIVE_KEY });
    const { ctx, req } = makeCtx();
    req.headers.authorization = 'Bearer ws_0123456789abcdef01_secret';

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const user = (req as unknown as { user: { apiKeyId: string; apiKeyAllowWrite: boolean } }).user;
    expect(user.apiKeyId).toBe('k-1');
    expect(user.apiKeyAllowWrite).toBe(false);
  });
});

describe('AuthGuard remote MCP delegation handles', () => {
  const PATH = '/api/v1/companies/11111111-1111-4111-8111-111111111111/assets';

  /** A request as the internal listener (or the public port) would deliver it. */
  function makeDelegatedCtx(
    handle: string,
    { internal = true, method = 'GET', path = PATH }: { internal?: boolean; method?: string; path?: string } = {},
  ) {
    const req = {
      method,
      path,
      signedCookies: {},
      ip: '127.0.0.1',
      headers: { authorization: `Bearer ${handle}` },
    } as unknown as Request & { user?: Record<string, unknown> };
    // Mark it exactly as the internal listener does.
    if (internal) internalListenerHandler(() => undefined)(req as never, {} as never);
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
    return { ctx, req };
  }

  const grant = { connectionId: 'c-1', userId: 'u-1', method: 'GET' as const, path: PATH };

  it('authenticates the connection\'s user once, with key-style containment and no apiKeyId', async () => {
    const { guard, delegations, apiKeys } = makeGuard(null);
    const handle = delegations.mint(grant);
    const { ctx, req } = makeDelegatedCtx(handle);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toMatchObject({
      id: 'u-1',
      sessionId: 'c-1',
      mcpConnectionId: 'c-1',
      mfaPending: false,
      apiKeyAllowWrite: false,
      apiKeyAllowPasswordReveal: false,
    });
    expect(req.user).not.toHaveProperty('apiKeyId');
    expect(apiKeys.verify).not.toHaveBeenCalled();

    // Single use: the same handle again is refused.
    const again = makeDelegatedCtx(handle);
    await expect(guard.canActivate(again.ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('carries the connection\'s write grant', async () => {
    const { guard, delegations } = makeGuard(null, {
      connection: { ...CLAUDE_CONNECTION, allowWrite: true },
    });
    const { ctx, req } = makeDelegatedCtx(delegations.mint(grant));
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toMatchObject({ apiKeyAllowWrite: true, apiKeyAllowPasswordReveal: false });
  });

  it('refuses a valid handle on the public listener, even from a loopback peer', async () => {
    const { guard, delegations } = makeGuard(null);
    const { ctx } = makeDelegatedCtx(delegations.mint(grant), { internal: false });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([
    ['another method', { method: 'POST' }],
    ['another path', { path: '/api/v1/companies/11111111-1111-4111-8111-111111111111/passwords' }],
  ])('refuses the handle for %s, and burns it', async (_label, opts) => {
    const { guard, delegations } = makeGuard(null);
    const handle = delegations.mint(grant);
    await expect(guard.canActivate(makeDelegatedCtx(handle, opts).ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(guard.canActivate(makeDelegatedCtx(handle).ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses an unknown or expired handle', async () => {
    const { guard, delegations } = makeGuard(null);
    await expect(guard.canActivate(makeDelegatedCtx('wsd_unknown').ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    const handle = delegations.mint(grant);
    const real = Date.now.bind(Date);
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => real() + 31_000);
    try {
      await expect(guard.canActivate(makeDelegatedCtx(handle).ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses when the connection was revoked, belongs to someone else, or the switch is off', async () => {
    for (const opts of [
      { connection: null },
      { connection: { ...CLAUDE_CONNECTION, userId: 'u-2' } },
      { mcpRemoteEnabled: false },
      // Another app's connection while only Claude and ChatGPT may connect.
      { connection: DCR_CONNECTION },
    ]) {
      const { guard, delegations } = makeGuard(null, opts);
      await expect(guard.canActivate(makeDelegatedCtx(delegations.mint(grant)).ctx)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }
  });

  it('accepts another app\'s connection while any app may connect', async () => {
    const { guard, delegations } = makeGuard(null, { connection: DCR_CONNECTION, mcpClientPolicy: 'any' });
    await expect(guard.canActivate(makeDelegatedCtx(delegations.mint(grant)).ctx)).resolves.toBe(true);
  });

  it('refuses a deactivated user', async () => {
    const { guard, delegations, prisma } = makeGuard(null);
    (prisma as unknown as { user: { findUnique: jest.Mock } }).user.findUnique.mockResolvedValue({
      id: 'u-1',
      isActive: false,
    });
    await expect(guard.canActivate(makeDelegatedCtx(delegations.mint(grant)).ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
