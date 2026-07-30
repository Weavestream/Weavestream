/** @jest-environment jsdom */
import type { DiagramPalette } from '@weavestream/shared/browser';

/**
 * Thin wiring, not policy. The sanitizer's own behaviour is pinned once
 * in `packages/shared/src/browser/diagram-svg.spec.ts`; what this file
 * proves is that the web runtime *delegates* to it rather than growing
 * its own gates, and that it hands back something detached.
 *
 * Mermaid itself is mocked: it is ESM-only, and it measures text with
 * `getBBox`, which jsdom does not implement. Mocking it here is the
 * whole reason this module exists as a one-function seam.
 */

const initialize = jest.fn();
const render = jest.fn();
const sanitizeDiagramSvg = jest.fn();
const buildMermaidConfig = jest.fn(() => ({ theme: 'base' }));

jest.mock('mermaid', () => ({
  __esModule: true,
  default: {
    initialize: (...a: unknown[]) => initialize(...(a as [])),
    render: (...a: unknown[]) => render(...(a as [])),
  },
}));

jest.mock('@weavestream/shared/browser', () => ({
  sanitizeDiagramSvg: (...a: unknown[]) => sanitizeDiagramSvg(...(a as [])),
  buildMermaidConfig: (...a: unknown[]) => buildMermaidConfig(...(a as [])),
}));

const PALETTE = { bg: '#0a0a0a', darkMode: true } as unknown as DiagramPalette;

async function load() {
  const mod = await import('./mermaid-runtime');
  return mod.renderMermaid;
}

beforeEach(() => {
  jest.resetModules();
  initialize.mockClear();
  render.mockClear();
  buildMermaidConfig.mockClear();
  sanitizeDiagramSvg.mockReset();
  sanitizeDiagramSvg.mockImplementation(() =>
    document.createDocumentFragment(),
  );
  render.mockResolvedValue({ svg: '<svg/>' });
  document.body.innerHTML = '';
});

describe('renderMermaid', () => {
  it('routes Mermaid output through the shared sanitizer', async () => {
    const renderMermaid = await load();
    await renderMermaid({
      source: 'flowchart TD',
      palette: PALETTE,
      paletteSignature: 'sig',
    });

    expect(sanitizeDiagramSvg).toHaveBeenCalledTimes(1);
    expect(sanitizeDiagramSvg.mock.calls[0]?.[0]).toBe('<svg/>');
    // Both implementations injected — a runtime that passed only the
    // purifier would silently skip the CSS gate.
    const deps = sanitizeDiagramSvg.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(deps['purify']).toBeDefined();
    expect(deps['css']).toBeDefined();
  });

  it('returns a detached fragment and mutates no live node', async () => {
    const renderMermaid = await load();
    const result = await renderMermaid({
      source: 'flowchart TD',
      palette: PALETTE,
      paletteSignature: 'sig',
    });

    expect(result.nodeType).toBe(Node.DOCUMENT_FRAGMENT_NODE);
    expect(result.parentNode).toBeNull();
    // The measuring host is the ONLY thing this module may add to the
    // document, and it must stay offscreen and inert.
    expect(document.body.querySelector('svg')).toBeNull();
  });

  it('renders into an offscreen measuring host, not into <body> directly', async () => {
    const renderMermaid = await load();
    await renderMermaid({
      source: 'flowchart TD',
      palette: PALETTE,
      paletteSignature: 'sig',
    });

    const container = render.mock.calls[0]?.[2] as HTMLElement;
    expect(container).toBeInstanceOf(HTMLElement);
    expect(container.parentElement).toBe(document.body);
    // `visibility: hidden` still lays out, which is what getBBox needs;
    // `display: none` would break measurement outright.
    expect(container.style.visibility).toBe('hidden');
    expect(container.style.display).not.toBe('none');
  });

  it('uses a fresh id per invocation', async () => {
    // Mermaid keys its temp elements and its per-diagram <style> scoping
    // off the id, so reuse collides them.
    const renderMermaid = await load();
    const opts = {
      source: 'flowchart TD',
      palette: PALETTE,
      paletteSignature: 'sig',
    };
    await renderMermaid(opts);
    await renderMermaid(opts);

    expect(render.mock.calls[0]?.[0]).not.toBe(render.mock.calls[1]?.[0]);
  });

  it('re-initialises only when the palette signature moves', async () => {
    const renderMermaid = await load();
    const base = { source: 'flowchart TD', palette: PALETTE };

    await renderMermaid({ ...base, paletteSignature: 'sig-a' });
    await renderMermaid({ ...base, paletteSignature: 'sig-a' });
    expect(initialize).toHaveBeenCalledTimes(1);

    await renderMermaid({ ...base, paletteSignature: 'sig-b' });
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(buildMermaidConfig).toHaveBeenLastCalledWith(PALETTE);
  });

  it('rejects rather than returning a partial fragment', async () => {
    render.mockRejectedValueOnce(new Error('Parse error on line 3'));
    const renderMermaid = await load();

    await expect(
      renderMermaid({
        source: 'broken',
        palette: PALETTE,
        paletteSignature: 'sig',
      }),
    ).rejects.toThrow('Parse error on line 3');
    expect(sanitizeDiagramSvg).not.toHaveBeenCalled();
  });
});
