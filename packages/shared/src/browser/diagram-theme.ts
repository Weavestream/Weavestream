import { isDarkColor, readCssVar, toSrgbHex } from './css-color.js';

/**
 * Mermaid theming, derived from Weavestream's own colour tokens.
 *
 * ## Design intent
 *
 * Structure is neutral; the accent marks emphasis. A node reads like
 * `.sd-editor code` — a `--panel-2` surface with a hairline border — and
 * the accent appears where the app already uses `--accent-line`: as the
 * structural line on a content surface. That is what makes a diagram
 * look native rather than bolted on, in both themes and all five
 * accents.
 *
 * ## Why every value is resolved rather than passed as `var(--x)`
 *
 * Mermaid's colour maths (khroma) throws on `var()` and on `oklch()`, so
 * `themeVariables` must contain literal, already-sRGB colours. See
 * `css-color.ts` for how that conversion works and where it can fail.
 *
 * ## Why `darkMode` comes from `--bg` and not from `data-theme`
 *
 * Under `data-theme-pref="system"` the stamped `data-theme` says `dark`
 * while `color-tokens.css`'s `prefers-color-scheme: light` media block
 * has already painted the light palette. Reading the resolved token is
 * correct from the first frame, before any watcher converges — one fewer
 * flash. It also matters functionally: `darkMode` drives khroma's
 * lighten/darken direction, so a wrong value inverts every colour
 * Mermaid derives.
 */

export interface DiagramPalette {
  bg: string;
  surface: string;
  panel: string;
  panel2: string;
  elev: string;
  line: string;
  line2: string;
  line3: string;
  faint: string;
  text: string;
  text2: string;
  muted: string;
  dim: string;
  accent: string;
  accentLine: string;
  accentInk: string;
  danger: string;
  warn: string;
  ok: string;
  info: string;
  fontFamily: string;
  darkMode: boolean;
}

/**
 * Tokens that are plain hex in `color-tokens.css` and therefore need no
 * conversion. Anything not listed here is `oklch()` and goes through
 * `toSrgbHex`, falling back to one of these when that returns `null`.
 */
interface TokenSpec {
  readonly varName: string;
  /** Token to fall back to when conversion fails. Must be a hex token. */
  readonly fallback?: string;
}

const TOKENS = {
  bg: { varName: '--bg' },
  surface: { varName: '--surface' },
  panel: { varName: '--panel' },
  panel2: { varName: '--panel-2' },
  elev: { varName: '--elev' },
  line: { varName: '--line' },
  line2: { varName: '--line-2' },
  line3: { varName: '--line-3' },
  faint: { varName: '--faint' },
  text: { varName: '--text' },
  text2: { varName: '--text-2' },
  muted: { varName: '--muted' },
  dim: { varName: '--dim' },
  // The oklch ones. Every fallback is a token that is already hex, so a
  // browser without oklch support (or with a blocked canvas) gets a
  // monochrome but on-theme diagram rather than a wrong-coloured one.
  accent: { varName: '--accent', fallback: '--text-2' },
  accentLine: { varName: '--accent-line', fallback: '--line-3' },
  accentInk: { varName: '--accent-ink', fallback: '--bg' },
  danger: { varName: '--danger', fallback: '--text-2' },
  warn: { varName: '--warn', fallback: '--text-2' },
  ok: { varName: '--ok', fallback: '--text-2' },
  info: { varName: '--info', fallback: '--text-2' },
} as const satisfies Record<string, TokenSpec>;

/** Last-resort colours if even the hex tokens are missing (no stylesheet). */
const HARD_FALLBACK: Record<string, string> = {
  '--bg': '#0a0a0a',
  '--surface': '#111111',
  '--panel': '#161616',
  '--panel-2': '#1c1c1c',
  '--elev': '#202020',
  '--line': '#222222',
  '--line-2': '#2a2a2a',
  '--line-3': '#333333',
  '--faint': '#3a3a3a',
  '--text': '#ededed',
  '--text-2': '#c8c8c8',
  '--muted': '#8a8a8a',
  '--dim': '#858585',
};

/**
 * Read the live palette off `root`.
 *
 * `fontSource` supplies the resolved `font-family` — pass the article
 * body. The token is a `var()` chain (`var(--font-sans-loaded, …)`), so
 * only the *computed* value carries next/font's generated family name,
 * and it is already correctly quoted for CSS.
 */
export function readDiagramPalette(
  root: HTMLElement,
  fontSource?: HTMLElement,
): DiagramPalette {
  const raw = (name: string): string => readCssVar(root, name);

  const hexOf = (name: string): string => {
    const value = raw(name);
    if (value === '') return HARD_FALLBACK[name] ?? '#000000';
    return value;
  };

  const bg = hexOf('--bg');

  const resolve = (spec: TokenSpec): string => {
    const value = raw(spec.varName);
    if (spec.fallback === undefined) {
      // Already hex in the stylesheet; nothing to convert.
      return value === ''
        ? (HARD_FALLBACK[spec.varName] ?? '#000000')
        : value;
    }
    const converted = value === '' ? null : toSrgbHex(value, bg);
    return converted ?? hexOf(spec.fallback);
  };

  const fontFamily =
    (fontSource ? getComputedStyle(fontSource).fontFamily : '') ||
    getComputedStyle(root).fontFamily ||
    'sans-serif';

  return {
    bg,
    surface: resolve(TOKENS.surface),
    panel: resolve(TOKENS.panel),
    panel2: resolve(TOKENS.panel2),
    elev: resolve(TOKENS.elev),
    line: resolve(TOKENS.line),
    line2: resolve(TOKENS.line2),
    line3: resolve(TOKENS.line3),
    faint: resolve(TOKENS.faint),
    text: resolve(TOKENS.text),
    text2: resolve(TOKENS.text2),
    muted: resolve(TOKENS.muted),
    dim: resolve(TOKENS.dim),
    accent: resolve(TOKENS.accent),
    accentLine: resolve(TOKENS.accentLine),
    accentInk: resolve(TOKENS.accentInk),
    danger: resolve(TOKENS.danger),
    warn: resolve(TOKENS.warn),
    ok: resolve(TOKENS.ok),
    info: resolve(TOKENS.info),
    fontFamily,
    darkMode: isDarkColor(bg),
  };
}

/**
 * Stable string that changes exactly when a rendered diagram would need
 * to be redrawn.
 *
 * Callers memoize on this rather than on the `data-theme` attribute:
 * `ThemePreferenceWatcher` writes that attribute unconditionally on
 * mount — even `dark` → `dark` produces a MutationRecord — so an
 * attribute-keyed memo would re-render every diagram on every article
 * load, visibly, for no change.
 */
export function diagramPaletteSignature(p: DiagramPalette): string {
  return [
    p.bg,
    p.surface,
    p.panel,
    p.panel2,
    p.elev,
    p.line,
    p.line2,
    p.line3,
    p.faint,
    p.text,
    p.text2,
    p.muted,
    p.dim,
    p.accent,
    p.accentLine,
    p.accentInk,
    p.danger,
    p.warn,
    p.ok,
    p.info,
    p.fontFamily,
    p.darkMode ? 'dark' : 'light',
  ].join('|');
}

/**
 * `themeVariables` for Mermaid's `base` theme.
 *
 * Every value here must be hex, `rgb()`, `hsl()` or a CSS keyword —
 * khroma throws on anything else, and it is called on most of these to
 * derive the colours Mermaid does not take directly. The shared spec
 * asserts that no `oklch(`, `lab(`, `color(` or `var(` ever appears in
 * the output; that single assertion is the reason `css-color.ts` exists.
 */
export function buildMermaidThemeVariables(
  p: DiagramPalette,
): Record<string, string | boolean> {
  return {
    darkMode: p.darkMode,
    background: p.panel,
    fontFamily: p.fontFamily,
    fontSize: '14px',

    // Core / flowchart. `--accent-line` is the accent's whole role:
    // the structural line on a content surface, matching `.sd-editor a`.
    primaryColor: p.panel2,
    mainBkg: p.panel2,
    primaryTextColor: p.text,
    nodeTextColor: p.text,
    primaryBorderColor: p.accentLine,
    nodeBorder: p.accentLine,
    secondaryColor: p.elev,
    secondaryTextColor: p.text2,
    secondaryBorderColor: p.line3,
    tertiaryColor: p.surface,
    tertiaryTextColor: p.text2,
    tertiaryBorderColor: p.line2,
    lineColor: p.muted,
    defaultLinkColor: p.muted,
    textColor: p.text2,
    titleColor: p.text,
    labelColor: p.text,
    // Must equal `background`, or edge labels paint a halo over the edge.
    edgeLabelBackground: p.panel,
    clusterBkg: p.surface,
    clusterBorder: p.line2,
    errorBkgColor: p.panel2,
    errorTextColor: p.danger,

    // Notes. `noteBkgColor` MUST be overridden — Mermaid's default is a
    // hard-coded yellow that belongs to no theme we ship.
    noteBkgColor: p.surface,
    noteTextColor: p.text2,
    noteBorderColor: p.line3,

    // Sequence.
    actorBkg: p.panel2,
    actorBorder: p.accentLine,
    actorTextColor: p.text,
    actorLineColor: p.line3,
    signalColor: p.text2,
    signalTextColor: p.text2,
    labelBoxBkgColor: p.panel2,
    labelBoxBorderColor: p.line3,
    labelTextColor: p.text,
    loopTextColor: p.text2,
    activationBkgColor: p.elev,
    // Opaque accent reads as "active", the same way it does in the app.
    activationBorderColor: p.accent,
    sequenceNumberColor: p.accentInk,

    // State / class / ER.
    altBackground: p.surface,
    classText: p.text,
    attributeBackgroundColorOdd: p.panel2,
    attributeBackgroundColorEven: p.surface,

    // Gantt.
    sectionBkgColor: p.surface,
    sectionBkgColor2: p.panel2,
    altSectionBkgColor: p.panel,
    gridColor: p.line2,
    taskBkgColor: p.panel2,
    taskBorderColor: p.accentLine,
    taskTextColor: p.text,
    taskTextDarkColor: p.text,
    taskTextLightColor: p.text,
    taskTextOutsideColor: p.text2,
    activeTaskBkgColor: p.elev,
    activeTaskBorderColor: p.accent,
    doneTaskBkgColor: p.surface,
    doneTaskBorderColor: p.line3,
    critBkgColor: p.panel2,
    critBorderColor: p.danger,
    todayLineColor: p.accent,

    // Categorical ramps (pie / journey / quadrant / git). Deliberately
    // short: past four, Mermaid derives the rest from these, which keeps
    // a twelve-slice pie on-brand without inventing eight more tokens.
    pie1: p.accent,
    pie2: p.info,
    pie3: p.warn,
    pie4: p.ok,
    pieTitleTextColor: p.text,
    pieLegendTextColor: p.text2,
    pieSectionTextColor: p.accentInk,
    pieStrokeColor: p.panel,
    pieOuterStrokeColor: p.line2,
    cScale0: p.accent,
    cScale1: p.info,
    cScale2: p.warn,
    git0: p.accent,
    git1: p.info,
    git2: p.warn,
    git3: p.ok,
    git4: p.danger,
    gitBranchLabel0: p.accentInk,
    commitLabelColor: p.text2,
    commitLabelBackground: p.panel,
  };
}

/**
 * The handful of things `themeVariables` cannot reach.
 *
 * Kept small on purpose — every rule here is one Mermaid could start
 * emitting differently on a minor version. `.marker` is the load-bearing
 * one: arrowheads ignore `lineColor` in several diagram types.
 */
function buildThemeCss(p: DiagramPalette): string {
  return [
    `.edgeLabel, .edgeLabel p { background: ${p.panel}; color: ${p.text2}; }`,
    `.cluster-label text, .cluster-label span { fill: ${p.text}; color: ${p.text}; }`,
    `.nodeLabel p, .edgeLabel p { margin: 0; }`,
    `.marker { fill: ${p.muted}; stroke: ${p.muted}; }`,
  ].join('\n');
}

export interface MermaidLikeConfig {
  theme: 'base';
  securityLevel: 'strict';
  startOnLoad: false;
  suppressErrorRendering: boolean;
  htmlLabels: boolean;
  maxTextSize: number;
  maxEdges: number;
  flowchart: { curve: string; useMaxWidth: boolean };
  themeVariables: Record<string, string | boolean>;
  themeCSS: string;
}

/**
 * The full Mermaid config, palette included.
 *
 * `securityLevel` is `'strict'` and must stay there. `'loose'` re-enables
 * `click` callbacks *and* removes the DOMPurify pass Mermaid runs over
 * its own output; `'sandbox'` returns an `<iframe src="data:…">`, which
 * this app's `default-src 'self'` blocks outright. Neither is a tuning
 * knob.
 *
 * `maxTextSize` / `maxEdges` are tightened well below Mermaid's defaults
 * (50000 / 500) because article markdown is authored by MSP admins but
 * rendered to client-portal users — it crosses a tenant boundary, so a
 * pathological diagram is somebody else's blocked main thread.
 */
export function buildMermaidConfig(p: DiagramPalette): MermaidLikeConfig {
  return {
    theme: 'base',
    securityLevel: 'strict',
    startOnLoad: false,
    // Stops Mermaid appending its own error SVG into the measuring host
    // on a parse failure; the caller renders the fallback instead.
    suppressErrorRendering: true,
    // The default, and the far better-tested path: labels wrap properly
    // and support Mermaid's own markdown. It requires `<foreignObject>`
    // to survive sanitization, which `diagram-svg.ts` pins with a test.
    htmlLabels: true,
    maxTextSize: 20_000,
    maxEdges: 250,
    flowchart: { curve: 'basis', useMaxWidth: true },
    themeVariables: buildMermaidThemeVariables(p),
    themeCSS: buildThemeCss(p),
  };
}
