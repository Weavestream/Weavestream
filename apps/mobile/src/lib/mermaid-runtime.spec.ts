/** @jest-environment jsdom */
import type { DiagramPalette } from '@weavestream/shared/browser';

/**
 * Mobile's half of the parity contract.
 *
 * The sanitizer's behaviour is pinned once, in `packages/shared`. What
 * this file proves is that mobile *delegates* to that one policy rather
 * than growing its own — without it, this surface could silently drift
 * into an unsanitized path while the shared suite stayed green.
 *
 * Mermaid itself is mocked: it is ESM-only and measures text with
 * `getBBox`, which jsdom does not implement. That is exactly why this
 * module exists as a one-function seam.
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
  randomClientId: () => 'stub-id',
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
  sanitizeDiagramSvg.mockReset();
  sanitizeDiagramSvg.mockImplementation(() => document.createDocumentFragment());
  render.mockResolvedValue({ svg: '<svg/>' });
  document.body.innerHTML = '';
});

describe('renderMermaid (mobile)', () => {
  it('routes Mermaid output through the SHARED sanitizer, both gates injected', () => {
    return load().then(async (renderMermaid) => {
      await renderMermaid({
        source: 'flowchart TD',
        palette: PALETTE,
        paletteSignature: 'sig',
      });

      expect(sanitizeDiagramSvg).toHaveBeenCalledTimes(1);
      expect(sanitizeDiagramSvg.mock.calls[0]?.[0]).toBe('<svg/>');
      const deps = sanitizeDiagramSvg.mock.calls[0]?.[1] as Record<
        string,
        unknown
      >;
      // A runtime that passed only the purifier would silently skip the
      // CSS gate — the one gate Mermaid does not perform itself.
      expect(deps['purify']).toBeDefined();
      expect(deps['css']).toBeDefined();
    });
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
    expect(document.body.querySelector('svg')).toBeNull();
  });

  it('measures in an offscreen host that still lays out', async () => {
    const renderMermaid = await load();
    await renderMermaid({
      source: 'flowchart TD',
      palette: PALETTE,
      paletteSignature: 'sig',
    });

    const container = render.mock.calls[0]?.[2] as HTMLElement;
    expect(container.parentElement).toBe(document.body);
    // `visibility: hidden` still lays out, which getBBox needs;
    // `display: none` would break measurement outright.
    expect(container.style.visibility).toBe('hidden');
    expect(container.style.display).not.toBe('none');
  });

  it('re-initialises only when the palette signature moves', async () => {
    const renderMermaid = await load();
    const base = { source: 'flowchart TD', palette: PALETTE };

    await renderMermaid({ ...base, paletteSignature: 'sig-a' });
    await renderMermaid({ ...base, paletteSignature: 'sig-a' });
    expect(initialize).toHaveBeenCalledTimes(1);

    await renderMermaid({ ...base, paletteSignature: 'sig-b' });
    expect(initialize).toHaveBeenCalledTimes(2);
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
