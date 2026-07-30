import * as css from 'css-tree';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
import {
  buildMermaidConfig,
  randomClientId,
  sanitizeDiagramSvg,
  type DiagramPalette,
} from '@weavestream/shared/browser';

/**
 * The Mermaid lazy boundary — mobile's mirror of
 * `apps/web/src/components/editor/mermaid-runtime.ts`, carrying the same
 * security contract.
 *
 * `mermaid`, `dompurify` and `css-tree` are all imported *statically
 * here* and this module is imported *dynamically* by `MermaidBlock`, so
 * the three land in one lazily-fetched chunk. That chunk is deliberately
 * excluded from the service worker's precache (see `vite.config.ts` and
 * `scripts/emit-to-web.mjs`), which is what keeps the PWA's install
 * payload unchanged for technicians who never open a diagram — and why
 * an offline diagram degrades to its source rather than rendering.
 *
 * ## The two contracts, identical to desktop's
 *
 * 1. **Returns a DETACHED fragment and commits nothing.** The caller
 *    attaches it behind its own staleness check; committing here would
 *    put the mutation before the caller's `await` resumed.
 * 2. **All sanitization is `sanitizeDiagramSvg`**, the one policy in
 *    `packages/shared`. Mobile does not get a thinner set of gates, and
 *    must never grow its own — a second copy is how the two surfaces
 *    drift into disagreeing about what is safe.
 */

let measuringHost: HTMLDivElement | null = null;
let appliedSignature: string | null = null;

/**
 * Mermaid measures text with `getBBox`, which needs a laid-out element:
 * `visibility: hidden` still lays out, `display: none` does not.
 *
 * The fixed 1200px width keeps output independent of the phone's
 * viewport, so a diagram is identical to what the desktop renders — the
 * block then scrolls it horizontally rather than reflowing it, matching
 * how `.m-prose pre` handles a wide runbook command.
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

export async function renderMermaid({
  source,
  palette,
  paletteSignature,
}: RenderMermaidOptions): Promise<DocumentFragment> {
  if (appliedSignature !== paletteSignature) {
    mermaid.initialize(
      buildMermaidConfig(palette) as Parameters<typeof mermaid.initialize>[0],
    );
    appliedSignature = paletteSignature;
  }

  // `randomClientId`, not `crypto.randomUUID()`: this app is routinely
  // served over plain HTTP to LAN devices in development, where the
  // secure-context crypto APIs are undefined.
  const { svg } = await mermaid.render(`ws-mmd-${randomClientId()}`, source, host());

  return sanitizeDiagramSvg(svg, {
    purify: DOMPurify as unknown as Parameters<typeof sanitizeDiagramSvg>[1]['purify'],
    css: css as unknown as Parameters<typeof sanitizeDiagramSvg>[1]['css'],
  });
}
