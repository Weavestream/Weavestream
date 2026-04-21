'use client';

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]!) : undefined;
}

async function ensureCsrf(): Promise<string> {
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

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; data: T | null; problem?: unknown }> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');

  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const token = await ensureCsrf();
    headers.set('X-CSRF-Token', token);
  }

  try {
    const res = await fetch(`/api/v1${path}`, {
      ...init,
      method,
      headers,
      credentials: 'include',
    });

    const contentType = res.headers.get('content-type') ?? '';
    let data: T | null = null;
    let problem: unknown;
    if (contentType.includes('problem+json')) {
      problem = await res.json().catch(() => null);
    } else if (contentType.includes('json')) {
      data = (await res.json().catch(() => null)) as T | null;
    }
    return { ok: res.ok, status: res.status, data, problem };
  } catch (err) {
    // Abort is a first-class part of our debounce-on-input pattern — it's
    // not an error. Return a sentinel so callers can branch on `aborted`
    // (or just ignore the call) without unhandled-rejection noise in the
    // Next.js dev overlay.
    if (
      (err instanceof DOMException && err.name === 'AbortError') ||
      (err instanceof Error && err.name === 'AbortError')
    ) {
      return { ok: false, status: 0, data: null, problem: { aborted: true } };
    }
    throw err;
  }
}
