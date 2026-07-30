/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, render, screen } from '@testing-library/react';
import { useDiagramPalette } from './use-diagram-palette';

/**
 * Mobile theme reactivity.
 *
 * Reading tokens once at mount is not sufficient, and this is not
 * theoretical: `ui-prefs.ts`'s `watchUiPrefs` rewrites `data-theme` and
 * `data-accent` on tab focus and on an OS colour-scheme flip, *without*
 * remounting the article. Mermaid bakes its palette into the rendered
 * SVG, so an unobserved change leaves every diagram in the old theme
 * while the rest of the screen moves.
 */

jest.mock('@weavestream/shared/browser', () => ({
  readDiagramPalette: () => {
    return {
      bg: document.documentElement.dataset['theme'] === 'light' ? '#fff' : '#000',
      accent: document.documentElement.dataset['accent'] ?? 'lime',
    };
  },
  diagramPaletteSignature: (p: { bg: string; accent: string }) =>
    `${p.bg}|${p.accent}`,
}));

let identities: unknown[] = [];

function Probe() {
  const palette = useDiagramPalette();
  identities.push(palette);
  return <output aria-label="sig">{JSON.stringify(palette)}</output>;
}

async function setAttr(name: string, value: string) {
  // MutationObserver delivers on a microtask.
  await act(async () => {
    document.documentElement.setAttribute(name, value);
  });
}

beforeEach(() => {
  identities = [];
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-accent');
});

describe('useDiagramPalette', () => {
  it('re-reads when the theme changes', async () => {
    render(<Probe />);
    expect(screen.getByLabelText('sig').textContent).toContain('#000');

    await setAttr('data-theme', 'light');
    expect(screen.getByLabelText('sig').textContent).toContain('#fff');
  });

  it('re-reads when the accent changes', async () => {
    // Desktop needs a separate hook for this; here one observer covers
    // both attributes.
    render(<Probe />);
    await setAttr('data-accent', 'coral');
    expect(screen.getByLabelText('sig').textContent).toContain('coral');
  });

  it('keeps the same object identity when nothing actually moved', async () => {
    // The focus re-sync writes the attributes unconditionally, so a
    // no-op rewrite must NOT hand back a new object — otherwise every
    // diagram on screen re-renders for nothing.
    document.documentElement.setAttribute('data-theme', 'dark');
    render(<Probe />);
    const before = identities[identities.length - 1];

    await setAttr('data-theme', 'dark');

    expect(identities[identities.length - 1]).toBe(before);
  });

  it('hands back a new object when the palette really moved', async () => {
    render(<Probe />);
    const before = identities[identities.length - 1];

    await setAttr('data-theme', 'light');

    expect(identities[identities.length - 1]).not.toBe(before);
  });
});
