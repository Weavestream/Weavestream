/**
 * Best-effort clipboard hygiene after a secret copy.
 *
 * "Best-effort" is load-bearing: a timed `clipboard.writeText('')` is
 * allowed on Chromium while the page is focused, but iOS Safari may
 * reject any clipboard write outside a user gesture, and no browser
 * runs timers while the PWA is backgrounded. So the guard (a) attempts
 * the clear at the deadline, (b) re-attempts an overdue clear the next
 * time the app becomes visible, and (c) never promises any of this in
 * the UI — the copy toast says "copied", not "will clear".
 *
 * A newer copy supersedes an older token, so copying B 50 s after A
 * doesn't wipe B at A's deadline.
 */

export const CLIPBOARD_CLEAR_MS = 60_000;

let token = 0;
let deadline: number | null = null;
let listenerInstalled = false;

function clearNow(): void {
  deadline = null;
  token += 1; // retire any still-pending timer for this copy
  // Swallowed rejection is the documented platform limitation above —
  // without a gesture some engines refuse, and there is nothing useful
  // to do or say when they do.
  void navigator.clipboard?.writeText('').catch(() => {});
}

function onVisible(): void {
  if (document.visibilityState !== 'visible') return;
  if (deadline !== null && Date.now() >= deadline) clearNow();
}

export function scheduleClipboardClear(ms: number = CLIPBOARD_CLEAR_MS): void {
  const mine = ++token;
  deadline = Date.now() + ms;

  if (!listenerInstalled) {
    listenerInstalled = true;
    document.addEventListener('visibilitychange', onVisible);
  }

  setTimeout(() => {
    // Superseded by a newer copy (or already cleared on visibility).
    if (mine !== token) return;
    clearNow();
  }, ms);
}

const NOTICE_KEY = 'ws_m_clipboard_notice_v1';

/**
 * One-time "copied values may sync to your other Apple devices" notice
 * (iOS Universal Clipboard). Returns true exactly once per install and
 * marks the flag; storage failures (private mode) just skip the notice
 * rather than nagging on every copy. The flag is metadata, not a
 * secret — persisting it is fine.
 */
export function consumeUniversalClipboardNotice(): boolean {
  try {
    if (window.localStorage.getItem(NOTICE_KEY)) return false;
    window.localStorage.setItem(NOTICE_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

/** Test-only: reset module state between cases. */
export function resetClipboardGuardForTests(): void {
  token += 1;
  deadline = null;
  if (listenerInstalled) {
    document.removeEventListener('visibilitychange', onVisible);
    listenerInstalled = false;
  }
}
