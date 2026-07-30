'use client';

import { useSyncExternalStore } from 'react';

export type DomAccent = 'lime' | 'amber' | 'iris' | 'coral' | 'teal';

const ACCENTS: readonly DomAccent[] = ['lime', 'amber', 'iris', 'coral', 'teal'];

/**
 * The applied accent, read from `<html data-accent>` and kept live.
 *
 * A sibling of `useDomTheme` rather than an extension of it. That hook's
 * doc comment scopes it to *the theme*, and it has several consumers
 * (`ThemeToggle`, the profile menu's Appearance row, `/me`'s live
 * preview) that have no interest in accent changes — widening its
 * `attributeFilter` would re-render all of them for nothing.
 *
 * The reader that needs this is the diagram block: Mermaid bakes its
 * palette into the rendered SVG, so an accent change that no one
 * observes leaves every diagram on the page in the previous accent while
 * the rest of the UI moves. `/me`'s appearance form mutates
 * `data-accent` directly for its live preview, so this is a real path,
 * not a theoretical one.
 */
export function useDomAccent(): DomAccent {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function subscribe(notify: () => void): () => void {
  if (
    typeof document === 'undefined' ||
    typeof MutationObserver === 'undefined'
  ) {
    return () => {};
  }
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-accent'],
  });
  return () => observer.disconnect();
}

function getSnapshot(): DomAccent {
  if (typeof document === 'undefined') return 'lime';
  return normalise(document.documentElement.dataset.accent);
}

function getServerSnapshot(): DomAccent {
  // `lime` is the fresh-account default the root layout stamps, and the
  // fallback `color-tokens.css` paints when the attribute is missing.
  return 'lime';
}

function normalise(value: string | undefined): DomAccent {
  return ACCENTS.includes(value as DomAccent) ? (value as DomAccent) : 'lime';
}
