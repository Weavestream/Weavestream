import 'reflect-metadata';
import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import type { EnvService } from '../config/env.service.js';
import { AUTH_THROTTLE_KEY, IS_PUBLIC_KEY } from '../common/public.decorator.js';
import { AUTHED_ONLY_KEY } from '../rbac/require-permission.decorator.js';
import { REQUIRE_STEP_UP_KEY } from '../auth/step-up/require-step-up.decorator.js';
import { StepUpGuard } from '../auth/step-up/step-up.guard.js';
import { StepUpRequiredException } from '../auth/step-up/step-up-required.exception.js';
import { INTERACTIVE_ONLY_KEY } from '../auth/interactive-only.decorator.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { SsoController } from './sso.controller.js';
import type { SsoCallbackOutcome } from './sso.service.js';

const APP_URL = 'https://wiki.example.test';
const IDP_URL = 'https://login.example.test/authorize?client_id=c';

const env = {
  values: {
    APP_URL: `${APP_URL}/`,
    SESSION_COOKIE_NAME: 'ws_session',
    SESSION_MAX_AGE_DAYS: 30,
    ACCESS_TOKEN_TTL_MIN: 15,
  },
} as unknown as EnvService;

function makeController(overrides: { enabled?: boolean } = {}) {
  const sso = {
    isEnabled: jest.fn(async () => overrides.enabled ?? true),
    config: jest.fn(async () => ({ enabled: true, providerName: 'Contoso', localLoginEnabled: true })),
    begin: jest.fn(async () => ({ url: IDP_URL, flowCookie: '{"flow":1}' })),
    complete: jest.fn<Promise<SsoCallbackOutcome>, [Record<string, unknown>]>(),
    beginLink: jest.fn(async (_who: { userId: string; sessionId: string }) => ({
      url: IDP_URL,
      flowCookie: '{"link":1}',
    })),
    unlink: jest.fn(async (_id: string, _meta: unknown) => ({ ok: true as const })),
    linkStatus: jest.fn(async (_id: string) => ({
      enabled: true,
      linked: false,
      providerName: 'Contoso',
    })),
  };
  const csrf = { issue: jest.fn(() => 'csrf-token') };
  const controller = new SsoController(sso as never, env, csrf as never);
  return { controller, sso, csrf };
}

interface CookieCall {
  name: string;
  value: string;
  opts: Record<string, unknown>;
}

function fakeRes() {
  const cookies: CookieCall[] = [];
  const cleared: string[] = [];
  const res = {
    cookie: jest.fn((name: string, value: string, opts: Record<string, unknown>) => {
      cookies.push({ name, value, opts });
    }),
    clearCookie: jest.fn((name: string) => {
      cleared.push(name);
    }),
    redirect: jest.fn(),
  };
  return { res: res as unknown as Response, raw: res, cookies, cleared };
}

const req = (signedCookies: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ({
    signedCookies,
    cookies: {},
    ip: '203.0.113.7',
    headers: { 'user-agent': 'jest' },
    id: 'req-1',
    ...extra,
  }) as unknown as Request;

const LOGIN_RESULT = {
  accessToken: 'access-jwt',
  refreshToken: 'refresh-token',
  mfaSetupRequired: false,
  mfaChallengeRequired: false,
  user: { id: 'u-1', email: 'a@example.test', name: 'A', role: 'OPERATOR' },
  preferences: { uiTheme: 'dark', uiAccent: 'lime', showItemCounts: true },
};

describe('SsoController', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('route metadata', () => {
    const reflector = new Reflector();
    const meta = (key: string, handler: keyof SsoController) =>
      reflector.get<boolean | undefined>(key, SsoController.prototype[handler] as never);

    it.each(['config', 'login', 'callback'] as const)('%s is public', (h) => {
      expect(meta(IS_PUBLIC_KEY, h)).toBe(true);
    });

    it.each(['login', 'callback'] as const)('%s is auth-throttled like password login', (h) => {
      expect(meta(AUTH_THROTTLE_KEY, h)).toBe(true);
    });

    it('step-up is authenticated, interactive-only and not public', () => {
      expect(meta(IS_PUBLIC_KEY, 'stepUp')).toBeUndefined();
      expect(meta(AUTHED_ONLY_KEY, 'stepUp')).toBe(true);
      expect(meta(INTERACTIVE_ONLY_KEY, 'stepUp')).toBe(true);
    });
  });

  describe('GET config', () => {
    it('returns the public configuration', async () => {
      const { controller } = makeController();
      expect(await controller.config()).toEqual({
        enabled: true,
        providerName: 'Contoso',
        localLoginEnabled: true,
      });
    });
  });

  describe('GET login', () => {
    it('sets the signed flow cookie (httpOnly, lax, 10 minutes) and redirects 302 to the IdP', async () => {
      const { controller, sso } = makeController();
      const { res, raw, cookies } = fakeRes();
      await controller.login(res);

      expect(sso.begin).toHaveBeenCalledWith();
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toMatchObject({
        name: '__Host-ws_sso_flow',
        value: '{"flow":1}',
        opts: { httpOnly: true, sameSite: 'lax', signed: true, maxAge: 10 * 60 * 1000, path: '/' },
      });
      expect(raw.redirect).toHaveBeenCalledWith(302, IDP_URL);
    });

    it('redirects to /login?sso_error=failed when single sign-on is off', async () => {
      const { controller, sso } = makeController({ enabled: false });
      const { res, raw, cookies } = fakeRes();
      await controller.login(res);
      expect(sso.begin).not.toHaveBeenCalled();
      expect(cookies).toHaveLength(0);
      expect(raw.redirect).toHaveBeenCalledWith(302, `${APP_URL}/login?sso_error=failed`);
    });

    it('redirects to /login?sso_error=failed when discovery fails', async () => {
      const { controller, sso } = makeController();
      sso.begin.mockRejectedValue(new Error('idp down'));
      const { res, raw, cookies } = fakeRes();
      await controller.login(res);
      expect(cookies).toHaveLength(0);
      expect(raw.redirect).toHaveBeenCalledWith(302, `${APP_URL}/login?sso_error=failed`);
    });
  });

  describe('flow cookie name', () => {
    it('uses the __Host- form over https: Secure, Path=/, no Domain', async () => {
      const { controller } = makeController();
      const { res, cookies } = fakeRes();
      await controller.login(res);
      expect(cookies[0]!.name).toBe('__Host-ws_sso_flow');
      expect(cookies[0]!.opts).toMatchObject({ secure: true, path: '/' });
      expect(cookies[0]!.opts).not.toHaveProperty('domain');
    });

    it('falls back to the plain name only when APP_URL is http (local dev)', async () => {
      const httpEnv = {
        values: { ...env.values, APP_URL: 'http://localhost:3000' },
      } as unknown as EnvService;
      const sso = {
        isEnabled: jest.fn(async () => true),
        begin: jest.fn(async () => ({ url: IDP_URL, flowCookie: '{}' })),
        complete: jest.fn(async () => ({ ok: false as const, code: 'expired' as const })),
      };
      const controller = new SsoController(sso as never, httpEnv, { issue: jest.fn() } as never);
      const { res, cookies, cleared } = fakeRes();
      await controller.login(res);
      expect(cookies[0]!.name).toBe('ws_sso_flow');
      expect(cookies[0]!.opts).toMatchObject({ secure: false });

      await controller.callback('c', 's', undefined, req({ ws_sso_flow: 'flow' }), res);
      expect(sso.complete).toHaveBeenCalledWith(expect.objectContaining({ flowCookie: 'flow' }));
      expect(cleared).toContain('ws_sso_flow');
    });

    it('does not read the plain name when https expects the __Host- one', async () => {
      const { controller, sso } = makeController();
      sso.complete.mockResolvedValue({ ok: false, code: 'expired' });
      const { res } = fakeRes();
      await controller.callback('c', 's', undefined, req({ ws_sso_flow: 'planted' }), res);
      expect(sso.complete).toHaveBeenCalledWith(expect.objectContaining({ flowCookie: undefined }));
    });
  });

  describe('GET callback', () => {
    it('on a login: sets the same four auth cookies as password login, clears the flow cookie, redirects to /', async () => {
      const { controller, sso } = makeController();
      sso.complete.mockResolvedValue({ ok: true, kind: 'login', login: LOGIN_RESULT as never, mfaSetupRequired: false, mfaChallengeRequired: false });
      const { res, raw, cookies, cleared } = fakeRes();

      await controller.callback('the-code', 'the-state', undefined, req({ '__Host-ws_sso_flow': 'flow' }), res);

      expect(sso.complete).toHaveBeenCalledWith({
        flowCookie: 'flow',
        code: 'the-code',
        state: 'the-state',
        idpError: undefined,
        meta: { ip: '203.0.113.7', userAgent: 'jest' },
        requestId: 'req-1',
      });
      expect(cleared).toEqual(['__Host-ws_sso_flow']);
      expect(cookies.map((c) => c.name).sort()).toEqual(
        ['ws_csrf', 'ws_session', 'ws_session_access', 'ws_ui'].sort(),
      );
      const session = cookies.find((c) => c.name === 'ws_session')!;
      expect(session.value).toBe('refresh-token');
      expect(session.opts).toMatchObject({ httpOnly: true, sameSite: 'lax', signed: true });
      expect(cookies.find((c) => c.name === 'ws_session_access')!.value).toBe('access-jwt');
      expect(raw.redirect).toHaveBeenCalledWith(302, `${APP_URL}/`);
    });

    it.each([
      ['setup is required', { mfaSetupRequired: true, mfaChallengeRequired: false }, '/mfa/setup'],
      ['a challenge is pending', { mfaSetupRequired: false, mfaChallengeRequired: true }, '/mfa/challenge'],
      ['both are flagged (setup wins, as in the password login)', { mfaSetupRequired: true, mfaChallengeRequired: true }, '/mfa/setup'],
      ['neither is needed', { mfaSetupRequired: false, mfaChallengeRequired: false }, '/'],
    ])('on a login where %s: sets the session cookies and redirects to %s', async (_n, flags, path) => {
      const { controller, sso } = makeController();
      sso.complete.mockResolvedValue({ ok: true, kind: 'login', login: LOGIN_RESULT as never, ...flags });
      const { res, raw, cookies } = fakeRes();

      await controller.callback('c', 's', undefined, req({ '__Host-ws_sso_flow': 'flow' }), res);

      expect(cookies.map((c) => c.name)).toContain('ws_session');
      expect(raw.redirect).toHaveBeenCalledTimes(1);
      expect(raw.redirect).toHaveBeenCalledWith(302, `${APP_URL}${path}`);
    });

    it('on a step-up: sets no session cookies and redirects to /', async () => {
      const { controller, sso } = makeController();
      sso.complete.mockResolvedValue({ ok: true, kind: 'stepup' });
      const { res, raw, cookies } = fakeRes();

      await controller.callback('c', 's', undefined, req({ '__Host-ws_sso_flow': 'flow' }), res);

      expect(cookies).toHaveLength(0);
      expect(raw.redirect).toHaveBeenCalledWith(302, `${APP_URL}/`);
    });

    it.each(['no_account', 'not_allowed', 'failed', 'expired'] as const)(
      'redirects a %s outcome to /login?sso_error=%s and sets no auth cookies',
      async (code) => {
        const { controller, sso } = makeController();
        sso.complete.mockResolvedValue({ ok: false, code });
        const { res, raw, cookies, cleared } = fakeRes();

        await controller.callback('c', 's', undefined, req({ '__Host-ws_sso_flow': 'flow' }), res);

        expect(raw.redirect).toHaveBeenCalledWith(302, `${APP_URL}/login?sso_error=${code}`);
        expect(cookies).toHaveLength(0);
        expect(cleared).toEqual(['__Host-ws_sso_flow']);
      },
    );

    it('passes the provider error through and still redirects with a fixed code', async () => {
      const { controller, sso } = makeController();
      sso.complete.mockResolvedValue({ ok: false, code: 'not_allowed' });
      const { res, raw } = fakeRes();

      await controller.callback(undefined, undefined, 'access_denied', req(), res);

      expect(sso.complete).toHaveBeenCalledWith(expect.objectContaining({ idpError: 'access_denied' }));
      expect(raw.redirect).toHaveBeenCalledWith(302, `${APP_URL}/login?sso_error=not_allowed`);
    });

    it('trusts only the signed flow cookie, never an unsigned one of the same name', async () => {
      const { controller, sso } = makeController();
      sso.complete.mockResolvedValue({ ok: false, code: 'expired' });
      const { res } = fakeRes();

      await controller.callback(
        'c',
        's',
        undefined,
        req({}, { cookies: { '__Host-ws_sso_flow': '{"forged":true}' } }),
        res,
      );

      expect(sso.complete).toHaveBeenCalledWith(expect.objectContaining({ flowCookie: undefined }));
    });

    it('never redirects anywhere but APP_URL, whatever the request carries', async () => {
      const { controller, sso } = makeController();
      sso.complete.mockResolvedValue({ ok: true, kind: 'login', login: LOGIN_RESULT as never, mfaSetupRequired: false, mfaChallengeRequired: false });
      const { res, raw } = fakeRes();

      await controller.callback(
        'c',
        's',
        undefined,
        req(
          { '__Host-ws_sso_flow': 'flow' },
          { query: { redirect: 'https://evil.example', next: '//evil.example', returnTo: 'https://evil.example' } },
        ),
        res,
      );

      const target = String(raw.redirect.mock.calls[0]![1]);
      expect(target).toBe(`${APP_URL}/`);
      expect(target).not.toContain('evil');
    });

    it('redirects with failed when single sign-on is off, without consulting the service', async () => {
      const { controller, sso } = makeController({ enabled: false });
      const { res, raw, cleared } = fakeRes();
      await controller.callback('c', 's', undefined, req(), res);
      expect(sso.complete).not.toHaveBeenCalled();
      expect(cleared).toEqual(['__Host-ws_sso_flow']);
      expect(raw.redirect).toHaveBeenCalledWith(302, `${APP_URL}/login?sso_error=failed`);
    });
  });

  describe('GET step-up', () => {
    const base: AuthedUser = {
      id: 'u-1',
      email: 'a@example.test',
      role: 'OPERATOR',
      globalAccess: 'FULL',
      platformCapabilities: [],
      sessionId: 's-1',
      mfaEnforcementCompletedAt: new Date(),
      mfaPending: false,
      passwordAccess: {} as never,
      authMethod: 'sso',
    };

    it('binds the flow to the authenticated user and session, and redirects to the IdP', async () => {
      const { controller, sso } = makeController();
      const { res, raw, cookies } = fakeRes();
      await controller.stepUp(base, res);

      expect(sso.begin).toHaveBeenCalledWith({ userId: 'u-1', sessionId: 's-1' });
      expect(cookies[0]).toMatchObject({ name: '__Host-ws_sso_flow' });
      expect(raw.redirect).toHaveBeenCalledWith(302, IDP_URL);
    });

    it('refuses a session that was not started with single sign-on', async () => {
      const { controller, sso } = makeController();
      const { res } = fakeRes();
      await expect(controller.stepUp({ ...base, authMethod: 'password' }, res)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(sso.begin).not.toHaveBeenCalled();
    });

    it('redirects with failed when discovery fails', async () => {
      const { controller, sso } = makeController();
      sso.begin.mockRejectedValue(new Error('idp down'));
      const { res, raw } = fakeRes();
      await controller.stepUp(base, res);
      expect(raw.redirect).toHaveBeenCalledWith(302, `${APP_URL}/login?sso_error=failed`);
    });
  });

  describe('self-service link routes', () => {
    const user: AuthedUser = {
      id: 'u-1',
      email: 'a@example.test',
      role: 'SUPER_ADMIN',
      globalAccess: null,
      platformCapabilities: [],
      sessionId: 's-1',
      mfaEnforcementCompletedAt: new Date(),
      mfaPending: false,
      passwordAccess: {} as never,
      authMethod: 'password',
    };
    const reflector = new Reflector();
    const meta = (key: string, handler: keyof SsoController) =>
      reflector.get<unknown>(key, SsoController.prototype[handler] as never);

    it.each(['link', 'unlink', 'linkStatus'] as const)(
      '%s is authenticated and interactive-only, never public',
      (h) => {
        expect(meta(IS_PUBLIC_KEY, h)).toBeUndefined();
        expect(meta(AUTHED_ONLY_KEY, h)).toBe(true);
        expect(meta(INTERACTIVE_ONLY_KEY, h)).toBe(true);
      },
    );

    it('link and unlink demand a step-up; status does not', () => {
      expect(meta(REQUIRE_STEP_UP_KEY, 'link')).toBeDefined();
      expect(meta(REQUIRE_STEP_UP_KEY, 'unlink')).toBeDefined();
      expect(meta(REQUIRE_STEP_UP_KEY, 'linkStatus')).toBeUndefined();
    });

    it.each(['link', 'unlink'] as const)(
      'the real StepUpGuard refuses %s without a fresh step-up, and admits it with one',
      async (h) => {
        const stepUp = {
          assertVerified: jest.fn().mockRejectedValue(new StepUpRequiredException('mfa')),
        };
        const guard = new StepUpGuard(new Reflector(), stepUp as never);
        const ctx = {
          switchToHttp: () => ({ getRequest: () => ({ user, method: 'GET', headers: {} }) }),
          getHandler: () => SsoController.prototype[h],
          getClass: () => SsoController,
        } as never;
        await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(StepUpRequiredException);
        expect(stepUp.assertVerified).toHaveBeenCalledWith(user);

        stepUp.assertVerified.mockResolvedValue(undefined);
        await expect(guard.canActivate(ctx)).resolves.toBe(true);
      },
    );

    it('GET link binds the flow to the authenticated user and session and redirects to the IdP', async () => {
      const { controller, sso } = makeController();
      const { res, raw, cookies } = fakeRes();
      await controller.link(user, req(), res);
      expect(sso.beginLink).toHaveBeenCalledWith({ userId: 'u-1', sessionId: 's-1' });
      expect(cookies[0]).toMatchObject({ name: '__Host-ws_sso_flow', value: '{"link":1}' });
      expect(raw.redirect).toHaveBeenCalledWith(302, IDP_URL);
    });

    it('GET link refuses a request the browser labels cross-site, and starts nothing', async () => {
      const { controller, sso } = makeController();
      const { res, cookies } = fakeRes();
      await expect(
        controller.link(user, req({}, { headers: { 'sec-fetch-site': 'cross-site' } }), res),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(sso.beginLink).not.toHaveBeenCalled();
      expect(cookies).toHaveLength(0);
    });

    it.each(['same-origin', 'same-site', 'none'])('GET link accepts Sec-Fetch-Site %s', async (v) => {
      const { controller, sso } = makeController();
      const { res } = fakeRes();
      await controller.link(user, req({}, { headers: { 'sec-fetch-site': v } }), res);
      expect(sso.beginLink).toHaveBeenCalled();
    });

    it('GET link redirects to /me?sso=failed when SSO is off or the IdP is unreachable', async () => {
      const off = makeController({ enabled: false });
      const a = fakeRes();
      await off.controller.link(user, req(), a.res);
      expect(a.raw.redirect).toHaveBeenCalledWith(302, `${APP_URL}/me?sso=failed`);

      const down = makeController();
      down.sso.beginLink.mockRejectedValue(new Error('idp down'));
      const b = fakeRes();
      await down.controller.link(user, req(), b.res);
      expect(b.cookies).toHaveLength(0);
      expect(b.raw.redirect).toHaveBeenCalledWith(302, `${APP_URL}/me?sso=failed`);
    });

    it('DELETE link unlinks the authenticated user, with request metadata', async () => {
      const { controller, sso } = makeController();
      await expect(controller.unlink(user, req())).resolves.toEqual({ ok: true });
      expect(sso.unlink).toHaveBeenCalledWith('u-1', { ip: '203.0.113.7', userAgent: 'jest' });
    });

    it('DELETE link is a 404 when SSO is off', async () => {
      const { controller } = makeController({ enabled: false });
      await expect(controller.unlink(user, req())).rejects.toBeInstanceOf(NotFoundException);
    });

    it('GET link/status answers for the authenticated user only', async () => {
      const { controller, sso } = makeController();
      await expect(controller.linkStatus(user)).resolves.toEqual({
        enabled: true,
        linked: false,
        providerName: 'Contoso',
      });
      expect(sso.linkStatus).toHaveBeenCalledWith('u-1');
    });

    it('callback: a successful link redirects to /me?sso=linked and sets no auth cookies', async () => {
      const { controller, sso } = makeController();
      sso.complete.mockResolvedValue({ ok: true, kind: 'link' });
      const { res, raw, cookies, cleared } = fakeRes();
      await controller.callback('c', 's', undefined, req({ '__Host-ws_sso_flow': 'flow' }), res);
      expect(raw.redirect).toHaveBeenCalledWith(302, `${APP_URL}/me?sso=linked`);
      expect(cookies).toHaveLength(0);
      expect(cleared).toEqual(['__Host-ws_sso_flow']);
    });

    it.each(['no_account', 'not_allowed', 'failed', 'expired'] as const)(
      'callback: a failed link with code %s returns to /me?sso=%s',
      async (code) => {
        const { controller, sso } = makeController();
        sso.complete.mockResolvedValue({ ok: false, code, purpose: 'link' });
        const { res, raw, cookies } = fakeRes();
        await controller.callback('c', 's', undefined, req({ '__Host-ws_sso_flow': 'flow' }), res);
        expect(raw.redirect).toHaveBeenCalledWith(302, `${APP_URL}/me?sso=${code}`);
        expect(cookies).toHaveLength(0);
      },
    );
  });
});
