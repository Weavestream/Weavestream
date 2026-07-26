import {
  DEFAULT_UI_ACCENT,
  DEFAULT_UI_THEME,
  uiAccentValues,
  uiThemeValues,
  type UiAccent,
  type UiTheme,
} from './schemas/ui-preferences.js';

/**
 * The `ws_ui` cookie's wire format — one implementation, four consumers.
 *
 * The API writes this cookie on login and on every `PATCH /me/preferences`;
 * it is deliberately NOT HttpOnly so the browser can read it too. Consumers:
 *
 *   - `apps/api` writes it (`auth/cookies.ts`) and reads the accent back
 *     when an unauthenticated theme toggle must not clobber it
 *     (`ui/ui.controller.ts`).
 *   - `apps/web`'s root layout reads it during SSR so `data-theme` /
 *     `data-accent` are correct on the very first byte, without blocking
 *     on `/auth/me`.
 *   - `apps/mobile`'s build stamps one shell variant per accent, and the
 *     `/m` route handler picks between them per request.
 *
 * It lived in three hand-rolled copies before this (an encoder in the API,
 * a `/a=([a-z]+)/` regex in the API's UI controller, and a parser in the
 * web app). Format drift between them would have been invisible until a
 * user's accent silently reset, so they share this module now.
 *
 * Format is `t=<theme>;a=<accent>`, e.g. `t=dark;a=iris`. Unknown values
 * degrade to the baseline defaults rather than throwing — a garbled cookie
 * is cosmetic and must never 500 a layout.
 *
 * NOTE for browser callers: `document.cookie` returns the value still
 * percent-encoded (Express encodes on write), so decode before calling
 * `parseUiCookie`. `readBrowserCookie` from `@weavestream/shared/browser`
 * does that for you. Server-side readers (`next/headers`, cookie-parser)
 * decode already.
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
 * Resolve `system` → `dark` for SSR. The `prefers-color-scheme` block in
 * the token stylesheet flips to light before first paint when the OS
 * prefers it, so defaulting to dark here is safe — the mismatch window is
 * one pre-hydration frame and is handled purely in CSS.
 */
export function resolveSsrTheme(prefs: UiPreferences): 'dark' | 'light' {
  return prefs.uiTheme === 'light' ? 'light' : 'dark';
}
