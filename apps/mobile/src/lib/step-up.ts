import type { StepUpFactor, StepUpStatus } from '@weavestream/shared';

/**
 * Client-side step-up (re-authentication) coordinator.
 *
 * Mirrors `apps/web/src/lib/step-up.ts`: a single host registers an
 * opener, `apiFetch` calls `requestStepUp`, and concurrent callers join
 * one in-flight prompt instead of stacking sheets.
 *
 * Two deliberate departures from the web version:
 *
 *  1. **Cancellation is registered, not assumed.** The host owns the
 *     sheet's open state and the resolver, so this module cannot close
 *     the sheet on its own. `registerStepUpOpener` therefore takes an
 *     opener *and* a canceller, and `cancelPendingStepUp()` calls the
 *     latter. That is what makes "navigating away cancels the prompt"
 *     actually work rather than leaving an invisible pending promise and
 *     a blocked request behind it.
 *  2. **This module imports nothing from the router.** The host lives
 *     inside the router tree and watches location itself, then calls
 *     `cancelPendingStepUp()`. Subscribing here would create the cycle
 *     `api → step-up → router → screens → api`.
 *
 * It also imports nothing from `./api` (raw `fetch` for the status
 * probe), because `api.ts` imports from here.
 */

type Opener = (factor: StepUpFactor) => Promise<boolean>;
type Canceller = () => void;

let opener: Opener | null = null;
let canceller: Canceller | null = null;
let pending: Promise<boolean> | null = null;
let registration = 0;

/**
 * Registered by the step-up host.
 *
 * `cancel` must resolve the host's own in-flight resolver with `false`
 * and close the sheet — the same thing its Cancel button does.
 *
 * Returns an unregister function that **only clears the registration if it
 * is still the current one**. React StrictMode mounts, unmounts and
 * remounts effects in development, so a cleanup that unconditionally
 * nulled these would run *after* the remount had already registered and
 * leave the app with no opener at all — a step-up that silently never
 * prompts.
 */
export function registerStepUpOpener(
  open: Opener | null,
  cancel: Canceller | null = null,
): () => void {
  opener = open;
  canceller = cancel;
  const token = ++registration;
  return () => {
    if (token !== registration) return;
    opener = null;
    canceller = null;
  };
}

/**
 * Whether a prompt is actually available.
 *
 * `requestStepUp` resolves `false` for two very different reasons — the
 * user declined, or there was nothing to decline because no host is
 * mounted. Callers that treat a dismissal as benign need to tell those
 * apart, or a genuinely broken step-up path reports as "user cancelled"
 * and disappears.
 */
export function hasStepUpOpener(): boolean {
  return opener !== null;
}

/** Whether a prompt is currently on screen and unresolved. */
export function hasPendingStepUp(): boolean {
  return pending !== null;
}

/**
 * Open the prompt (or join the in-flight one) and resolve to whether the
 * user completed it.
 */
export function requestStepUp(factor: StepUpFactor): Promise<boolean> {
  if (!opener) return Promise.resolve(false);
  if (!pending) {
    pending = opener(factor).finally(() => {
      // Always cleared, including on a throw or a cancellation — a
      // stranded `pending` would make every later caller await a promise
      // that will never settle.
      pending = null;
    });
  }
  return pending;
}

/**
 * Abandon the prompt on screen, resolving its waiters `false`.
 *
 * Called by the host when the route changes. A step-up prompt is a
 * response to one specific blocked request; once the user has navigated
 * elsewhere, completing it would replay a request for a screen they have
 * left. No-op when nothing is pending.
 */
export function cancelPendingStepUp(): void {
  if (pending && canceller) canceller();
}

/**
 * Ensure a valid step-up window before an action that cannot surface a
 * 403 cleanly. Checks status first to skip an unnecessary prompt.
 *
 * Best-effort by design: on any failure of the probe we fall through to
 * prompting. That is safe because the guarded endpoint re-checks step-up
 * server-side regardless, so a stale status here can never let an
 * unverified action through.
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
    status = null;
  }
  if (status?.verified) return true;
  return requestStepUp(status?.factor ?? 'password');
}
