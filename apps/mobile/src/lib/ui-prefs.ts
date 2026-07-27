import {
  parseUiCookie,
  UI_COOKIE_NAME,
  type UiPreferences,
  type UiTheme,
} from '@weavestream/shared';
import {
  readBrowserCookie,
  writeUiBrowserCookie,
} from '@weavestream/shared/browser';

/**
 * Theme + accent plumbing for the mobile app (grew out of Phase 0's
 * accent-only `accent.ts` when Phase 4 added dark mode).
 *
 * Layered, from first paint outward:
 *
 *  1. The `/m` route handler serves a shell variant pre-stamped with
 *     `data-theme` / `data-theme-pref` / `data-accent` from the `ws_ui`
 *     cookie, so first paint is correct with zero JS. The cookie-sync
 *     here is the *fallback and refresh* path, not the primary one. It
 *     earns its keep in three cases:
 *       - dev, where the raw `index.html` still carries placeholders;
 *       - a future Capacitor build loading `index.html` off the
 *         filesystem with no route handler in front of it;
 *       - the user changed a preference in another same-device tab —
 *         picked up on next focus without a hard reload.
 *  2. `applyServerUiPrefs` closes the cross-device gap: `ws_ui` is
 *     per-browser and only written by the API on login and preference
 *     changes, so a phone never hears about an accent/theme changed on
 *     the desktop. `/auth/me` returns the account's preferences; on app
 *     boot they are applied, written back into this browser's cookie
 *     (the server's cookie helper documents `ws_ui` as deliberately
 *     non-HttpOnly for exactly this kind of same-page writer), and the
 *     service worker is asked to re-pin the canonical offline shell so
 *     an immediately-offline restart boots with the right stamp.
 *  3. `watchUiPrefs` keeps a long-lived session honest: cookie re-sync
 *     on tab focus, and an OS color-scheme listener that re-resolves
 *     `data-theme` while the preference is `system` (desktop parity
 *     with its ThemePreferenceWatcher).
 *
 * `data-theme` always holds the *resolved* theme ('dark' | 'light');
 * `data-theme-pref` holds the raw preference including 'system'. The
 * shared token stylesheets key dark-as-default off `:root`, light off
 * `[data-theme='light']`, and system off a `prefers-color-scheme`
 * media block — the same contract as desktop SSR.
 */

function resolveClientTheme(pref: UiTheme): 'dark' | 'light' {
  if (pref === 'system') {
    return typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark';
  }
  return pref;
}

/**
 * Collapse the shell's two media-qualified `theme-color` metas into one
 * and point it at the live `--bg`. The stamped pair exists for first
 * paint only; once JS runs, a single meta tracking the computed token
 * follows every theme/accent apply and OS flip without duplicating the
 * palette hexes in TS.
 */
function updateThemeColorMeta(): void {
  if (typeof document === 'undefined') return;
  const metas = Array.from(
    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
  );
  let primary = metas[0] ?? null;
  for (const extra of metas.slice(1)) extra.remove();
  if (!primary) {
    primary = document.createElement('meta');
    primary.name = 'theme-color';
    document.head.appendChild(primary);
  }
  primary.removeAttribute('media');
  const bg = getComputedStyle(document.documentElement)
    .getPropertyValue('--bg')
    .trim();
  if (bg) primary.content = bg;
}

/**
 * Apply preferences to the DOM: the three `<html>` data attributes plus
 * the theme-color meta. Diffs before writing so a no-change call never
 * churns attributes.
 */
export function applyUiPrefs(prefs: UiPreferences): void {
  const root = document.documentElement;
  const resolved = resolveClientTheme(prefs.uiTheme);
  if (root.dataset.accent !== prefs.uiAccent) {
    root.dataset.accent = prefs.uiAccent;
  }
  if (root.dataset.themePref !== prefs.uiTheme) {
    root.dataset.themePref = prefs.uiTheme;
  }
  if (root.dataset.theme !== resolved) {
    root.dataset.theme = resolved;
  }
  updateThemeColorMeta();
}

/**
 * Ask the service worker to re-pin the canonical offline shell. The
 * pinned copy otherwise refreshes only at install or on a successful
 * HTML navigation — a preference change is neither, and without this
 * an immediately-offline restart would boot the old-stamped theme.
 * Fire-and-forget: failure keeps the previous copy (sw.ts swallows it).
 */
function refreshCanonicalShell(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }
  navigator.serviceWorker.controller?.postMessage({
    type: 'refresh-canonical',
  });
}

/**
 * Sync the account's preferences (from `/auth/me`) into this browser.
 * Applies to the DOM unconditionally (idempotent); rewrites the cookie
 * and re-pins the offline shell only when the cookie actually
 * disagreed, so a normal boot with a fresh cookie does no extra work.
 */
export function applyServerUiPrefs(prefs: UiPreferences): void {
  const cookie = parseUiCookie(readBrowserCookie(UI_COOKIE_NAME));
  const changed =
    cookie.uiTheme !== prefs.uiTheme || cookie.uiAccent !== prefs.uiAccent;
  applyUiPrefs(prefs);
  if (changed) {
    writeUiBrowserCookie(prefs);
    refreshCanonicalShell();
  }
}

/**
 * Persist a preference chosen *in this app* (the Appearance sheet):
 * DOM + cookie + shell re-pin, unconditionally — the caller already
 * knows it changed. The server also rewrites the cookie on the PATCH
 * response; writing it here too keeps the pair atomic from the app's
 * point of view even if the PATCH later fails and is rolled back by
 * the sheet.
 */
export function persistLocalUiPrefs(prefs: UiPreferences): void {
  applyUiPrefs(prefs);
  writeUiBrowserCookie(prefs);
  refreshCanonicalShell();
}

/** Cookie → DOM. Pre-mount boot correction + focus re-sync. */
export function syncUiFromCookie(): void {
  // `readBrowserCookie` percent-decodes; `parseUiCookie` degrades
  // garbage to the defaults rather than throwing — a junk cookie is
  // cosmetic and must never blank the app pre-mount.
  applyUiPrefs(parseUiCookie(readBrowserCookie(UI_COOKIE_NAME)));
}

/**
 * Keep preferences fresh across tab focus and OS theme flips. Returns
 * a teardown function.
 */
export function watchUiPrefs(): () => void {
  const onVisible = () => {
    if (document.visibilityState === 'visible') syncUiFromCookie();
  };
  document.addEventListener('visibilitychange', onVisible);

  // Only meaningful while the preference is `system`: the CSS media
  // block flips the palette on its own, but `data-theme`, the logo
  // switch, and the theme-color meta are attribute-driven and need the
  // nudge (desktop parity with ThemePreferenceWatcher).
  let mql: MediaQueryList | null = null;
  const onSchemeChange = () => {
    if (document.documentElement.dataset.themePref === 'system') {
      const resolved = resolveClientTheme('system');
      if (document.documentElement.dataset.theme !== resolved) {
        document.documentElement.dataset.theme = resolved;
      }
      updateThemeColorMeta();
    }
  };
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    mql = window.matchMedia('(prefers-color-scheme: light)');
    mql.addEventListener('change', onSchemeChange);
  }

  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    mql?.removeEventListener('change', onSchemeChange);
  };
}
