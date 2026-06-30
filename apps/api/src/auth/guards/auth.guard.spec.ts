import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from './auth.guard.js';

const ENV = {
  values: {
    SESSION_COOKIE_NAME: 'ws_session',
    SESSION_MAX_AGE_DAYS: 30,
    ACCESS_TOKEN_TTL_MIN: 15,
    APP_URL: 'http://localhost',
  },
} as never;

function makeGuard(rotateResult: unknown) {
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
  const guard = new AuthGuard(reflector, tokens, auth as never, prisma, ENV);
  return { guard, auth };
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
