/**
 * CSS colour resolution for consumers that cannot accept modern colour
 * syntax — currently the Mermaid diagram theme (`diagram-theme.ts`).
 *
 * ## Why this exists
 *
 * Mermaid derives most of its palette from a few seed colours using
 * khroma, whose parser accepts hex, `rgb()`, `hsl()` and CSS keywords
 * and **throws** on anything else. Weavestream's tokens are a mix:
 * `--bg`, `--surface`, `--panel*`, `--line*`, `--text*`, `--muted`,
 * `--dim` and `--faint` are plain hex, but `--accent`, `--accent-soft`,
 * `--accent-line`, `--warn`, `--danger`, `--ok`, `--info` and every
 * `--layout-*` are `oklch()`. Handing a raw token straight to Mermaid
 * therefore crashes every diagram render, so the oklch ones have to be
 * converted to sRGB first.
 *
 * ## Why the conversion is two separate steps
 *
 * The obvious implementation — assign to `ctx.fillStyle`, read it back —
 * does **not** convert. The getter is specified to serialize the stored
 * colour, and for colours outside sRGB it keeps the modern syntax, so
 * `oklch(…)` goes in and `oklch(…)` (or `color(…)`) comes back out. That
 * would sail past a sentinel check and hand khroma the exact input this
 * module exists to prevent.
 *
 * So:
 *
 *  1. **Parseability** is decided from the `fillStyle` *getter* alone.
 *     Assigning an invalid value is spec'd as a no-op, so a value that
 *     leaves two different sentinels untouched was never applied. Two
 *     sentinels rather than one because a colour that genuinely equals
 *     the sentinel would otherwise look like a failed assignment. No
 *     compositing happens here, which is what keeps `transparent` and
 *     `rgba(0,0,0,0)` correctly classified as *parseable*.
 *  2. **Conversion** rasterizes once and reads the pixel back. That is a
 *     real conversion, performed by the browser's own colour pipeline.
 *
 * ## Documented consequences
 *
 *  - **Wide-gamut loss.** `oklch(0.86 0.18 125)` sits outside sRGB; an
 *    ordinary 2D context gamut-maps it, so the hex handed to Mermaid is
 *    a slightly duller sRGB neighbour of the accent painted on a P3
 *    display. Accepted — khroma cannot consume P3 at all.
 *  - **Alpha is flattened, deliberately.** `getImageData` un-premultiplies,
 *    so a low-alpha token like `--accent-line` (α 0.35) reads back with
 *    visible rounding error. Compositing over an opaque background first
 *    avoids that entirely, and the flattened colour is what the diagram
 *    should show anyway.
 *  - **`null` is a real outcome**, not a theoretical one: jsdom has no
 *    canvas (`getContext('2d')` returns `null` without the optional
 *    `canvas` package), privacy extensions block `getImageData`, and an
 *    older browser may not parse `oklch()`. Callers must have a fallback
 *    — see `readDiagramPalette`.
 *
 * Nothing here is proven by the jsdom suite, which takes the `null`
 * branch throughout. The conversion is verified in a real browser.
 */

/** Trimmed value of a custom property on `el`, or `''` when unset. */
export function readCssVar(el: Element, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

/** Distinct, deliberately unremarkable colours. See `toSrgbHex` step 1. */
const SENTINEL_A = '#010203';
const SENTINEL_B = '#040506';

const HEX6 = /^#[0-9a-f]{6}$/;

let cachedContext: CanvasRenderingContext2D | null | undefined;

/**
 * A 1×1 offscreen context, created once and never attached to the
 * document. `undefined` means "not tried yet"; `null` is cached too, so
 * a hostile or absent canvas costs one attempt rather than one per
 * colour.
 */
function context2d(): CanvasRenderingContext2D | null {
  if (cachedContext !== undefined) return cachedContext;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    cachedContext = canvas.getContext('2d', { willReadFrequently: true });
  } catch {
    cachedContext = null;
  }
  return cachedContext;
}

/** Test seam: forget the cached context so a spec can swap the canvas. */
export function resetCssColorCache(): void {
  cachedContext = undefined;
}

/**
 * Whether the browser's CSS parser accepts `value` as a colour.
 *
 * Reads only the `fillStyle` getter — no pixels are touched — because
 * this question is about parsing, not about what the colour looks like.
 * The sentinel serializations are captured from the browser rather than
 * assumed, so no serialization format is baked in here.
 */
function parsesAsColor(ctx: CanvasRenderingContext2D, value: string): boolean {
  ctx.fillStyle = SENTINEL_A;
  const serializedA = ctx.fillStyle;
  ctx.fillStyle = value;
  const afterA = ctx.fillStyle;

  ctx.fillStyle = SENTINEL_B;
  const serializedB = ctx.fillStyle;
  ctx.fillStyle = value;
  const afterB = ctx.fillStyle;

  // Unchanged against BOTH sentinels means the assignment was a no-op
  // both times, i.e. the value never parsed. Unchanged against only one
  // means the value genuinely is that sentinel's colour.
  return afterA !== serializedA || afterB !== serializedB;
}

/**
 * Normalize any CSS `<color>` to opaque `#rrggbb`, composited over
 * `over`, or `null` when the browser cannot parse it or the pixel cannot
 * be read.
 *
 * `over` is the background this colour sits on — always `--bg` in
 * practice — and must itself be an opaque colour the browser can parse;
 * an unparseable `over` yields `null` rather than a silently wrong
 * result.
 */
export function toSrgbHex(value: string, over: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;

  const ctx = context2d();
  if (!ctx) return null;

  if (!parsesAsColor(ctx, trimmed) || !parsesAsColor(ctx, over.trim())) {
    return null;
  }

  try {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = over.trim();
    ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = trimmed;
    ctx.fillRect(0, 0, 1, 1);

    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    if (r === undefined || g === undefined || b === undefined) return null;

    const hex = `#${byte(r)}${byte(g)}${byte(b)}`;
    // The allowlist is the backstop: whatever any browser's colour
    // serialization does, a value that is not plain opaque hex never
    // reaches khroma from here.
    return HEX6.test(hex) ? hex : null;
  } catch {
    // getImageData throws SecurityError on a tainted canvas and is
    // blocked outright by some privacy extensions. Neither is worth
    // propagating — the caller's fallback palette is the answer.
    return null;
  }
}

function byte(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, '0');
}

/**
 * WCAG relative luminance below 0.5.
 *
 * Pure and canvas-free so it works in the jsdom suite and in Node: it
 * accepts the already-simple forms the tokens use (`#rgb`, `#rrggbb`,
 * `rgb()`, `rgba()`) and reports `false` for anything it cannot read,
 * which pairs with dark being this product's default theme.
 */
export function isDarkColor(value: string): boolean {
  const rgb = parseSimpleRgb(value.trim());
  if (!rgb) return false;
  const [r, g, b] = rgb;
  const lum =
    0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
  return lum < 0.5;
}

function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function parseSimpleRgb(value: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const digits = hex[1]!;
    const full =
      digits.length === 3
        ? digits
            .split('')
            .map((d) => d + d)
            .join('')
        : digits;
    return [
      Number.parseInt(full.slice(0, 2), 16),
      Number.parseInt(full.slice(2, 4), 16),
      Number.parseInt(full.slice(4, 6), 16),
    ];
  }

  const fn = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (!fn) return null;
  const parts = fn[1]!
    .split(/[\s,/]+/)
    .filter((p) => p !== '')
    .slice(0, 3)
    .map((p) => (p.endsWith('%') ? (Number.parseFloat(p) * 255) / 100 : Number.parseFloat(p)));
  if (parts.length < 3 || parts.some((p) => !Number.isFinite(p))) return null;
  return [parts[0]!, parts[1]!, parts[2]!];
}
