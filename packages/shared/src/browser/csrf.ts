import { readBrowserCookie } from './cookies.js';

/**
 * Shared CSRF token acquisition for browser-side mutating calls.
 *
 * The `ws_csrf` cookie is set by the API on first login; if a tab is
 * still warm but the cookie has been cleared (private window, devtools,
 * cookie purge) we ask `POST /auth/csrf` for a fresh one. `apiFetch`
 * (JSON), the SSE chat streamer, and the mobile fetch client all share
 * this helper so there's a single source of truth for the token
 * handling.
 *
 * The path is relative on purpose: every consumer is same-origin, which
 * is what lets the mobile PWA reuse the desktop's cookie auth wholesale.
 */

// Not exported: `apps/web/src/lib/api-config.ts` is the canonical
// `CSRF_COOKIE_NAME` for that app, and re-exporting it here would give
// the monorepo two importable constants for one cookie.
const CSRF_COOKIE = 'ws_csrf';

export async function ensureCsrf(): Promise<string> {
  const existing = readBrowserCookie(CSRF_COOKIE);
  if (existing) return existing;
  const res = await fetch('/api/v1/auth/csrf', {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) throw new Error('csrf-fetch-failed');
  const data = (await res.json()) as { csrfToken: string };
  return data.csrfToken;
}
