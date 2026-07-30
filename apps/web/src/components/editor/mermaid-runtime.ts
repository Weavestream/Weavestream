import * as css from 'css-tree';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
import {
  buildMermaidConfig,
  sanitizeDiagramSvg,
  type DiagramPalette,
} from '@weavestream/shared/browser';

/**
 * The Mermaid lazy boundary.
 *
 * Everything heavy is imported *statically here* and this module is
 * imported *dynamically* by `MermaidBlock`, so `mermaid` (~166 KB gz
 * plus one chunk per diagram type), `dompurify` and `css-tree` all land
 * in the same lazily-fetched chunk. Importing any of them from
 * `mermaid-block.tsx` instead would ship it eagerly on every article
 * route — this placement is load-bearing, not stylistic. An article with
 * no diagram fetches none of it.
 *
 * ## Two contracts this module must keep
 *
 * 1. **It returns a DETACHED fragment and commits nothing.** The caller
 *    attaches it, after its own staleness check. If the commit happened
 *    here it would already have run by the time the caller's `await`
 *    resumed, so a "was this superseded?" check would be inspecting DOM
 *    it had just overwritten — a fast theme toggle or fast typing in the
 *    editor preview would paint a stale diagram and the guard would
 *    never fire.
 * 2. **All sanitization is `sanitizeDiagramSvg`**, the one policy in
 *    `packages/shared`. `apps/mobile/src/lib/mermaid-runtime.ts` is the
 *    same three imports and the same call. Mobile does not get a thinner
 *    set of gates, and neither surface may grow its own.
 */

/**
 * Monotonic, because Mermaid does `select('#' + id)` internally:
 * `useId()`'s `:r1:` needs CSS escaping to survive that, and reusing an
 * id across renders collides the `<style>` scoping Mermaid generates per
 * diagram.
 */
let sequence = 0;

let measuringHost: HTMLDivElement | null = null;
let appliedSignature: string | null = null;

/**
 * Mermaid measures text with `getBBox`, which needs a laid-out element.
 * `visibility: hidden` still lays out; `display: none` does NOT — do not
 * "optimise" this to the latter.
 *
 * The fixed 1200px width is deliberate: it makes output independent of
 * the reader's viewport, which is what lets the article read view and
 * the editor's split preview produce identical diagrams.
 *
 * Passing it as `render`'s third argument is what stops Mermaid's own
 * `select(document.body)` from appending its temporary node directly
 * into the middle of the article.
 */
function host(): HTMLDivElement {
  if (measuringHost?.isConnected) return measuringHost;
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText =
    'position:absolute;left:-99999px;top:0;width:1200px;visibility:hidden;pointer-events:none';
  document.body.appendChild(el);
  measuringHost = el;
  return el;
}

export interface RenderMermaidOptions {
  source: string;
  palette: DiagramPalette;
  /** Signature of `palette`; re-initialises Mermaid only when it moves. */
  paletteSignature: string;
}

/**
 * Render one diagram and return it as a sanitized, detached fragment.
 *
 * Rejects on a Mermaid parse error — it never returns a partial
 * fragment, so a caller that resolves has something worth committing.
 */
export async function renderMermaid({
  source,
  palette,
  paletteSignature,
}: RenderMermaidOptions): Promise<DocumentFragment> {
  // Mermaid's config is global, so this is idempotent per palette rather
  // than per render.
  if (appliedSignature !== paletteSignature) {
    mermaid.initialize(
      buildMermaidConfig(palette) as Parameters<typeof mermaid.initialize>[0],
    );
    appliedSignature = paletteSignature;
  }

  sequence += 1;
  const { svg } = await mermaid.render(`ws-mmd-${sequence}`, source, host());

  return sanitizeDiagramSvg(svg, {
    purify: DOMPurify as unknown as Parameters<typeof sanitizeDiagramSvg>[1]['purify'],
    css: css as unknown as Parameters<typeof sanitizeDiagramSvg>[1]['css'],
  });
}
