import { useLocation } from '@tanstack/react-router';
import type { StepUpFactor } from '@weavestream/shared';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, apiFetch } from '../lib/api';
import {
  cancelPendingStepUp,
  hasPendingStepUp,
  registerStepUpOpener,
} from '../lib/step-up';
import { Sheet } from './Sheet';
import { Button, Field, Input } from './primitives';
import { ErrorBanner } from './states';

/**
 * Hosts the step-up prompt and owns its resolver.
 *
 * Mounted once in the tab layout. Because it is persistent, a route
 * change does **not** unmount it — so cancellation on navigation has to
 * be explicit, which is what the location effect below does. The
 * coordinator (`lib/step-up.ts`) deliberately knows nothing about the
 * router; it just calls back into the canceller registered here.
 */
export function StepUpHost() {
  const location = useLocation();
  const [factor, setFactor] = useState<StepUpFactor | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resolveRef = useRef<((ok: boolean) => void) | null>(null);

  /** Resolve the in-flight prompt exactly once and close. */
  const settle = useCallback((ok: boolean) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setFactor(null);
    setCode('');
    setError(null);
    setBusy(false);
    resolve?.(ok);
  }, []);

  useEffect(() => {
    const unregister = registerStepUpOpener(
      (nextFactor) =>
        new Promise<boolean>((resolve) => {
          resolveRef.current = resolve;
          setFactor(nextFactor);
          setCode('');
          setError(null);
        }),
      () => settle(false),
    );

    return () => {
      unregister();
      // Settle anything still waiting.
      //
      // Unregistering alone leaves a pending resolver stranded: the request
      // that triggered the prompt would await a promise nobody will ever
      // resolve, and because the coordinator's `pending` never clears,
      // *every later* step-up would join that dead promise too. The host
      // can unmount with a prompt open — a hard navigation, or the session
      // gate flipping to its error branch — so this is reachable.
      //
      // Resolving the ref directly rather than through `settle` on purpose:
      // this runs during teardown, where the state updates `settle` performs
      // are pointless, and the resolution is the part that matters.
      const resolve = resolveRef.current;
      resolveRef.current = null;
      resolve?.(false);
    };
  }, [settle]);

  // Navigation abandons the prompt. A step-up challenge answers one
  // specific blocked request; once the user is on another screen,
  // completing it would replay a request for a screen they left.
  const pathname = location.pathname;
  useEffect(() => {
    if (hasPendingStepUp()) cancelPendingStepUp();
    // Keyed on the path only, deliberately: opening or closing a sheet via
    // a search param is not leaving the screen, and cancelling a prompt
    // because the org sheet opened behind it would be wrong.
  }, [pathname]);

  const isMfa = factor === 'mfa';

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await apiFetch('/auth/step-up/verify', {
        method: 'POST',
        // Trim an MFA code, send a password VERBATIM. Leading and
        // trailing spaces are significant in a password, and trimming
        // here would reject one that plain login accepts.
        body: JSON.stringify({ code: isMfa ? code.trim() : code }),
      });
      settle(true);
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.status === 429) {
        setError('Too many attempts. Wait a moment and try again.');
        return;
      }
      const detail =
        err instanceof ApiError &&
        typeof (err.problem as { detail?: unknown } | null)?.detail === 'string'
          ? ((err.problem as { detail: string }).detail)
          : null;
      setError(detail ?? 'Verification failed. Try again.');
    }
  }

  return (
    <Sheet
      open={factor !== null}
      onClose={() => settle(false)}
      title="Confirm it’s you"
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-5">
        <Field
          label={isMfa ? 'Authentication code' : 'Password'}
          htmlFor="step-up-code"
        >
          <Input
            id="step-up-code"
            type={isMfa ? 'text' : 'password'}
            inputMode={isMfa ? 'numeric' : undefined}
            autoComplete={isMfa ? 'one-time-code' : 'current-password'}
            autoCapitalize="none"
            mono={isMfa}
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>

        {error && <ErrorBanner title={error} />}

        <Button type="submit" disabled={busy || code.length === 0}>
          {busy ? 'Confirming…' : 'Confirm'}
        </Button>
        <Button kind="secondary" type="button" onClick={() => settle(false)}>
          Cancel
        </Button>
      </form>
    </Sheet>
  );
}
