/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, render, screen } from '@testing-library/react';
import { MermaidBlock } from './MermaidBlock';

/**
 * Block lifecycle and containment — mobile's half of the parity
 * contract with `apps/web`'s `mermaid-block.test.tsx`.
 *
 * The *sanitizer* is tested once, in `packages/shared`. Here the
 * fragment is deliberately committed into a shadow root, so the
 * "detached, nothing attached" assertion belongs there and not here.
 *
 * No layout assertions: jsdom has no layout engine, so "the host did not
 * resize" would be vacuously true and worse than no test.
 */

const renderMermaid = jest.fn();

jest.mock('../../lib/mermaid-runtime', () => ({
  renderMermaid: (...args: unknown[]) => renderMermaid(...(args as [])),
}));

// Referentially stable, like the real hook — a fresh object would
// re-trigger the effect on every render and make staleness untestable.
const PALETTE = { bg: '#0a0a0a', darkMode: true };
jest.mock('../../lib/use-diagram-palette', () => ({
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

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function shadow(container: HTMLElement): ShadowRoot | null {
  return container.querySelector('.m-mermaid-scroll')?.shadowRoot ?? null;
}

function markerIn(container: HTMLElement): string | null {
  return (
    shadow(container)?.querySelector('svg')?.getAttribute('data-marker') ?? null
  );
}

/** Several microtask turns: the effect awaits a dynamic import first. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  renderMermaid.mockReset();
});

describe('commit', () => {
  it('commits the SVG into a shadow root, leaving the light DOM empty', async () => {
    renderMermaid.mockResolvedValue(svgFragment('one'));
    const { container } = render(<MermaidBlock source="flowchart TD" />);
    await settle();

    // Asserted explicitly: without a shadow root every containment claim
    // below would pass vacuously.
    expect(shadow(container)).not.toBeNull();
    expect(markerIn(container)).toBe('one');
    expect(container.querySelector('.m-mermaid-scroll')?.children).toHaveLength(
      0,
    );
    // The source fallback is gone once something has rendered.
    expect(container.querySelector('pre')).toBeNull();
  });

  it('marks itself rendered so the host is not collapsed away', async () => {
    // The regression this pins: the host was collapsed with
    // `.m-mermaid-scroll:empty { display: none }`, and `:empty` only
    // considers LIGHT-DOM children — so it kept matching after the SVG
    // was committed into the shadow root. The diagram rendered and was
    // then hidden by CSS, while `hasLastGood` had already dropped the
    // <pre> fallback: the article showed neither, with a clean console.
    renderMermaid.mockResolvedValue(svgFragment('one'));
    const { container } = render(<MermaidBlock source="flowchart TD" />);

    expect(container.querySelector('.m-mermaid')).toHaveAttribute(
      'data-rendered',
      'false',
    );

    await settle();

    expect(container.querySelector('.m-mermaid')).toHaveAttribute(
      'data-rendered',
      'true',
    );
    // The two must agree: whatever hides the host must be the same
    // condition that hides the source, or one state shows nothing.
    expect(container.querySelector('pre')).toBeNull();
    expect(markerIn(container)).toBe('one');
  });

  it('shows the source until the first render lands', () => {
    renderMermaid.mockReturnValue(deferred<DocumentFragment>().promise);
    const source = 'flowchart TD\n  A --> B';
    const { container } = render(<MermaidBlock source={source} />);

    // No skeleton and no spinner: the source is real content, and it
    // stays readable until the diagram replaces it.
    expect(container.querySelector('pre code')?.textContent).toBe(source);
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
    await settle();
    rerender(<MermaidBlock source="two" />);
    await settle();

    second.resolve(svgFragment('two'));
    await settle();
    first.resolve(svgFragment('one'));
    await settle();

    expect(markerIn(container)).toBe('two');
  });

  it('an OLDER render rejecting after a NEWER one succeeded leaves it ready', async () => {
    // The case a success-only guard misses.
    const first = deferred<DocumentFragment>();
    const second = deferred<DocumentFragment>();
    renderMermaid
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { container, rerender } = render(<MermaidBlock source="one" />);
    await settle();
    rerender(<MermaidBlock source="two" />);
    await settle();

    second.resolve(svgFragment('two'));
    await settle();
    first.reject(new Error('Parse error'));
    await settle();

    expect(markerIn(container)).toBe('two');
    expect(screen.queryByText(/could not be drawn/i)).toBeNull();
  });

  it('does not commit or set state after unmount', async () => {
    const pending = deferred<DocumentFragment>();
    renderMermaid.mockReturnValue(pending.promise);

    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = render(<MermaidBlock source="one" />);
    await settle();
    unmount();

    pending.resolve(svgFragment('late'));
    await settle();

    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe('failure', () => {
  it('names the offline case when the chunk cannot be fetched', async () => {
    // A failed dynamic import is what going offline looks like here —
    // the diagram engine is deliberately not precached.
    renderMermaid.mockRejectedValue(
      new TypeError('Failed to fetch dynamically imported module'),
    );
    const source = 'flowchart TD\n  A --> B';
    const { container } = render(<MermaidBlock source={source} />);
    await settle();

    expect(screen.getByText(/needs a connection/i)).toBeInTheDocument();
    // The source stays: for a runbook diagram that is a real answer, not
    // a placeholder.
    expect(container.querySelector('pre code')?.textContent).toBe(source);
  });

  it('reports an unparseable diagram without Mermaid’s own message', async () => {
    renderMermaid.mockRejectedValue(new Error('Parse error on line 3'));
    const { container } = render(<MermaidBlock source="broken" />);
    await settle();

    expect(screen.getByText(/could not be drawn/i)).toBeInTheDocument();
    // Articles are read-only on mobile, so a technician cannot act on
    // Mermaid's parse detail.
    expect(screen.queryByText(/Parse error on line 3/)).toBeNull();
    expect(container.querySelector('pre code')?.textContent).toBe('broken');
  });

  it('offers no retry affordance', async () => {
    // The HTML module map memoizes failed dynamic imports, so a second
    // import() after reconnecting can reject with no network attempt.
    // The only honest retry is a reload.
    renderMermaid.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<MermaidBlock source="one" />);
    await settle();

    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});
