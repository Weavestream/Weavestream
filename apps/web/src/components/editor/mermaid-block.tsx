'use client';

import { useEffect, useRef, useState } from 'react';
import { useDiagramPalette } from './use-diagram-palette';
import { diagramPaletteSignature } from '@weavestream/shared/browser';

/**
 * One ```mermaid fence, rendered.
 *
 * Imports no CSS — its rules live in `editor.css`, which is already in
 * both article route bundles. Keep it that way: a CSS import here would
 * need a `moduleNameMapper` stub in `jest.config.js`, and `apps/web` has
 * no `test/` directory to hold one.
 *
 * ## The shadow root is a security control, not styling
 *
 * An inline SVG's `<style>` is a document-wide stylesheet — `body {
 * display: none }` inside a diagram would blank the page. Mermaid
 * prefixes its own rules with the diagram id, but a `classDef` that
 * breaks out of that prefix is exactly the CSS-injection class behind
 * GHSA-87f9-hvmw-gh4p and GHSA-xcj9-5m2h-648r.
 *
 * `contain: layout paint` on the host is the other half: a shadow root
 * contains selector *matching*, not layout, so a `position: fixed`
 * descendant would still paint over the page. Paint containment clips
 * descendants to the host box and makes the host a containing block for
 * fixed positioning. (`:host` / `:host-context`, which reach the host
 * from inside, are rejected by the CSS gate in `sanitizeDiagramSvg`.)
 *
 * Don't flatten either of these into plain light-DOM insertion.
 */
export function MermaidBlock({
  source,
  showDiagramErrors = false,
}: {
  source: string;
  /** Surface Mermaid's own parse message. True only in the editor. */
  showDiagramErrors?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const versionRef = useRef(0);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [hasLastGood, setHasLastGood] = useState(false);
  const [slow, setSlow] = useState(false);

  const palette = useDiagramPalette();
  const signature = diagramPaletteSignature(palette);

  useEffect(() => {
    const version = (versionRef.current += 1);
    const current = () => version === versionRef.current;

    // No spinner: a "Rendering diagram…" line appears only if the render
    // is actually slow, so a fast diagram never flashes text. Mermaid
    // serialises renders internally, so on a multi-diagram article the
    // later ones genuinely do take a moment and the label earns itself.
    //
    // Only ever set to true, never reset here: the note renders solely
    // while `state === 'loading'`, which is true just for the first
    // render of a block. Later re-renders (a keystroke, a theme flip)
    // deliberately leave the existing diagram on screen with no note.
    const slowTimer = window.setTimeout(() => {
      if (current()) setSlow(true);
    }, 150);

    // Debounced because `source` changes on nearly every keystroke in
    // the split preview — but not on first mount, so the read view
    // renders immediately.
    const delay = versionRef.current === 1 ? 0 : 250;
    const startTimer = window.setTimeout(() => {
      void run(version, current);
    }, delay);

    async function run(v: number, isCurrent: () => boolean) {
      try {
        const { renderMermaid } = await import('./mermaid-runtime');
        const fragment = await renderMermaid({
          source,
          palette,
          paletteSignature: signature,
        });

        const root = shadowRef.current;
        // Every mutation below is gated, not just this one: an OLDER
        // render rejecting after a NEWER one succeeded must not flip a
        // correctly-drawn diagram into the error state.
        if (!isCurrent() || !root) return;

        root.replaceChildren(fragment);
        // Only after a commit actually happened — setting it with a null
        // host would suppress the <pre> fallback with nothing on screen
        // to replace it.
        setHasLastGood(true);
        setMessage(null);
        setState('ready');
      } catch (err) {
        if (!isCurrent()) return;
        setMessage(err instanceof Error ? err.message : String(err));
        setState('error');
      }
    }

    return () => {
      window.clearTimeout(slowTimer);
      window.clearTimeout(startTimer);
      // Invalidate in-flight work. Without this an unmount leaves the
      // token current, so a late resolve would still pass `current()`
      // and call setState on an unmounted component.
      versionRef.current += 1;
    };
  }, [source, palette, signature]);

  return (
    <figure
      className="sd-mermaid"
      data-state={state}
      // Drives the loading-reserve collapse in editor.css. An explicit
      // signal rather than `:empty`, which cannot see shadow content.
      data-rendered={hasLastGood ? 'true' : 'false'}
    >
      <div
        className="sd-mermaid-scroll"
        ref={(node) => {
          hostRef.current = node;
          if (node && !shadowRef.current) {
            // `open` so tests and accessibility tooling can see in; the
            // containment is what the boundary is for, not secrecy.
            shadowRef.current = node.attachShadow({ mode: 'open' });
          }
        }}
        aria-busy={state === 'loading'}
      />
      {state === 'loading' && slow && (
        <figcaption className="sd-mermaid-note">Rendering diagram…</figcaption>
      )}
      {/* Source is the FALLBACK, not a companion: it appears only when
          nothing has ever rendered. With a last-good diagram on screen
          the caption alone carries the failure — in the editor a
          stale-but-valid diagram plus a quiet note is far better
          feedback than a box that re-explodes on every keystroke. */}
      {state === 'error' && !hasLastGood && (
        <pre>
          <code>{source}</code>
        </pre>
      )}
      {state === 'error' && (
        <figcaption className="sd-mermaid-note">
          Diagram could not be rendered.
          {showDiagramErrors && message ? ` ${message}` : ''}
        </figcaption>
      )}
    </figure>
  );
}
