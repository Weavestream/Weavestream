import {
  encodeUiCookie,
  UI_COOKIE_NAME,
  type UiPreferences,
} from '../ui-cookie.js';

/**
 * Read a cookie from `document.cookie`, percent-decoded.
 *
 * The decode is load-bearing, not cosmetic. Express's `res.cookie`
 * encodes values with `encodeURIComponent` unless told otherwise, so a
 * cookie the API writes as `t=dark;a=iris` arrives here as
 * `t%3Ddark%3Ba%3Diris`. Server-side readers (`next/headers`'s
 * `cookies()`, Express's `req.cookies` via cookie-parser) decode for
 * you, which is why this only ever bites browser code — and it bites
 * silently, because the parsers that consume these values are written
 * to fall back to defaults on garbage rather than throw.
 *
 * Returns `undefined` outside a browser so callers can be imported from
 * a server component without guarding.
 */
export function readBrowserCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  // Escape the name: this is a shared helper now, so a caller could pass
  // something with regex metacharacters in it.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = document.cookie.match(
    new RegExp('(?:^|; )' + escaped + '=([^;]*)'),
  );
  if (!match) return undefined;

  // `decodeURIComponent` THROWS a URIError on a malformed sequence — a
  // bare `%`, or `%zz`. Cookie values are attacker-influenceable and at
  // minimum user-corruptible, and callers use this for cosmetic values
  // (the `ws_ui` theme/accent) whose parsers are written to degrade to
  // defaults rather than fail. Letting the decode throw would turn a
  // junk cookie into an uncaught exception — and on mobile that runs
  // before React mounts, so the whole app would render blank over a
  // preference cookie. Fall back to the raw value: a parser that already
  // tolerates garbage will reject it and use its defaults.
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1];
  }
}

/**
 * Write the `ws_ui` preference cookie from the browser.
 *
 * The API's cookie helper documents `ws_ui` as deliberately
 * non-HttpOnly "so a same-page accent preview can update the cookie
 * without a round-trip" (apps/api/src/auth/cookies.ts) — this is that
 * anticipated writer, shared so the attribute set cannot drift from
 * the server's: host-only (no Domain), `Path=/`, `SameSite=Lax`,
 * one-year `Max-Age`, `Secure` on HTTPS, value percent-encoded exactly
 * like Express's `res.cookie` default (which `readBrowserCookie`
 * decodes back).
 *
 * The mobile PWA uses it to persist preferences learned from
 * `/auth/me`, so the next cold boot's server-side shell pick is
 * already correct. No-op outside a browser.
 */
export function writeUiBrowserCookie(prefs: UiPreferences): void {
  if (typeof document === 'undefined') return;
  const value = encodeURIComponent(
    encodeUiCookie({ uiTheme: prefs.uiTheme, uiAccent: prefs.uiAccent }),
  );
  const secure =
    typeof location !== 'undefined' && location.protocol === 'https:'
      ? '; Secure'
      : '';
  document.cookie =
    `${UI_COOKIE_NAME}=${value}; Path=/; Max-Age=31536000; SameSite=Lax` +
    secure;
}
