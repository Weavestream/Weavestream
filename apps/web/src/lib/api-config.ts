/**
 * Proxy/edge-safe config shared by the Next.js `proxy.ts` layer and the
 * server-side API helpers. This module MUST NOT import `next/headers` or any
 * request-scoped API, so it can be pulled into `proxy.ts` (which runs in the
 * proxy layer and cannot import `server-api.ts`).
 */

/**
 * Internal base URL for the API from inside Next.js (docker service name in
 * production, localhost in local dev). Never expose this to the browser —
 * the browser always goes through the `/api/v1` reverse proxy.
 */
export const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://api:4000';

/**
 * Auth cookie names. These MIRROR the API's canonical `cookieNames()`
 * derivation in `apps/api/src/auth/cookies.ts` — the API is the authority
 * that SETS these cookies; the web layer only reads them. Keep the two in
 * sync: if the API renames a cookie, update it here too or the proxy's
 * access-cookie skip-check and CSRF lookup silently break.
 */
export const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'ws_session';
export const ACCESS_COOKIE_NAME = `${SESSION_COOKIE_NAME}_access`;
export const CSRF_COOKIE_NAME = 'ws_csrf';
