import {
  DEFAULT_UI_ACCENT,
  DEFAULT_UI_THEME,
  uiAccentValues,
  uiThemeValues,
  type UiPreferences,
} from '@weavestream/shared';

/**
 * Map cookie preferences onto a mobile shell variant filename stem.
 *
 * The publisher (`apps/mobile/scripts/emit-to-web.mjs`) stamps one shell
 * per `{accent}-{themePref}` pair, and the `/m` route handler picks one
 * by this key — a lookup into a closed set generated from compile-time
 * enums, never string substitution of request data into HTML
 * (CLAUDE.md §3).
 *
 * `parseUiCookie` already degrades unknown values to the defaults, but
 * this validates against the enums again on purpose: the key becomes a
 * filename, and defense-in-depth at the filesystem boundary is worth
 * two array lookups (mirrors the old `isAccent` check in the handler).
 */
export function shellKeyFor(prefs: UiPreferences): string {
  const accent = (uiAccentValues as readonly string[]).includes(prefs.uiAccent)
    ? prefs.uiAccent
    : DEFAULT_UI_ACCENT;
  const pref = (uiThemeValues as readonly string[]).includes(prefs.uiTheme)
    ? prefs.uiTheme
    : DEFAULT_UI_THEME;
  return `${accent}-${pref}`;
}

/** Served when the preferred variant is missing on disk. */
export const FALLBACK_SHELL_KEY = `${DEFAULT_UI_ACCENT}-${DEFAULT_UI_THEME}`;
