import { ensureCsrf } from '@weavestream/shared/browser';

/**
 * Mobile's HTTP client.
 *
 * **This deliberately inverts `apps/web/src/lib/api.ts`'s contract.**
 * That one returns `{ ok, status, data, problem }` and never throws for
 * an HTTP failure. Mirroring it here would break TanStack Query
 * silently: Query would treat a 401 or a 500 as a *successful* result,
 * so `retry`, error boundaries, and the cache `onError` handlers would
 * never fire and a dead session would look like an empty list.
 *
 * So: success returns parsed data, non-2xx throws `ApiError`, and an
 * aborted request rethrows unchanged so Query can recognise its own
 * cancellation.
 *
 * The divergence is one-directional. Do NOT "align" `apps/web`'s client
 * to this — it has 96+ call sites depending on the return shape.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly problem: unknown;

  constructor(status: number, problem: unknown, message?: string) {
    super(message ?? `Request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface ApiFetchInit extends RequestInit {
  /** Skip CSRF acquisition. Only for the CSRF endpoint itself. */
  skipCsrf?: boolean;
}

export async function apiFetch<T>(
  path: string,
  init: ApiFetchInit = {},
): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');

  // Only label the body as JSON when it actually is one. `apps/web`'s
  // client sets this whenever `body` is truthy, which mislabels
  // FormData and breaks multipart boundary detection — asset FILE
  // uploads in Phase 2 need that to work.
  if (typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (!SAFE_METHODS.has(method) && !init.skipCsrf) {
    headers.set('X-CSRF-Token', await ensureCsrf());
  }

  const res = await fetch(`/api/v1${path}`, {
    ...init,
    method,
    headers,
    // Same-origin cookie auth. This is the entire reason the PWA ships
    // same-origin first: it inherits the session, CSRF, the
    // XFF-sanitising proxy, IP rules, and the audit trail unchanged.
    credentials: 'include',
  });

  const contentType = res.headers.get('content-type') ?? '';
  const isProblem = contentType.includes('problem+json');
  const isJson = isProblem || contentType.includes('json');
  const body = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) throw new ApiError(res.status, body);

  return body as T;
}

/**
 * True when a failure is worth retrying: transport errors and 5xx only.
 *
 * Never retry a 401. `AuthGuard.silentRefresh` already rotates the
 * session cookie server-side on any request whose access token is
 * missing or expired, and the cookie jar reaches the API intact through
 * the `/api` proxy — so a 401 that surfaces here means the session is
 * genuinely gone (revoked, expired, user deactivated), not merely stale.
 * Retrying it would burn requests against a session that will never
 * come back. There is deliberately no client-side refresh interceptor.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status < 500) return false;
  return failureCount < 2;
}
