import {
  isDarkColor,
  readCssVar,
  resetCssColorCache,
  toSrgbHex,
} from './css-color';

/**
 * Node environment with stubbed globals, following the `cookies.spec.ts`
 * convention — these helpers touch `getComputedStyle`, `document` and a
 * 2D context, and a hand-built fake context is strictly better than
 * jsdom here: jsdom ships no canvas at all, so it could only ever
 * exercise the `null` branch.
 *
 * **What this file cannot prove.** The fake context below emulates the
 * two behaviours `toSrgbHex` depends on — an invalid `fillStyle`
 * assignment is a no-op, and out-of-sRGB colours are gamut-mapped on
 * rasterization — but emulating them is not the same as demonstrating
 * that a real browser does them. In particular the real trap, that
 * `ctx.fillStyle` *getter* hands `oklch(…)` straight back rather than
 * converting, is asserted here only because the fake reproduces it. The
 * conversion itself is verified in Chromium and Safari; see the plan's
 * verification section.
 */

declare let global: {
  document?: { createElement: (tag: string) => unknown };
  getComputedStyle?: (el: unknown) => { getPropertyValue: (n: string) => string };
};

interface FakeCtx {
  fillStyle: string;
  clearRect: () => void;
  fillRect: () => void;
  getImageData: () => { data: number[] };
}

/** Colours the fake "browser" can parse, and the sRGB bytes they map to. */
const KNOWN: Record<string, [number, number, number, number]> = {
  '#010203': [1, 2, 3, 255],
  '#040506': [4, 5, 6, 255],
  '#0a0a0a': [10, 10, 10, 255],
  '#fafaf9': [250, 250, 249, 255],
  '#c8c8c8': [200, 200, 200, 255],
  // Out of sRGB: the getter keeps modern syntax, rasterization maps it.
  'oklch(0.86 0.18 125)': [166, 240, 60, 255],
  'oklch(0.86 0.18 125 / 0.35)': [166, 240, 60, 89],
  transparent: [0, 0, 0, 0],
};

function makeCtx(opts: { throwOnRead?: boolean } = {}): FakeCtx {
  let current: [number, number, number, number] = [0, 0, 0, 0];
  let painted: [number, number, number] = [0, 0, 0];
  let stored = '#000000';

  return {
    get fillStyle() {
      return stored;
    },
    set fillStyle(next: string) {
      const parsed = KNOWN[next];
      // The spec'd behaviour this module leans on: an unparseable value
      // leaves the previous one in place.
      if (!parsed) return;
      current = parsed;
      // ...and the trap: the getter serializes what was STORED, keeping
      // modern syntax for out-of-sRGB colours rather than converting.
      stored = next;
    },
    clearRect() {
      painted = [0, 0, 0];
    },
    fillRect() {
      const [r, g, b, a] = current;
      const alpha = a / 255;
      painted = [
        painted[0] * (1 - alpha) + r * alpha,
        painted[1] * (1 - alpha) + g * alpha,
        painted[2] * (1 - alpha) + b * alpha,
      ];
    },
    getImageData() {
      if (opts.throwOnRead) throw new Error('SecurityError');
      return { data: [...painted.map(Math.round), 255] };
    },
  } as FakeCtx;
}

function installCanvas(ctx: FakeCtx | null) {
  resetCssColorCache();
  global.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
}

afterEach(() => {
  resetCssColorCache();
  delete global.document;
  delete global.getComputedStyle;
});

describe('toSrgbHex', () => {
  it('converts an oklch token to sRGB hex rather than echoing it back', () => {
    installCanvas(makeCtx());
    // The whole point: khroma throws on oklch, and a fillStyle getter
    // round-trip would have returned the oklch string unchanged.
    expect(toSrgbHex('oklch(0.86 0.18 125)', '#0a0a0a')).toBe('#a6f03c');
  });

  it('flattens alpha against the supplied background', () => {
    installCanvas(makeCtx());
    // 35% of the accent over near-black. Read back un-premultiplied this
    // would carry visible rounding error; composited it does not.
    expect(toSrgbHex('oklch(0.86 0.18 125 / 0.35)', '#0a0a0a')).toBe('#405a1b');
  });

  it('returns null for a value the browser cannot parse', () => {
    installCanvas(makeCtx());
    expect(toSrgbHex('not-a-color', '#0a0a0a')).toBeNull();
  });

  it('classifies a fully transparent colour as PARSEABLE, not as a failure', () => {
    installCanvas(makeCtx());
    // The regression this guards: deciding parseability by compositing
    // over two different backgrounds makes `transparent` indistinguishable
    // from an unparseable value, because both reads equal their
    // background. Parseability is decided from the getter alone.
    expect(toSrgbHex('transparent', '#0a0a0a')).toBe('#0a0a0a');
  });

  it('still parses a value that happens to equal a sentinel', () => {
    installCanvas(makeCtx());
    // One sentinel could not tell "assignment was a no-op" from "the
    // colour really is #010203". Two can.
    expect(toSrgbHex('#010203', '#0a0a0a')).toBe('#010203');
  });

  it('returns null when the pixel cannot be read', () => {
    installCanvas(makeCtx({ throwOnRead: true }));
    expect(toSrgbHex('oklch(0.86 0.18 125)', '#0a0a0a')).toBeNull();
  });

  it('returns null when there is no 2D context at all (the jsdom shape)', () => {
    installCanvas(null);
    expect(toSrgbHex('oklch(0.86 0.18 125)', '#0a0a0a')).toBeNull();
  });

  it('returns null when the background itself is unparseable', () => {
    installCanvas(makeCtx());
    // Better to fall back than to composite over whatever was left in
    // the context and report a confidently wrong colour.
    expect(toSrgbHex('#010203', 'not-a-color')).toBeNull();
  });

  it('returns null for an empty token (an unset custom property)', () => {
    installCanvas(makeCtx());
    expect(toSrgbHex('', '#0a0a0a')).toBeNull();
  });
});

describe('isDarkColor', () => {
  it.each<[string, boolean]>([
    ['#0a0a0a', true],
    ['#fafaf9', false],
    ['#fff', false],
    ['#000', true],
    ['rgb(10, 10, 10)', true],
    ['rgba(250, 250, 249, 1)', false],
  ])('%s → dark=%s', (value, expected) => {
    expect(isDarkColor(value)).toBe(expected);
  });

  it('reports false for anything it cannot read, matching the dark default', () => {
    expect(isDarkColor('oklch(0.86 0.18 125)')).toBe(false);
  });
});

describe('readCssVar', () => {
  it('trims, because computed custom properties keep their leading space', () => {
    global.getComputedStyle = () => ({ getPropertyValue: () => ' #0a0a0a ' });
    expect(readCssVar({} as Element, '--bg')).toBe('#0a0a0a');
  });
});
