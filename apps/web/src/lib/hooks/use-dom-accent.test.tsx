/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, render, screen } from '@testing-library/react';
import { useDomAccent } from './use-dom-accent';

/** Mirrors `use-dom-theme.test.tsx`'s Probe: one mounted accent reader. */
function Probe({ id }: { id: string }) {
  return <output aria-label={id}>{useDomAccent()}</output>;
}

function reading(id: string): string | null {
  return screen.getByLabelText(id).textContent;
}

/**
 * MutationObserver delivers on a microtask, so the async `act` is what
 * lets the resulting store notification land before the assertion —
 * matching `use-dom-theme.test.tsx`.
 */
async function setAccent(value: string | undefined) {
  await act(async () => {
    if (value === undefined) delete document.documentElement.dataset.accent;
    else document.documentElement.dataset.accent = value;
  });
}

describe('useDomAccent', () => {
  beforeEach(() => {
    delete document.documentElement.dataset.accent;
  });

  it('reads the applied accent from <html data-accent>', () => {
    document.documentElement.dataset.accent = 'iris';
    render(<Probe id="a" />);
    expect(reading('a')).toBe('iris');
  });

  it('defaults to lime when the attribute is absent', () => {
    render(<Probe id="a" />);
    expect(reading('a')).toBe('lime');
  });

  it('falls back to lime for an unknown value', () => {
    // The attribute is stamped from a validated preference, but a stale
    // cookie or a hand-edited DOM should degrade to the painted default
    // rather than hand a bogus accent to the diagram palette.
    document.documentElement.dataset.accent = 'chartreuse';
    render(<Probe id="a" />);
    expect(reading('a')).toBe('lime');
  });

  it('keeps every mounted reader in step after a change', async () => {
    // `/me`'s appearance form mutates data-accent directly for its live
    // preview; a reader that sampled once on mount would disagree with
    // what is painted.
    render(
      <>
        <Probe id="a" />
        <Probe id="b" />
      </>,
    );
    await setAccent('coral');
    expect(reading('a')).toBe('coral');
    expect(reading('b')).toBe('coral');
  });

  it('stops observing after unmount', async () => {
    const { unmount } = render(<Probe id="a" />);
    unmount();
    await expect(setAccent('teal')).resolves.not.toThrow();
  });
});
