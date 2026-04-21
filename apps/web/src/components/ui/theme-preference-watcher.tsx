'use client';

import { useEffect } from 'react';

/**
 * Phase 9b.1 — while the tab is open, keep `data-theme` in sync with
 * `prefers-color-scheme` whenever the user's preference is `system`.
 *
 * The inline nonced script in the root layout handles the first-paint
 * case; this component covers the subsequent "user toggled their OS
 * theme without closing the tab" scenario — a real macOS Ventura /
 * Sonoma pattern where the system toggles dark at sunset.
 *
 * The mode is passed from the server via a non-reactive prop because
 * re-reading a cookie on every render would defeat SSR streaming. When
 * the user changes their preference via /me, `router.refresh()` in the
 * appearance form re-runs the server layout and remounts this watcher
 * with the new mode.
 */
export function ThemePreferenceWatcher({
  mode,
}: {
  mode: 'dark' | 'light' | 'system';
}) {
  useEffect(() => {
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      document.documentElement.dataset.theme = mq.matches ? 'light' : 'dark';
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [mode]);
  return null;
}
