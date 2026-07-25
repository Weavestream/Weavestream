'use client';

import { useSyncExternalStore } from 'react';

export type DomTheme = 'dark' | 'light';

/**
 * The applied theme, read from `<html data-theme>` and kept live.
 *
 * That attribute is the single source of truth — the nonced inline
 * script in the root layout sets it at first paint, and every control
 * that changes the theme (`ThemeToggle`, the profile menu's Appearance
 * row, the `/me` appearance form's live preview, and
 * `ThemePreferenceWatcher` following an OS light/dark flip) writes it
 * directly. Sampling it once on mount is therefore only correct for a
 * component that is the sole writer *and* unmounts between changes.
 *
 * Neither holds anymore: the action cluster is mounted twice at once
 * (`TopBar` for desktop, `MobileShellChrome` for phones — one hidden by
 * CSS rather than unmounted), so a menu left open across the 768px
 * breakpoint would keep showing whatever the theme was when it opened,
 * and its next click would compute the flip from that stale value and
 * appear to do nothing. Subscribing to the attribute means every
 * mounted reader agrees with what's painted, whoever did the writing.
 *
 * Built on `useSyncExternalStore` to match `useIsMobile` — the first
 * client render matches the subscribe snapshot, with no setState-in-
 * effect pass after mount.
 */
export function useDomTheme(): DomTheme {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Whether the first client commit has happened. Callers use it to fade
 * in theme-dependent copy: the server render can't know the applied
 * theme (it's cookie- and OS-dependent, resolved by the inline script),
 * so `useDomTheme()` necessarily reports the `getServerSnapshot` value
 * for the SSR pass and the hydration pass that has to match it.
 */
export function useThemeHydrated(): boolean {
  return useSyncExternalStore(subscribeNever, getHydrated, getServerHydrated);
}

/**
 * Apply a theme. Writes the attribute only — every `useDomTheme()`
 * subscriber, including the caller's own, updates from the resulting
 * mutation record, so there is no second copy of the value to keep in
 * step. Persisting the choice is the caller's job; this is the paint.
 */
export function applyDomTheme(next: DomTheme): void {
  document.documentElement.dataset.theme = next;
}

function subscribe(notify: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {};
  }
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  return () => observer.disconnect();
}

function getSnapshot(): DomTheme {
  if (typeof document === 'undefined') return 'dark';
  // Anything that isn't an explicit `light` is dark — same defaulting
  // the inline first-paint script and `tokens.css` use, so a missing or
  // malformed attribute can't disagree with what's on screen.
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function getServerSnapshot(): DomTheme {
  return 'dark';
}

// `useSyncExternalStore` calls the client snapshot only after hydration,
// so a store that never notifies and always reports `true` is exactly
// the "have we hydrated yet" signal, without a setState-in-effect.
function subscribeNever(): () => void {
  return () => {};
}

function getHydrated(): boolean {
  return true;
}

function getServerHydrated(): boolean {
  return false;
}
