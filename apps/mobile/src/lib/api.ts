import { isStepUpProblem } from '@weavestream/shared';
import { ensureCsrf } from '@weavestream/shared/browser';
import { hasStepUpOpener, requestStepUp } from './step-up';

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

/**
 * The user was asked to re-authenticate and declined (or navigated away).
 *
 * A distinct type because `apps/web`'s equivalent signal is a
 * `stepUpCancelled` flag on its returned envelope, and this client throws
 * instead of returning — so without a type of its own, "you chose not to
 * do this" would be indistinguishable from "the server refused you", and
 * every reveal button would show an error toast for a deliberate Cancel.
 *
 * Still a 403 `ApiError`, so anything that only looks at `status` (the
 * retry predicate, the 401 handler) keeps behaving correctly.
 */
export class StepUpCancelledError extends ApiError {
  constructor(problem: unknown) {
    super(403, problem, 'Step-up authentication was cancelled');
    this.name = 'StepUpCancelledError';
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface ApiFetchInit extends RequestInit {
  /** Skip CSRF acquisition. Only for the CSRF endpoint itself. */
  skipCsrf?: boolean;
  /**
   * Internal. Set on the single replay after a completed step-up so a
   * server that answers `step_up_required` twice cannot loop.
   */
  stepUpRetried?: boolean;
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
    // Threading the signal makes the acquisition abortable too — it
    // runs BEFORE the request it protects, so without this a caller's
    // abort (Ask's Stop during conversation-create) couldn't cancel a
    // stalled CSRF fetch. The AbortError rethrows unchanged, per this
    // client's contract.
    headers.set('X-CSRF-Token', await ensureCsrf(init.signal ?? undefined));
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

  // Step-up: the server is not refusing the caller, it is asking them to
  // re-authenticate. Prompt, then replay the request once.
  //
  // Only a replayable body is retried. `undefined` and `string` can be
  // sent twice; a `FormData`, `Blob` or stream has already been consumed
  // by the first attempt, so replaying it would send an empty body — the
  // 403 surfaces instead, which is the honest outcome.
  if (
    res.status === 403 &&
    isStepUpProblem(body) &&
    !init.stepUpRetried &&
    (init.body === undefined || typeof init.body === 'string')
  ) {
    const prompted = hasStepUpOpener();
    const completed = await requestStepUp(body.factor ?? 'password');
    if (completed) {
      return apiFetch<T>(path, { ...init, stepUpRetried: true });
    }
    // Distinguish "declined" from "there was no prompt to decline" — the
    // latter is a broken step-up path and must not be reported as a user
    // choice.
    if (prompted) throw new StepUpCancelledError(body);
  }

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

/**
 * An access denial on a record the user can otherwise reach — e.g. a
 * password's `restrictedToUserIds`, or any future per-record gate. The
 * server sends a plain 403 with no stable code, so this is "403 that is
 * neither a step-up demand nor the user declining one". (CLIENT_USERs
 * get a 404 instead — deliberately no existence oracle — which surfaces
 * as the generic not-found state.)
 *
 * Lives here rather than in a feature folder because passwords and
 * articles both branch on it, and features must not import from each
 * other.
 */
export function isRestrictedError(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 403) return false;
  if (err instanceof StepUpCancelledError) return false;
  return !isStepUpProblem(err.problem);
}
