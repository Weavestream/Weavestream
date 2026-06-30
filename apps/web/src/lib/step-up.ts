'use client';

import type { StepUpFactor, StepUpStatus } from '@weavestream/shared';

/**
 * Client-side step-up (re-authentication) coordinator.
 *
 * A single `<StepUpProvider>` mounted at the app root registers an
 * `opener` here; `apiFetch` and the download buttons call
 * `requestStepUp` / `ensureStepUp` to drive one shared modal. The
 * promise-based design mirrors an axios refresh interceptor: concurrent
 * callers join a single in-flight prompt rather than stacking modals.
 *
 * This module deliberately does NOT import `./api` (it uses a raw fetch
 * for the status check) so there's no import cycle with `apiFetch`,
 * which imports from here.
 */

type Opener = (factor: StepUpFactor) => Promise<boolean>;

let opener: Opener | null = null;
let pending: Promise<boolean> | null = null;

/** Registered once by `<StepUpProvider>`; cleared on unmount. */
export function registerStepUpOpener(fn: Opener | null): void {
  opener = fn;
}

/**
 * Open the step-up modal (or join the in-flight one) and resolve to
 * whether the user completed it. Concurrent callers share a single
 * prompt — essential when a page fires several blocked requests at once.
 */
export function requestStepUp(factor: StepUpFactor): Promise<boolean> {
  if (!opener) return Promise.resolve(false);
  if (!pending) {
    pending = opener(factor).finally(() => {
      pending = null;
    });
  }
  return pending;
}

/** Narrows an RFC-7807 problem body to the step-up-required challenge. */
export function isStepUpProblem(
  problem: unknown,
): problem is { code: 'step_up_required'; factor?: StepUpFactor } {
  return (
    typeof problem === 'object' &&
    problem !== null &&
    (problem as { code?: unknown }).code === 'step_up_required'
  );
}

/**
 * Ensure a valid step-up window before a plain-navigation download
 * (which can't surface a 403 cleanly). Checks current status first to
 * skip an unnecessary prompt, then challenges if needed. Returns whether
 * the window is open afterwards.
 */
export async function ensureStepUp(): Promise<boolean> {
  let status: StepUpStatus | null = null;
  try {
    const res = await fetch('/api/v1/auth/step-up', {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
    if (res.ok) {
      status = (await res.json().catch(() => null)) as StepUpStatus | null;
    }
  } catch {
    // Best-effort: the status lookup is only an optimisation to skip an
    // unnecessary prompt. On any failure we leave `status` null and fall
    // through to prompting. This is safe because the download endpoint
    // re-checks step-up server-side regardless — a missed/stale status
    // here can never let an unverified download through.
    status = null;
  }
  if (status?.verified) return true;
  return requestStepUp(status?.factor ?? 'password');
}

/**
 * Run a guarded file download: ensure step-up, then trigger a native
 * same-origin GET navigation (cookies ride along; the download endpoint
 * re-checks step-up server-side). Kept as a native navigation because
 * these payloads (raw DB dumps, vault PDFs) can be large.
 */
export async function downloadWithStepUp(
  href: string,
  filename?: string,
): Promise<void> {
  const ok = await ensureStepUp();
  if (!ok) return;
  const a = document.createElement('a');
  a.href = href;
  if (filename) a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
