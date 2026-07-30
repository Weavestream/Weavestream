import { useEffect, useRef, useState } from 'react';
import { diagramPaletteSignature } from '@weavestream/shared/browser';
import { useDiagramPalette } from '../../lib/use-diagram-palette';

/**
 * One ```mermaid fence in a mobile article.
 *
 * ## Four states, and three of them are the code block that already
 * exists
 *
 * The subtraction: the fallback for "not yet drawn", "offline" and
 * "broken" is the `<pre>` this markdown would have rendered anyway, plus
 * one caption line. So exactly one genuinely new thing appears on
 * screen, and the source stays readable throughout — which for a runbook
 * diagram is a real answer, not a placeholder.
 *
 *  1. not yet rendered — plain `<pre>`, no skeleton, no spinner
 *  2. rendered — the SVG, inside a shadow root
 *  3. chunk fetch failed (offline) — `<pre>` + "needs a connection"
 *  4. render failed — `<pre>` + "could not be drawn"
 *
 * Mermaid's own parse message is never shown: articles are read-only
 * here, so a technician cannot act on it.
 *
 * ## The shadow root is a security control
 *
 * An inline SVG's `<style>` is a document-wide stylesheet, so a
 * `classDef` that escapes Mermaid's id prefix could restyle the whole
 * app. The boundary contains selector matching; `contain: layout paint`
 * on the host (in `globals.css`) contains layout, so a fixed-position
 * descendant cannot paint over the screen either. Don't flatten either
 * into plain insertion.
 *
 * ## No retry affordance
 *
 * The HTML module map memoizes failed dynamic imports in several
 * engines, so a second `import()` after connectivity returns can reject
 * immediately without touching the network. The only honest retry is a
 * reload, and that is more chrome than this earns.
 */
export function MermaidBlock({ source }: { source: string }) {
  const shadowRef = useRef<ShadowRoot | null>(null);
  const versionRef = useRef(0);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [offline, setOffline] = useState(false);
  const [hasLastGood, setHasLastGood] = useState(false);

  const palette = useDiagramPalette();
  const signature = diagramPaletteSignature(palette);

  useEffect(() => {
    const version = (versionRef.current += 1);
    const current = () => version === versionRef.current;

    async function run() {
      try {
        const { renderMermaid } = await import('../../lib/mermaid-runtime');
        const fragment = await renderMermaid({
          source,
          palette,
          paletteSignature: signature,
        });

        const root = shadowRef.current;
        // Every state change is gated, not just the commit: an older
        // render rejecting after a newer one succeeded must not flip a
        // correctly-drawn diagram into the error state.
        if (!current() || !root) return;

        root.replaceChildren(fragment);
        setHasLastGood(true);
        setState('ready');
      } catch (err) {
        if (!current()) return;
        // A failed dynamic import is the offline case; anything else is
        // a diagram Mermaid could not parse.
        setOffline(
          err instanceof TypeError ||
            (err instanceof Error && /dynamically imported module/i.test(err.message)),
        );
        setState('error');
      }
    }

    void run();

    return () => {
      // Invalidate in-flight work: without this an unmount leaves the
      // token current and a late resolve would still commit.
      versionRef.current += 1;
    };
  }, [source, palette, signature]);

  return (
    // `data-rendered` drives the host's collapse in globals.css. It has
    // to be an explicit signal rather than `:empty`, because the SVG
    // lives in a shadow root and `:empty` only sees light-DOM children —
    // a `:empty` rule keeps matching after a successful render and hides
    // the finished diagram.
    <figure className="m-mermaid" data-rendered={hasLastGood ? 'true' : 'false'}>
      <div
        className="m-mermaid-scroll"
        ref={(node) => {
          if (node && !shadowRef.current) {
            // `open` so tests and accessibility tooling can see in.
            shadowRef.current = node.attachShadow({ mode: 'open' });
          }
        }}
        aria-busy={state === 'loading'}
      />
      {!hasLastGood && (
        <pre>
          <code>{source}</code>
        </pre>
      )}
      {state === 'error' && (
        <figcaption className="text-meta text-muted">
          {offline
            ? 'Diagram — needs a connection to draw.'
            : 'Diagram — could not be drawn.'}
        </figcaption>
      )}
    </figure>
  );
}
