import type { CookieOptions, Response } from 'express';
import type { UiTheme, UiAccent } from '@weavestream/shared';
import type { EnvService } from '../config/env.service.js';

export interface CookieNames {
  session: string;
  access: string;
  csrf: string;
  ui: string;
}

export function cookieNames(env: EnvService): CookieNames {
  return {
    session: env.values.SESSION_COOKIE_NAME,
    access: `${env.values.SESSION_COOKIE_NAME}_access`,
    csrf: 'ws_csrf',
    // Phase 9b.1: UI preferences. NOT security-relevant; read by the
    // Next.js root layout before React hydrates so we can paint the
    // right theme + accent on the very first byte.
    ui: 'ws_ui',
  };
}

export function secureCookieOptions(env: EnvService): CookieOptions {
  return {
    httpOnly: true,
    secure: env.values.NODE_ENV === 'production',
    // `lax` is the modern recommendation: cross-site POSTs still don't
    // carry the cookie (preserving CSRF protection), but same-site XHR
    // and top-level navigations do. `strict` breaks Safari on
    // `http://localhost` — WebKit silently drops Strict cookies served
    // over non-TLS, which would make login impossible in local dev.
    sameSite: 'lax',
    signed: true,
    path: '/',
  };
}

export function setSessionCookie(
  res: Response,
  env: EnvService,
  refreshToken: string,
): void {
  res.cookie(cookieNames(env).session, refreshToken, {
    ...secureCookieOptions(env),
    maxAge: env.values.SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function setAccessCookie(res: Response, env: EnvService, jwt: string): void {
  res.cookie(cookieNames(env).access, jwt, {
    ...secureCookieOptions(env),
    maxAge: env.values.ACCESS_TOKEN_TTL_MIN * 60 * 1000,
  });
}

export function setCsrfCookie(res: Response, env: EnvService, token: string): void {
  // CSRF cookie must be readable by JS (double-submit pattern). Signed is fine
  // because cookie-parser signs with the same key we verify with; httpOnly=false.
  // See `secureCookieOptions` for why sameSite is 'lax' rather than 'strict'.
  res.cookie(cookieNames(env).csrf, token, {
    httpOnly: false,
    secure: env.values.NODE_ENV === 'production',
    sameSite: 'lax',
    signed: false,
    path: '/',
  });
}

export function clearAuthCookies(res: Response, env: EnvService): void {
  const names = cookieNames(env);
  const opts = secureCookieOptions(env);
  res.clearCookie(names.session, opts);
  res.clearCookie(names.access, opts);
  res.clearCookie(names.csrf, { ...opts, httpOnly: false, signed: false });
  // Clear the UI cookie on logout so a shared workstation doesn't
  // carry the previous user's accent into the next login screen.
  res.clearCookie(names.ui, {
    httpOnly: false,
    secure: env.values.NODE_ENV === 'production',
    sameSite: 'lax',
    signed: false,
    path: '/',
  });
}

/**
 * Encode the UI cookie. Format: `t=<theme>;a=<accent>` — compact, human
 * readable, trivial to parse from an Edge runtime. Values are always
 * lowercase so they drop straight into `data-theme` / `data-accent`.
 */
export function encodeUiCookie(theme: UiTheme, accent: UiAccent): string {
  return `t=${theme};a=${accent}`;
}

export function setUiCookie(
  res: Response,
  env: EnvService,
  theme: UiTheme,
  accent: UiAccent,
): void {
  res.cookie(cookieNames(env).ui, encodeUiCookie(theme, accent), {
    // Readable from the server *and* from the client so a same-page
    // accent preview can update the cookie without a round-trip.
    httpOnly: false,
    secure: env.values.NODE_ENV === 'production',
    sameSite: 'lax',
    signed: false,
    path: '/',
    // One year. The cookie is cosmetic; even if it survives too long
    // the worst case is a stale theme on a freshly-cleared session.
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });
}
