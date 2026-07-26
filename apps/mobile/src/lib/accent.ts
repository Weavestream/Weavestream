import { parseUiCookie, UI_COOKIE_NAME } from '@weavestream/shared';
import { readBrowserCookie } from '@weavestream/shared/browser';

/**
 * Re-sync `data-accent` from the `ws_ui` cookie after hydration.
 *
 * This is the *fallback and refresh* path, not the primary one. The `/m`
 * route handler already serves an accent-specific shell variant, so first
 * paint is correct and this normally finds nothing to change. It earns
 * its keep in two cases:
 *
 *  - A future Capacitor build loads `index.html` off the filesystem with
 *    no route handler in front of it, so the bundled default-accent
 *    variant is what ships. One frame of the wrong accent is the right
 *    trade there.
 *  - The user changed their accent on desktop in another tab; this picks
 *    it up on next focus without a hard reload.
 *
 * Deliberately NOT a substitute for the server-side stamp: module
 * scripts are deferred, so doing this alone would flash the default
 * accent on every launch of the app's primary surface.
 */
export function syncAccentFromCookie(): void {
  // `readBrowserCookie` percent-decodes. That matters: Express encodes on
  // write, so `document.cookie` holds `t%3Ddark%3Ba%3Diris`, and
  // `parseUiCookie` would silently fall back to defaults on the raw form.
  const prefs = parseUiCookie(readBrowserCookie(UI_COOKIE_NAME));
  const root = document.documentElement;
  if (root.dataset.accent !== prefs.uiAccent) {
    root.dataset.accent = prefs.uiAccent;
  }
}

/**
 * Keep the accent fresh across tab focus. Returns a teardown function.
 */
export function watchAccent(): () => void {
  const onVisible = () => {
    if (document.visibilityState === 'visible') syncAccentFromCookie();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => document.removeEventListener('visibilitychange', onVisible);
}
