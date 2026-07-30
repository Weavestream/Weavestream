/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, render, screen } from '@testing-library/react';
import { MermaidBlock } from './mermaid-block';

/**
 * Block lifecycle: commit, containment, staleness, last-good.
 *
 * The *sanitizer* is tested once in `packages/shared` — this file is
 * about what the component does with the fragment it gets back. In
 * particular the "detached, nothing appended" assertion lives there and
 * NOT here: here the fragment is deliberately committed, into a shadow
 * root, which is part of the live document tree.
 *
 * Layout is deliberately not asserted. jsdom has no layout engine, so a
 * geometric check ("the host did not resize") would be vacuously true —
 * worse than no test. The real paint behaviour is a browser check.
 */

const renderMermaid = jest.fn();

jest.mock('./mermaid-runtime', () => ({
  renderMermaid: (...args: unknown[]) => renderMermaid(...args),
}));

// Referentially STABLE, like the real hook: `useDiagramPalette` memoizes
// on the palette signature precisely so the block's effect does not
// re-run on every render. A fresh object here would re-trigger the
// effect continuously and make the staleness tests meaningless.
const PALETTE = { bg: '#0a0a0a', darkMode: true };
jest.mock('./use-diagram-palette', () => ({
  useDiagramPalette: () => PALETTE,
}));

jest.mock('@weavestream/shared/browser', () => ({
  diagramPaletteSignature: () => 'sig',
}));

function svgFragment(marker: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('data-marker', marker);
  fragment.appendChild(svg);
  return fragment;
}

/** A promise plus its resolvers, so tests control settle ORDER exactly. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Attach a no-op catch so an intentionally-rejected deferred that the
  // component drops does not trip Node's unhandled-rejection detector.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function shadow(container: HTMLElement): ShadowRoot | null {
  return container.querySelector('.sd-mermaid-scroll')?.shadowRoot ?? null;
}

function markerIn(container: HTMLElement): string | null {
  return shadow(container)?.querySelector('svg')?.getAttribute('data-marker') ?? null;
}

/**
 * Fake timers throughout: the block debounces `source` changes by 250ms
 * (so the editor's split preview does not re-render on every keystroke),
 * and the first mount still goes through a zero-delay timer. Without
 * advancing them no render ever starts.
 */
beforeEach(() => {
  jest.useFakeTimers();
  renderMermaid.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

/** Flush pending microtasks without touching timers. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

/**
 * Let the debounce fire and settled promises flush.
 *
 * Several microtask turns, not one: the effect awaits the dynamic
 * `import('./mermaid-runtime')` before it even calls `renderMermaid`, so
 * a single turn only gets as far as the import.
 */
async function flush() {
  await act(async () => {
    jest.advanceTimersByTime(300);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

describe('commit', () => {
  it('attaches a shadow root and commits the SVG into it', async () => {
    renderMermaid.mockResolvedValue(svgFragment('one'));
    const { container } = render(<MermaidBlock source="flowchart TD\n A-->B" />);
    await flush();

    expect(markerIn(container)).toBe('one');

    // Asserted first because every containment claim below is vacuous
    // without it — a silently-absent shadow root would pass them all.
    expect(shadow(container)).not.toBeNull();
    // Nothing leaks into the light DOM: the host's own children stay
    // empty, which is what keeps the diagram's <style> from applying to
    // the whole document.
    expect(container.querySelector('.sd-mermaid-scroll')?.children).toHaveLength(
      0,
    );
    expect(container.querySelector('pre')).toBeNull();
  });

  it('marks the host as contained, which is what clips fixed descendants', () => {
    renderMermaid.mockResolvedValue(svgFragment('one'));
    const { container } = render(<MermaidBlock source="flowchart TD" />);
    const host = container.querySelector('.sd-mermaid-scroll');
    // The class carries `contain: layout paint` in editor.css. A shadow
    // root contains selector matching but NOT layout, so this is the
    // half that stops `position: fixed` painting over the page.
    expect(host).toHaveClass('sd-mermaid-scroll');
  });
});

describe('staleness', () => {
  it('commits only the newer render when two resolve out of order', async () => {
    const first = deferred<DocumentFragment>();
    const second = deferred<DocumentFragment>();
    renderMermaid
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { container, rerender } = render(<MermaidBlock source="one" />);
    await flush();
    rerender(<MermaidBlock source="two" />);
    await flush();

    second.resolve(svgFragment('two'));
    await settle();
    first.resolve(svgFragment('one'));
    await settle();

    expect(markerIn(container)).toBe('two');
  });

  it('an OLDER render rejecting after a NEWER one succeeded leaves it ready', async () => {
    // The case a success-only guard misses: the stale rejection would
    // flip a correctly-drawn diagram into the error state.
    const first = deferred<DocumentFragment>();
    const second = deferred<DocumentFragment>();
    renderMermaid
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { container, rerender } = render(<MermaidBlock source="one" />);
    await flush();
    rerender(<MermaidBlock source="two" />);
    await flush();

    second.resolve(svgFragment('two'));
    await settle();
    first.reject(new Error('Parse error on line 3'));
    await settle();

    expect(markerIn(container)).toBe('two');
    expect(screen.queryByText(/could not be rendered/i)).toBeNull();
    expect(container.querySelector('pre')).toBeNull();
  });

  it('does not commit or set state after unmount', async () => {
    const pending = deferred<DocumentFragment>();
    renderMermaid.mockReturnValue(pending.promise);

    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = render(<MermaidBlock source="one" />);
    await flush();
    unmount();

    pending.resolve(svgFragment('late'));
    await settle();

    // React logs a warning on setState after unmount; none means the
    // cleanup's token bump invalidated the in-flight run.
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe('failure', () => {
  it('falls back to the source when nothing has ever rendered', async () => {
    renderMermaid.mockRejectedValue(new Error('Parse error on line 3'));
    const source = 'flowchart TD\n  A --> ';
    const { container } = render(<MermaidBlock source={source} />);
    await flush();

    expect(screen.getByText(/could not be rendered/i)).toBeInTheDocument();
    expect(container.querySelector('pre code')?.textContent).toBe(source);
  });

  it('keeps the last good diagram and shows no source alongside it', async () => {
    renderMermaid.mockResolvedValueOnce(svgFragment('good'));
    const { container, rerender } = render(<MermaidBlock source="one" />);
    await flush();
    expect(markerIn(container)).toBe('good');

    renderMermaid.mockRejectedValueOnce(new Error('Parse error on line 3'));
    rerender(<MermaidBlock source="one broken" />);
    await flush();

    expect(screen.getByText(/could not be rendered/i)).toBeInTheDocument();
    // A stale-but-valid diagram plus a quiet caption beats a box that
    // re-explodes on every keystroke in the editor preview.
    expect(markerIn(container)).toBe('good');
    expect(container.querySelector('pre')).toBeNull();
  });

  it('hides Mermaid’s own message by default', async () => {
    renderMermaid.mockRejectedValue(new Error('Parse error on line 3'));
    render(<MermaidBlock source="broken" />);
    await flush();

    expect(screen.getByText(/could not be rendered/i)).toBeInTheDocument();
    expect(screen.queryByText(/Parse error on line 3/)).toBeNull();
  });

  it('shows it when the author can act on it', async () => {
    renderMermaid.mockRejectedValue(new Error('Parse error on line 3'));
    render(<MermaidBlock source="broken" showDiagramErrors />);
    await flush();

    expect(screen.getByText(/Parse error on line 3/)).toBeInTheDocument();
  });
});
