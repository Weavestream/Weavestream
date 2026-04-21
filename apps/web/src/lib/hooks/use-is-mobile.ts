'use client';

import { useSyncExternalStore } from 'react';

/**
 * Matches Tailwind's `md` breakpoint. Everything below is treated as a
 * phone-style viewport — the sidebar collapses into a drawer, wide
 * tables become cards, and multi-column forms stack to a single column.
 */
export const MOBILE_BREAKPOINT_PX = 768;

/**
 * SSR-safe media-query hook. Built on `useSyncExternalStore` so the
 * first client render exactly matches the subscribe snapshot — no
 * flicker from a `useEffect`-based refresh pass after mount.
 *
 * Server render always reports "not mobile" so the fixed-sidebar shell
 * is what ships in the HTML; the first client commit immediately
 * collapses to the drawer variant on phones, which is a single paint
 * flip (no duplicate DOM).
 */
export function useIsMobile(breakpoint: number = MOBILE_BREAKPOINT_PX): boolean {
  return useSyncExternalStore(
    (notify) => subscribe(breakpoint, notify),
    () => getSnapshot(breakpoint),
    () => false,
  );
}

function subscribe(breakpoint: number, notify: () => void): () => void {
  if (typeof window === 'undefined' || !('matchMedia' in window)) {
    return () => {};
  }
  const mql = window.matchMedia(`(max-width: ${breakpoint - 0.02}px)`);
  // Older Safari exposes `addListener` only — keep the fallback so we
  // don't silently stop updating on pre-iOS-14 browsers.
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', notify);
    return () => mql.removeEventListener('change', notify);
  }
  mql.addListener(notify);
  return () => mql.removeListener(notify);
}

function getSnapshot(breakpoint: number): boolean {
  if (typeof window === 'undefined' || !('matchMedia' in window)) return false;
  return window.matchMedia(`(max-width: ${breakpoint - 0.02}px)`).matches;
}
