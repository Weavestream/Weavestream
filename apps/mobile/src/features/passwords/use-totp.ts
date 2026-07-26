import { useCallback, useEffect, useRef, useState } from 'react';
import type { PasswordTotpResponse } from '@weavestream/shared';
import { ApiError } from '../../lib/api';
import { redirectToLogin } from '../../lib/navigate';
import { fetchTotpCode } from './api';

/**
 * One-time-code state for the detail screen. Ported from desktop's
 * `totp-code.tsx` timing model, with the visibility handling the
 * mobile build plan demands:
 *
 *  - NOT interval polling. One request per code window: the refetch is
 *    scheduled for `validUntil - now + 200ms` (server clock wins — a
 *    drifting device clock must not desync the rotation), and a
 *    separate 500 ms tick only repaints the countdown.
 *  - `document.hidden` clears both timers — a backgrounded detail
 *    screen must not burn the 60/min throttle or the battery.
 *  - On return: if the held code is still inside its window, resume
 *    the tick and re-schedule — **no request**. Fetch immediately only
 *    when the code expired while hidden.
 */
/** Retry cadence after a failed code fetch (well inside the 60/min budget). */
const RETRY_MS = 5_000;

export function useTotpCode({
  companyId,
  passwordId,
  enabled,
}: {
  companyId: string | null;
  passwordId: string;
  enabled: boolean;
}) {
  const [data, setData] = useState<PasswordTotpResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [, setRepaint] = useState(0);

  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const latest = useRef<PasswordTotpResponse | null>(null);

  const clearTimers = useCallback(() => {
    if (refetchTimer.current !== null) {
      clearTimeout(refetchTimer.current);
      refetchTimer.current = null;
    }
    if (tickTimer.current !== null) {
      clearInterval(tickTimer.current);
      tickTimer.current = null;
    }
  }, []);

  useEffect(() => {
    if (!enabled || companyId === null) {
      clearTimers();
      setData(null);
      latest.current = null;
      return;
    }

    let disposed = false;
    // In-flight dedupe, scoped to THIS effect run on purpose: a hide →
    // return while a request is pending must not start a second one
    // (both completions would arm timers, and only the latest is
    // tracked — the orphan keeps firing as a duplicate polling chain).
    // A closure variable rather than a ref so a passwordId change
    // can't inherit the old request's flag and swallow the new
    // record's first fetch.
    let inFlight = false;

    function startTick() {
      if (tickTimer.current === null) {
        tickTimer.current = setInterval(() => setRepaint((n) => n + 1), 500);
      }
    }

    function scheduleRefetch(res: PasswordTotpResponse) {
      // Defensive: never orphan a pending timer by overwriting the ref.
      if (refetchTimer.current !== null) clearTimeout(refetchTimer.current);
      const ms = Math.max(500, Date.parse(res.validUntil) - Date.now() + 200);
      refetchTimer.current = setTimeout(() => void load(), ms);
    }

    async function load() {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetchTotpCode(companyId!, passwordId);
        if (disposed) return;
        latest.current = res;
        setData(res);
        setFailed(false);
        // Timers arm only while visible — a request that RESOLVES in
        // the background must not restart the repaint interval or the
        // refetch chain; the visibility handler owns resume.
        if (!document.hidden) {
          startTick();
          scheduleRefetch(res);
        }
      } catch (err) {
        if (disposed) return;
        // Imperative call — the query-cache 401 handler never sees it.
        if (err instanceof ApiError && err.status === 401) {
          redirectToLogin();
          return;
        }
        // Drop the held code: it has (or is about to have) expired, and
        // keeping it on screen means offering a copyable code that no
        // longer works. The row shows its failed state instead, and a
        // bounded retry re-arms while visible (the visibility handler
        // owns resume after backgrounding).
        latest.current = null;
        setData(null);
        setFailed(true);
        if (!document.hidden) {
          if (refetchTimer.current !== null) clearTimeout(refetchTimer.current);
          refetchTimer.current = setTimeout(() => void load(), RETRY_MS);
        }
      } finally {
        inFlight = false;
      }
    }

    function onVisibility() {
      if (document.hidden) {
        clearTimers();
        return;
      }
      const held = latest.current;
      if (held && Date.parse(held.validUntil) > Date.now()) {
        // Still valid: repaint + re-arm, zero requests.
        startTick();
        scheduleRefetch(held);
      } else {
        void load();
      }
    }

    document.addEventListener('visibilitychange', onVisibility);
    void load();

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimers();
    };
  }, [companyId, passwordId, enabled, clearTimers]);

  const now = Date.now();
  const validUntilMs = data ? Date.parse(data.validUntil) : 0;
  const remainingS = data ? Math.max(0, Math.ceil((validUntilMs - now) / 1000)) : 0;
  // Fills as time runs out, matching desktop's ring.
  const progress = data ? Math.min(1, Math.max(0, 1 - remainingS / data.period)) : 0;

  return { code: data?.code ?? null, remainingS, progress, failed };
}
