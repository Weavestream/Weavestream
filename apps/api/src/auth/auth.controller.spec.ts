import { UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthController } from './auth.controller.js';

const ENV = {
  values: {
    SESSION_COOKIE_NAME: 'ws_session',
    SESSION_MAX_AGE_DAYS: 30,
    ACCESS_TOKEN_TTL_MIN: 15,
    APP_URL: 'http://localhost',
  },
} as never;

function makeController(rotateResult: unknown) {
  const auth = { rotateRefresh: jest.fn().mockResolvedValue(rotateResult) };
  const controller = new AuthController(auth as never, {} as never, {} as never, ENV);
  return { controller, auth };
}

function makeReqRes(sessionCookie: string | undefined) {
  const req = {
    signedCookies: { ws_session: sessionCookie },
    ip: '127.0.0.1',
    headers: { 'user-agent': 'jest' },
  } as unknown as Request;
  const res = {
    cookie: jest.fn(),
    clearCookie: jest.fn(),
  } as unknown as Response;
  return { req, res };
}

const cookieNamesSet = (res: Response) =>
  (res.cookie as jest.Mock).mock.calls.map((c) => c[0] as string);

describe('AuthController.refresh', () => {
  it('sets BOTH the access cookie and the rotated session cookie on rotation', async () => {
    const { controller, auth } = makeController({
      accessToken: 'new-jwt',
      refreshToken: 'new-refresh-token',
      payload: { sub: 'u-1', sid: 's-1', role: 'OPERATOR' },
    });
    const { req, res } = makeReqRes('old-rt');

    await expect(controller.refresh(req, res)).resolves.toEqual({ ok: true });

    expect(auth.rotateRefresh).toHaveBeenCalledWith('old-rt', '127.0.0.1', 'jest', {
      audit: true,
    });
    const names = cookieNamesSet(res);
    expect(names).toContain('ws_session_access');
    expect(names).toContain('ws_session');
    const sessionCall = (res.cookie as jest.Mock).mock.calls.find((c) => c[0] === 'ws_session');
    expect(sessionCall![1]).toBe('new-refresh-token');
    expect(res.clearCookie).not.toHaveBeenCalled();
  });

  it('sets ONLY the access cookie on the concurrent-refresh grace path (no session-cookie overwrite/clear)', async () => {
    const { controller } = makeController({
      accessToken: 'new-jwt',
      payload: { sub: 'u-1', sid: 's-1', role: 'OPERATOR' },
    });
    const { req, res } = makeReqRes('old-rt');

    await controller.refresh(req, res);

    const names = cookieNamesSet(res);
    expect(names).toContain('ws_session_access');
    expect(names).not.toContain('ws_session');
    expect(res.clearCookie).not.toHaveBeenCalled();
  });

  it('clears auth cookies and 401s when rotation fails', async () => {
    const { controller } = makeController(null);
    const { req, res } = makeReqRes('old-rt');

    await expect(controller.refresh(req, res)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(res.clearCookie).toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('401s without calling rotateRefresh when no session cookie is present', async () => {
    const { controller, auth } = makeController(null);
    const { req, res } = makeReqRes(undefined);

    await expect(controller.refresh(req, res)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(auth.rotateRefresh).not.toHaveBeenCalled();
  });
});
