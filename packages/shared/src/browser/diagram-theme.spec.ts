import { resetCssColorCache } from './css-color';
import {
  buildMermaidConfig,
  buildMermaidThemeVariables,
  diagramPaletteSignature,
  readDiagramPalette,
} from './diagram-theme';

/**
 * Node environment with stubbed globals, matching `css-color.spec.ts`.
 *
 * The assertion that earns this file's existence is the "no modern
 * colour syntax" pin: khroma — Mermaid's colour maths — throws on
 * `oklch()`, `lab()`, `color()` and `var()`, so a single leak crashes
 * every diagram on the page. Everything else here supports that one.
 *
 * jsdom has no canvas, so the fallback path below is what a real jsdom
 * run would take anyway; that makes it the cheap default to pin, and it
 * is also why the *conversion* is proven in a browser instead.
 */

declare let global: {
  document?: { createElement: (tag: string) => unknown };
  getComputedStyle?: (el: unknown) => {
    getPropertyValue: (n: string) => string;
    fontFamily?: string;
  };
};

const DARK: Record<string, string> = {
  '--bg': '#0a0a0a',
  '--surface': '#111',
  '--panel': '#161616',
  '--panel-2': '#1c1c1c',
  '--elev': '#202020',
  '--line': '#222',
  '--line-2': '#2a2a2a',
  '--line-3': '#333',
  '--faint': '#3a3a3a',
  '--text': '#ededed',
  '--text-2': '#c8c8c8',
  '--muted': '#8a8a8a',
  '--dim': '#858585',
  '--accent': 'oklch(0.86 0.18 125)',
  '--accent-line': 'oklch(0.86 0.18 125 / 0.35)',
  '--accent-ink': '#0a0a0a',
  '--danger': 'oklch(0.7 0.2 25)',
  '--warn': 'oklch(0.82 0.14 75)',
  '--ok': 'oklch(0.78 0.14 160)',
  '--info': 'oklch(0.75 0.12 240)',
};

const LIGHT: Record<string, string> = {
  ...DARK,
  '--bg': '#fafaf9',
  '--surface': '#fff',
  '--panel': '#fff',
  '--panel-2': '#f6f6f4',
  '--elev': '#fff',
  '--line': '#ebe9e4',
  '--line-2': '#e2e0d9',
  '--line-3': '#d4d2cb',
  '--text': '#0f0f0f',
  '--text-2': '#2a2a2a',
  '--muted': '#6a6a66',
  '--dim': '#70706c',
  '--faint': '#c8c6bf',
  '--accent': 'oklch(0.68 0.18 135)',
  '--accent-ink': '#fafaf9',
};

/** Stands in for a browser that can convert oklch. Returns fixed bytes. */
function workingCanvas() {
  let stored = '#000000';
  let painted: [number, number, number] = [0, 0, 0];
  const parse = (v: string): [number, number, number] | null => {
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
    if (hex) {
      const d = hex[1]!;
      const f = d.length === 3 ? d.replace(/./g, (c) => c + c) : d;
      return [
        parseInt(f.slice(0, 2), 16),
        parseInt(f.slice(2, 4), 16),
        parseInt(f.slice(4, 6), 16),
      ];
    }
    // Any oklch maps to one arbitrary in-gamut colour: this spec is
    // about the SHAPE of the output, not colorimetric accuracy.
    return v.startsWith('oklch(') ? [128, 200, 64] : null;
  };
  return {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        get fillStyle() {
          return stored;
        },
        set fillStyle(next: string) {
          if (parse(next)) stored = next;
        },
        clearRect: () => {
          painted = [0, 0, 0];
        },
        fillRect: () => {
          painted = parse(stored) ?? painted;
        },
        getImageData: () => ({ data: [...painted, 255] }),
      }),
    }),
  };
}

function install(tokens: Record<string, string>, canvas: unknown) {
  resetCssColorCache();
  global.document = canvas as { createElement: (t: string) => unknown };
  global.getComputedStyle = () => ({
    getPropertyValue: (n: string) => tokens[n] ?? '',
    fontFamily: '"Inter Tight", sans-serif',
  });
}

/** A canvas-less environment — literally the jsdom shape. */
const NO_CANVAS = { createElement: () => ({ getContext: () => null }) };

afterEach(() => {
  resetCssColorCache();
  delete global.document;
  delete global.getComputedStyle;
});

const MODERN_SYNTAX = /oklch\(|lab\(|lch\(|color\(|var\(/;
const PARSEABLE = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|[a-z]+)/i;

describe.each<[string, Record<string, string>]>([
  ['dark', DARK],
  ['light', LIGHT],
])('%s tokens', (_label, tokens) => {
  it('never emits colour syntax khroma would throw on (the crash pin)', () => {
    install(tokens, workingCanvas());
    const vars = buildMermaidThemeVariables(
      readDiagramPalette({} as HTMLElement),
    );
    for (const [key, value] of Object.entries(vars)) {
      if (typeof value !== 'string') continue;
      if (key === 'fontFamily' || key === 'fontSize') continue;
      expect(`${key}=${value}`).not.toMatch(MODERN_SYNTAX);
      expect(value).toMatch(PARSEABLE);
    }
  });

  it('still emits no modern syntax when the canvas is unavailable', () => {
    // The fallback path substitutes hex tokens for every oklch one, so
    // the diagram goes monochrome-but-on-theme rather than crashing.
    install(tokens, NO_CANVAS);
    const vars = buildMermaidThemeVariables(
      readDiagramPalette({} as HTMLElement),
    );
    for (const [key, value] of Object.entries(vars)) {
      if (typeof value !== 'string') continue;
      if (key === 'fontFamily' || key === 'fontSize') continue;
      expect(`${key}=${value}`).not.toMatch(MODERN_SYNTAX);
    }
  });
});

describe('darkMode', () => {
  it('is derived from --bg, not from a theme name', () => {
    // Under `data-theme-pref="system"` the stamped `data-theme` says
    // "dark" while the light palette is already painted. Reading the
    // token is correct from the first frame.
    install(DARK, workingCanvas());
    expect(readDiagramPalette({} as HTMLElement).darkMode).toBe(true);

    install(LIGHT, workingCanvas());
    expect(readDiagramPalette({} as HTMLElement).darkMode).toBe(false);
  });
});

describe('fallbacks', () => {
  it('substitutes hex tokens for oklch ones when conversion fails', () => {
    install(DARK, NO_CANVAS);
    const p = readDiagramPalette({} as HTMLElement);
    expect(p.accent).toBe(DARK['--text-2']);
    expect(p.accentLine).toBe(DARK['--line-3']);
    expect(p.accentInk).toBe(DARK['--bg']);
    expect(p.danger).toBe(DARK['--text-2']);
  });

  it('survives a document with no stylesheet at all', () => {
    install({}, NO_CANVAS);
    const p = readDiagramPalette({} as HTMLElement);
    expect(p.bg).toBe('#0a0a0a');
    expect(() => buildMermaidThemeVariables(p)).not.toThrow();
  });
});

describe('diagramPaletteSignature', () => {
  it('changes when only the accent changes', () => {
    install(DARK, workingCanvas());
    const a = diagramPaletteSignature(readDiagramPalette({} as HTMLElement));

    install({ ...DARK, '--accent': '#ff0000' }, workingCanvas());
    const b = diagramPaletteSignature(readDiagramPalette({} as HTMLElement));

    expect(b).not.toBe(a);
  });

  it('is byte-stable across identical reads', () => {
    // This is what stops ThemePreferenceWatcher's unconditional
    // `data-theme` write from re-rendering every diagram on page load.
    install(DARK, workingCanvas());
    const a = diagramPaletteSignature(readDiagramPalette({} as HTMLElement));
    const b = diagramPaletteSignature(readDiagramPalette({} as HTMLElement));
    expect(b).toBe(a);
  });
});

describe('buildMermaidConfig', () => {
  it('pins the security posture', () => {
    install(DARK, workingCanvas());
    const cfg = buildMermaidConfig(readDiagramPalette({} as HTMLElement));
    // 'loose' re-enables click callbacks AND drops Mermaid's own
    // DOMPurify pass; 'sandbox' returns an <iframe src="data:…"> that
    // default-src 'self' blocks. Neither is a tuning knob.
    expect(cfg.securityLevel).toBe('strict');
    expect(cfg.startOnLoad).toBe(false);
    expect(cfg.suppressErrorRendering).toBe(true);
  });

  it('keeps the tenant-boundary limits below Mermaid defaults', () => {
    install(DARK, workingCanvas());
    const cfg = buildMermaidConfig(readDiagramPalette({} as HTMLElement));
    expect(cfg.maxTextSize).toBeLessThan(50_000);
    expect(cfg.maxEdges).toBeLessThan(500);
  });

  it('overrides the note background, which defaults to a hard-coded yellow', () => {
    install(DARK, workingCanvas());
    const p = readDiagramPalette({} as HTMLElement);
    expect(buildMermaidThemeVariables(p).noteBkgColor).toBe(p.surface);
  });

  it('keeps edgeLabelBackground equal to background, or labels halo', () => {
    install(DARK, workingCanvas());
    const vars = buildMermaidThemeVariables(
      readDiagramPalette({} as HTMLElement),
    );
    expect(vars.edgeLabelBackground).toBe(vars.background);
  });
});
