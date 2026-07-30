'use client';

import { useMemo } from 'react';
import {
  diagramPaletteSignature,
  readDiagramPalette,
  type DiagramPalette,
} from '@weavestream/shared/browser';
import { useDomAccent } from '../../lib/hooks/use-dom-accent';
import { useDomTheme } from '../../lib/hooks/use-dom-theme';

/**
 * The live diagram palette, re-read whenever the applied theme or accent
 * changes.
 *
 * Mermaid bakes its colours into each rendered SVG and offers no
 * re-theme hook, so a palette change means a fresh render — which is why
 * this returns a *referentially stable* object gated on the palette
 * signature rather than on the attributes themselves.
 *
 * That gate is load-bearing, not an optimisation:
 * `ThemePreferenceWatcher` writes `data-theme` unconditionally on mount
 * — even `dark` → `dark` produces a MutationRecord — so an
 * attribute-keyed memo would re-render every diagram on the page once
 * per article load, visibly, for no change at all.
 *
 * Two things are deliberately NOT observed:
 *  - `data-theme-pref`, which only changes via the `router.refresh()` in
 *    `/me`'s appearance form, remounting this tree anyway.
 *  - `prefers-color-scheme`, which `ThemePreferenceWatcher` already
 *    translates into a `data-theme` write.
 * Adding either would be redundant work, not extra correctness.
 */
export function useDiagramPalette(): DiagramPalette {
  const theme = useDomTheme();
  const accent = useDomAccent();

  // theme/accent are the change SIGNALS. Re-reading is cheap — a handful
  // of getComputedStyle lookups — so it happens on every signal.
  // `theme`/`accent` are not READ by the callback; they are the
  // invalidation signals. The values themselves live on
  // `document.documentElement`, which no dependency array can describe.
  const fresh = useMemo(
    // `document.body` supplies the resolved font stack: the token is a
    // `var()` chain, so only the computed value carries next/font's
    // generated family name.
    () => readDiagramPalette(document.documentElement, document.body),
    [theme, accent],
  );

  // ...but the signature decides whether anything actually MOVED. Keying
  // identity on it means an unchanged palette keeps the same object, so
  // the block's effect does not re-run. Expressed as a second useMemo
  // rather than a ref because reading a ref during render is exactly the
  // pattern that makes a component miss updates.
  const signature = diagramPaletteSignature(fresh);
  // Keyed on the signature deliberately: `fresh` gets a new identity on
  // every signal, and collapsing that back down is this hook's whole job.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => fresh, [signature]);
}
