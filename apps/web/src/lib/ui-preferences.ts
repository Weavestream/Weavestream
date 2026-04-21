import {
  DEFAULT_UI_ACCENT,
  DEFAULT_UI_THEME,
  uiAccentValues,
  uiThemeValues,
  type UiAccent,
  type UiTheme,
} from '@weavestream/shared';

/**
 * Phase 9b.1 — parse the non-HttpOnly `ws_ui` cookie the API writes on
 * login and on every `PATCH /me/preferences`. The cookie is the single
 * source of truth for the root-layout's SSR paint: it lets us render
 * `data-theme` / `data-accent` correctly on the very first byte without
 * blocking on `/auth/me`, which would double the TTFB on the homepage
 * and still leave the login shell without a theme.
 *
 * Format is `t=<theme>;a=<accent>`, e.g. `t=dark;a=iris`. We tolerate
 * unknown values by falling back to the baseline defaults rather than
 * throwing — a garbled cookie should degrade gracefully, not 500 the
 * layout.
 */

export const UI_COOKIE_NAME = 'ws_ui';

export interface UiPreferences {
  uiTheme: UiTheme;
  uiAccent: UiAccent;
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  uiTheme: DEFAULT_UI_THEME,
  uiAccent: DEFAULT_UI_ACCENT,
};

export function parseUiCookie(raw: string | undefined | null): UiPreferences {
  if (!raw) return DEFAULT_UI_PREFERENCES;
  let theme: UiTheme = DEFAULT_UI_THEME;
  let accent: UiAccent = DEFAULT_UI_ACCENT;
  for (const part of raw.split(';')) {
    const [k, v] = part.trim().split('=');
    if (!v) continue;
    if (k === 't' && (uiThemeValues as readonly string[]).includes(v)) {
      theme = v as UiTheme;
    } else if (k === 'a' && (uiAccentValues as readonly string[]).includes(v)) {
      accent = v as UiAccent;
    }
  }
  return { uiTheme: theme, uiAccent: accent };
}

export function encodeUiCookie(prefs: UiPreferences): string {
  return `t=${prefs.uiTheme};a=${prefs.uiAccent}`;
}

/**
 * Resolve `system` → `dark` for SSR. The nonced inline script in the
 * layout flips to `light` before first paint if the OS prefers it — so
 * SSR defaulting to dark is safe because the mismatch window is one
 * pre-hydration frame.
 */
export function resolveSsrTheme(prefs: UiPreferences): 'dark' | 'light' {
  return prefs.uiTheme === 'light' ? 'light' : 'dark';
}
