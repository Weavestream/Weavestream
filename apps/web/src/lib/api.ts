'use client';

import { ensureCsrf } from './csrf';
import { isStepUpProblem, requestStepUp } from './step-up';

export async function apiFetch<T>(
  path: string,
  // `__stepUpRetried` is internal bookkeeping for the step-up retry — it
  // is destructured out below and never forwarded to `fetch`.
  init: RequestInit & { __stepUpRetried?: boolean } = {},
): Promise<{ ok: boolean; status: number; data: T | null; problem?: unknown }> {
  const { __stepUpRetried, ...reqInit } = init;
  const method = (reqInit.method ?? 'GET').toUpperCase();
  const headers = new Headers(reqInit.headers);
  headers.set('Accept', 'application/json');
  if (reqInit.body) headers.set('Content-Type', 'application/json');

  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const token = await ensureCsrf();
    headers.set('X-CSRF-Token', token);
  }

  try {
    const res = await fetch(`/api/v1${path}`, {
      ...reqInit,
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

    // Step-up interception: a sensitive route answers 403 with a
    // distinguishable `code: 'step_up_required'`. Prompt once (shared
    // across concurrent calls via the coordinator), then retry the
    // original request a single time. Only replayable bodies are
    // retried — `undefined` or a `string` (our JSON call sites); a
    // consumed stream / FormData / Blob is left to surface the 403.
    if (
      res.status === 403 &&
      isStepUpProblem(problem) &&
      !__stepUpRetried &&
      (reqInit.body === undefined || typeof reqInit.body === 'string')
    ) {
      const completed = await requestStepUp(problem.factor ?? 'password');
      if (completed) {
        return apiFetch<T>(path, { ...init, __stepUpRetried: true });
      }
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
