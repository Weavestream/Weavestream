import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, StepUpCancelledError } from '../../lib/api';
import { redirectToLogin } from '../../lib/navigate';
import { useToast } from '../../components/Toast';
import { isReasonRequired, isRestrictedError, revealPassword } from './api';
import { consumeUniversalClipboardNotice } from './clipboard-guard';
import { copySecret } from './copy';

/** Desktop parity (`password-reveal-field.tsx`): revealed plaintext auto-hides. */
export const REVEAL_AUTO_HIDE_MS = 30_000;

interface SheetState {
  action: 'view' | 'copy';
  busy: boolean;
  error: string | null;
}

/**
 * The detail screen's reveal/copy state machine.
 *
 * Secret residency: the revealed plaintext lives ONLY in this hook's
 * state — never in React Query, never in storage — and is cleared on
 * auto-hide (30 s), window blur, `visibilitychange → hidden`, unmount,
 * and `resetKey` change (wired to `updatedAt`, so an edit flushes the
 * stale plaintext).
 *
 * Reason flow: pre-emptive sheet when `requireReason` is known (a
 * reveal without a reason is a guaranteed, audited 400), reactive on a
 * `ReasonRequired` response. For a copy action the sheet's submit tap
 * IS the clipboard gesture — `submitReason` starts `copySecret`
 * synchronously.
 */
export function useReveal({
  companyId,
  passwordId,
  requireReason,
  resetKey,
}: {
  companyId: string | null;
  passwordId: string;
  requireReason: boolean;
  resetKey: string;
}) {
  const toast = useToast();
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [, setRepaint] = useState(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const hide = useCallback(() => {
    setPlaintext(null);
    setExpiresAt(0);
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    if (tickTimer.current !== null) {
      clearInterval(tickTimer.current);
      tickTimer.current = null;
    }
  }, []);

  function show(value: string) {
    setPlaintext(value);
    setExpiresAt(Date.now() + REVEAL_AUTO_HIDE_MS);
    if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(hide, REVEAL_AUTO_HIDE_MS);
    if (tickTimer.current === null) {
      tickTimer.current = setInterval(() => setRepaint((n) => n + 1), 1000);
    }
  }

  // Blur/background/unmount clear the plaintext (handoff:
  // `revealedFieldIds` clear on blur/background).
  useEffect(() => {
    function onHidden() {
      if (document.hidden) hide();
    }
    window.addEventListener('blur', hide);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('blur', hide);
      document.removeEventListener('visibilitychange', onHidden);
      hide();
    };
  }, [hide]);

  // An edit rotated the record under us — cached plaintext is stale.
  // `hide` is a stable useCallback; `resetKey` is the real trigger.
  useEffect(() => {
    hide();
  }, [resetKey, hide]);

  function routeError(err: unknown, pending: 'view' | 'copy'): void {
    if (err instanceof StepUpCancelledError) return;
    if (err instanceof ApiError && err.status === 401) {
      // Imperative call — the query-cache 401 handler never sees it.
      redirectToLogin();
      return;
    }
    if (isReasonRequired(err)) {
      setSheet({ action: pending, busy: false, error: null });
      return;
    }
    if (isRestrictedError(err)) {
      toast.push('You don’t have access to this credential.', 'danger');
      return;
    }
    toast.push(
      pending === 'copy' ? 'Couldn’t copy password.' : 'Couldn’t reveal password.',
      'danger',
    );
  }

  function reveal(reason?: string): Promise<boolean> {
    if (companyId === null) return Promise.resolve(false);
    setBusy(true);
    return revealPassword(companyId, passwordId, reason ? { reason } : undefined)
      .then((res) => {
        show(res.password);
        return true;
      })
      .catch((err: unknown) => {
        routeError(err, 'view');
        return false;
      })
      .finally(() => setBusy(false));
  }

  /** Copy path; must run synchronously inside a tap handler. */
  function copy(reason?: string): Promise<boolean> {
    if (companyId === null) return Promise.resolve(false);
    return copySecret({
      cached: plaintext,
      fetch: () =>
        revealPassword(companyId, passwordId, reason ? { reason } : undefined).then(
          (r) => r.password,
        ),
    }).then((result) => {
      if (result.ok) {
        toast.push('Password copied', 'ok');
        if (consumeUniversalClipboardNotice()) {
          toast.push('Copied values may sync to your other Apple devices (Universal Clipboard).');
        }
        return true;
      }
      if (result.error != null) routeError(result.error, 'copy');
      else toast.push('Couldn’t copy password.', 'danger');
      return false;
    });
  }

  function toggleReveal() {
    if (plaintext !== null) {
      hide();
      return;
    }
    if (requireReason) {
      setSheet({ action: 'view', busy: false, error: null });
      return;
    }
    void reveal();
  }

  function copyTap() {
    // A held plaintext short-circuits everything — including the
    // reason prompt: the audited reveal already happened.
    if (plaintext === null && requireReason) {
      setSheet({ action: 'copy', busy: false, error: null });
      return;
    }
    void copy();
  }

  function submitReason(reason: string) {
    if (!sheet) return;
    const { action } = sheet;
    setSheet({ action, busy: true, error: null });
    // For 'copy' this chain starts copySecret synchronously in the
    // submit tap — the gesture the clipboard write needs.
    const run = action === 'copy' ? copy(reason) : reveal(reason);
    void run.then((ok) => {
      if (ok) setSheet(null);
      else {
        setSheet((s) =>
          s ? { ...s, busy: false, error: 'Couldn’t complete. Try again.' } : s,
        );
      }
    });
  }

  const remainingS = plaintext
    ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
    : 0;

  return {
    plaintext,
    remainingS,
    busy,
    sheet,
    toggleReveal,
    copyTap,
    submitReason,
    closeSheet: () => setSheet(null),
    hideNow: hide,
  };
}
