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

/**
 * The cookie signing key, shared by the api and web containers through the
 * same `.env` (compose gives all services `env_file: .env`). The web tier
 * derives the internal-API token from it (`deriveInternalApiToken` in
 * `@weavestream/shared`) to authenticate its server-side poll of the
 * internal `/api/v1/ip-rules/active` endpoint — no separate secret to set.
 *
 * Read as a raw env var: the web app does not run the Zod `loadEnv` the
 * API/worker use, so this can be empty in a misconfigured custom (non-
 * compose) deployment. Empty ⇒ the poll is rejected and page-layer IP
 * rules fail open; the API still enforces on its own endpoints. (WS-028)
 */
export const COOKIE_SIGNING_KEY = process.env.COOKIE_SIGNING_KEY ?? '';
