import type { Response } from 'express';
import type { EnvService } from '../config/env.service.js';
import {
  cookiesSecure,
  secureCookieOptions,
  setCsrfCookie,
  setSessionCookie,
} from './cookies.js';

// Minimal EnvService stand-in. The cookie helpers only read these fields;
// `as unknown as EnvService` keeps us from having to construct the full,
// 40-field validated env just to assert on a single flag.
function envWith(appUrl: string, nodeEnv = 'production'): EnvService {
  return {
    values: {
      APP_URL: appUrl,
      NODE_ENV: nodeEnv,
      SESSION_COOKIE_NAME: 'ws_session',
      SESSION_MAX_AGE_DAYS: 30,
      ACCESS_TOKEN_TTL_MIN: 15,
    },
  } as unknown as EnvService;
}

type CookieCall = { name: string; value: string; opts: Record<string, unknown> };

function fakeRes(): { res: Response; calls: CookieCall[] } {
  const calls: CookieCall[] = [];
  const res = {
    cookie(name: string, value: string, opts: Record<string, unknown>) {
      calls.push({ name, value, opts });
      return res;
    },
  } as unknown as Response;
  return { res, calls };
}

describe('cookie Secure flag (WS-008: derived from APP_URL, not NODE_ENV)', () => {
  it('is Secure when APP_URL is HTTPS (public production)', () => {
    expect(cookiesSecure(envWith('https://portal.example.com', 'production'))).toBe(
      true,
    );
  });

  it('is not Secure on http://localhost so local dev works over plain HTTP', () => {
    expect(cookiesSecure(envWith('http://localhost:3000', 'development'))).toBe(
      false,
    );
  });

  it('fails closed: HTTPS APP_URL stays Secure even if NODE_ENV is misconfigured', () => {
    // The exact misconfiguration WS-008 flags — a public HTTPS deployment
    // accidentally running with NODE_ENV=development. Cookies must still be
    // Secure because the flag now tracks the URL scheme, not the env name.
    expect(cookiesSecure(envWith('https://portal.example.com', 'development'))).toBe(
      true,
    );
  });

  it('fails closed on an unparseable APP_URL (Secure on)', () => {
    expect(cookiesSecure(envWith('not a url'))).toBe(true);
  });

  it('secureCookieOptions keeps httpOnly/sameSite/signed and tracks the scheme', () => {
    const prod = secureCookieOptions(envWith('https://portal.example.com'));
    expect(prod).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      signed: true,
      path: '/',
    });

    const dev = secureCookieOptions(envWith('http://localhost:3000', 'development'));
    expect(dev.secure).toBe(false);
  });

  it('setSessionCookie propagates the Secure flag onto the response', () => {
    const { res, calls } = fakeRes();
    setSessionCookie(res, envWith('https://portal.example.com'), 'refresh-token');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('ws_session');
    expect(calls[0]!.opts).toMatchObject({ httpOnly: true, secure: true });
  });

  it('setCsrfCookie is JS-readable but still Secure on HTTPS', () => {
    const { res, calls } = fakeRes();
    setCsrfCookie(res, envWith('https://portal.example.com'), 'csrf-token');
    expect(calls[0]!.name).toBe('ws_csrf');
    // Double-submit pattern: readable by JS (httpOnly:false) but Secure.
    expect(calls[0]!.opts).toMatchObject({ httpOnly: false, secure: true });
  });
});
