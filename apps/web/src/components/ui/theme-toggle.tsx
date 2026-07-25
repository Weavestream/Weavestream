'use client';

import type { UiTheme } from '@weavestream/shared';
import { Icon } from './icon';
import { apiFetch } from '../../lib/api';
import {
  applyDomTheme,
  useDomTheme,
  useThemeHydrated,
} from '../../lib/hooks/use-dom-theme';

/**
 * Phase 9b.1 — quick dark ↔ light flip. Authenticated users persist the
 * choice to their `users.ui_theme` row via `PATCH /me/preferences`;
 * unauthenticated callers (login / setup) hit the public
 * `POST /public/ui-prefs` route instead, which only writes the `ws_ui`
 * cookie. Either way the DOM is updated first so the click feels
 * instantaneous, and the server call runs in the background.
 *
 * This button deliberately never surfaces `system` — the full
 * segmented control on `/me` Appearance is where that preference
 * lives. One click here means "flip the other way".
 */
export function ThemeToggle({
  size = 26,
  authenticated = true,
}: {
  size?: number;
  authenticated?: boolean;
}) {
  // We can't read the theme synchronously on the server render (the
  // layout already applied the right class), so the value comes from
  // the live `<html data-theme>` attribute — see `useDomTheme`.
  const theme = useDomTheme();
  const mounted = useThemeHydrated();

  async function toggle() {
    const next: UiTheme = theme === 'dark' ? 'light' : 'dark';
    applyDomTheme(next);

    if (authenticated) {
      const res = await apiFetch('/me/preferences', {
        method: 'PATCH',
        body: JSON.stringify({ uiTheme: next }),
      });
      // If the session expired between mount and click, fall back to
      // the public endpoint so the visual change at least survives the
      // next navigation.
      if (!res.ok && res.status === 401) {
        await apiFetch('/public/ui-prefs', {
          method: 'POST',
          body: JSON.stringify({ uiTheme: next }),
        });
      }
    } else {
      await apiFetch('/public/ui-prefs', {
        method: 'POST',
        body: JSON.stringify({ uiTheme: next }),
      });
    }
  }

  const Glyph = theme === 'dark' ? Icon.sun : Icon.moon;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      // Until we've read the DOM, render the button but let it settle
      // into the right glyph on the first client frame — prevents a
      // hydration mismatch for users whose server-rendered theme
      // differs from the last-applied one.
      suppressHydrationWarning
      style={{
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 5,
        border: '1px solid var(--line-2)',
        background: 'var(--panel-2)',
        color: 'var(--text-2)',
        cursor: 'pointer',
        opacity: mounted ? 1 : 0.6,
        transition: 'opacity 120ms ease, background 120ms ease',
      }}
    >
      <Glyph size={13} />
    </button>
  );
}
