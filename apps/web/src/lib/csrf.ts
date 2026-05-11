'use client';

/**
 * Shared CSRF token acquisition for browser-side mutating calls.
 *
 * The `ws_csrf` cookie is set by the API on first login; if a tab is
 * still warm but the cookie has been cleared (private window, devtools,
 * cookie purge) we ask `POST /auth/csrf` for a fresh one. Both
 * `apiFetch` (JSON) and the SSE chat streamer share this helper so
 * there's a single source of truth for the token handling.
 */

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]!) : undefined;
}

export async function ensureCsrf(): Promise<string> {
  const existing = readCookie('ws_csrf');
  if (existing) return existing;
  const res = await fetch('/api/v1/auth/csrf', {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) throw new Error('csrf-fetch-failed');
  const data = (await res.json()) as { csrfToken: string };
  return data.csrfToken;
}
