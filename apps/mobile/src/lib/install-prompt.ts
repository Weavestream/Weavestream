/**
 * PWA install affordance plumbing (Phase 3).
 *
 * Chromium fires `beforeinstallprompt` when the app is installable —
 * often BEFORE React mounts, so the capture listener attaches at
 * module-eval time (this module is imported from the `main.tsx` graph)
 * or the event is simply missed. iOS Safari fires nothing; the More
 * tab shows Share → Add to Home Screen instructions instead. Already
 * standalone → no install UI at all.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Chrome would otherwise show its own mini-infobar at its own
    // moment; stashing the event lets the More tab own the timing.
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    notify();
  });
}

/** Re-render hook for the More tab: fires when availability changes. */
export function subscribeInstallAvailability(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function canPromptInstall(): boolean {
  return deferredPrompt !== null;
}

/**
 * Show the native install dialog (Chromium). The stashed event is
 * single-use — consumed regardless of the user's choice.
 */
export async function promptInstall(): Promise<void> {
  const prompt = deferredPrompt;
  if (!prompt) return;
  deferredPrompt = null;
  notify();
  await prompt.prompt();
  await prompt.userChoice;
}

/** Already running as an installed app (any platform). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  // iOS Safari's pre-standard signal, still the one that works there.
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * iOS/iPadOS detection for the instructions path. iPadOS 13+ reports
 * itself as "MacIntel" — the touch-point count is what gives it away.
 */
export function isIosSafariInstallTarget(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const isIos =
    /iPhone|iPad|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!isIos) return false;
  // Chrome/Firefox/Edge on iOS are Safari underneath but cannot install
  // PWAs (only Safari's Share sheet has Add to Home Screen).
  return !/CriOS|FxiOS|EdgiOS/.test(ua);
}
