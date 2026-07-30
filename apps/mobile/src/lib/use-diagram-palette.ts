import { useMemo, useSyncExternalStore } from 'react';
import {
  diagramPaletteSignature,
  readDiagramPalette,
  type DiagramPalette,
} from '@weavestream/shared/browser';

/**
 * The live diagram palette, re-read whenever the applied theme or accent
 * changes.
 *
 * Mobile's own hook rather than a shared one: `apps/web`'s version is
 * built from `useDomTheme` + `useDomAccent`, which live in that app and
 * must not be imported here.
 *
 * **Reading the tokens once at mount is not sufficient**, and this is
 * not theoretical: `ui-prefs.ts`'s `watchUiPrefs` rewrites `data-theme`
 * and `data-accent` on tab focus and on an OS colour-scheme flip,
 * *without* remounting the article. Mermaid bakes its palette into each
 * rendered SVG, so an unobserved change would leave every diagram in the
 * old theme while the rest of the screen moved.
 *
 * One observer for both attributes: unlike desktop, this app has no
 * other consumers to protect from the extra notifications.
 */
export function useDiagramPalette(): DiagramPalette {
  const stamp = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const fresh = useMemo(
    // `document.body` supplies the resolved font stack — the token is a
    // `var()` chain, so only the computed value is a usable CSS value.
    () => readDiagramPalette(document.documentElement, document.body),
    [stamp],
  );

  // Identity is keyed on the signature, so a no-op attribute rewrite
  // (the focus re-sync writes unconditionally) does not re-render every
  // diagram on screen.
  const signature = diagramPaletteSignature(fresh);
  // Keyed on the signature, not on `fresh`: `fresh` gets a new identity
  // on every signal, and collapsing that back down is this hook's job.
  return useMemo(() => fresh, [signature]);
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
    attributeFilter: ['data-theme', 'data-accent'],
  });
  return () => observer.disconnect();
}

/** The two attributes as one string — cheap, and stable when unchanged. */
function getSnapshot(): string {
  if (typeof document === 'undefined') return 'dark|lime';
  const { theme, accent } = document.documentElement.dataset;
  return `${theme ?? 'dark'}|${accent ?? 'lime'}`;
}

function getServerSnapshot(): string {
  return 'dark|lime';
}
