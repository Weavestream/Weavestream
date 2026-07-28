import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { uiAccentValues, uiThemeValues, type UiAccent, type UiTheme } from '@weavestream/shared';

type ResolvedTheme = 'dark' | 'light';
type Rgb = { r: number; g: number; b: number; alpha: number };
type Lab = { l: number; a: number; b: number };
type TokenMap = Record<string, string>;

const sharedCss = readFileSync(
  resolve(__dirname, '../../../../packages/shared/styles/color-tokens.css'),
  'utf8',
);
const mobileCss = readFileSync(resolve(__dirname, 'tokens.css'), 'utf8');

function declarations(css: string, selector: string): TokenMap {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`));
  const body = block?.[1];
  if (!body) throw new Error(`Missing CSS block: ${selector}`);

  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => {
      const name = match[1];
      const value = match[2];
      if (!name || !value) throw new Error(`Malformed declaration in ${selector}`);
      return [name, value.trim()];
    }),
  );
}

const sharedRoot = declarations(sharedCss, ':root');
const sharedLight = declarations(sharedCss, "[data-theme='light']");
const sharedSystemLight = declarations(sharedCss, "  html[data-theme-pref='system']");
const mobileRoot = declarations(mobileCss, ':root');
const mobileLight = declarations(mobileCss, "[data-theme='light']");
const mobileSystemLight = declarations(mobileCss, "  html[data-theme-pref='system']");

function accentTokens(
  css: string,
  accent: UiAccent,
  theme: ResolvedTheme,
  system: boolean,
): TokenMap {
  if (theme === 'dark') {
    return declarations(css, `[data-accent='${accent}']`);
  }
  const selector = system
    ? `  html[data-theme-pref='system'][data-accent='${accent}']`
    : `[data-theme='light'][data-accent='${accent}']`;
  return declarations(css, selector);
}

function palette(themePref: UiTheme, resolvedTheme: ResolvedTheme, accent: UiAccent): TokenMap {
  const systemLight = themePref === 'system' && resolvedTheme === 'light';
  return {
    ...sharedRoot,
    ...(resolvedTheme === 'light' ? (systemLight ? sharedSystemLight : sharedLight) : {}),
    ...accentTokens(sharedCss, accent, resolvedTheme, systemLight),
    ...mobileRoot,
    ...(resolvedTheme === 'light' ? (systemLight ? mobileSystemLight : mobileLight) : {}),
  };
}

function hexToRgb(hex: string): Rgb {
  let digits = hex.slice(1);
  if (digits.length === 3) {
    digits = [...digits].map((digit) => digit.repeat(2)).join('');
  }
  if (digits.length !== 6) throw new Error(`Unsupported hex color: ${hex}`);
  return {
    r: Number.parseInt(digits.slice(0, 2), 16) / 255,
    g: Number.parseInt(digits.slice(2, 4), 16) / 255,
    b: Number.parseInt(digits.slice(4, 6), 16) / 255,
    alpha: 1,
  };
}

function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function toGamma(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

function rgbToLab(color: Rgb): Lab {
  const r = toLinear(color.r);
  const g = toLinear(color.g);
  const b = toLinear(color.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function labToRgb({ l, a, b }: Lab, alpha = 1): Rgb {
  const lRoot = l + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = l - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = l - 0.0894841775 * a - 1.291485548 * b;
  const lCone = lRoot ** 3;
  const mCone = mRoot ** 3;
  const sCone = sRoot ** 3;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return {
    r: clamp(toGamma(4.0767416621 * lCone - 3.3077115913 * mCone + 0.2309699292 * sCone)),
    g: clamp(toGamma(-1.2684380046 * lCone + 2.6097574011 * mCone - 0.3413193965 * sCone)),
    b: clamp(toGamma(-0.0041960863 * lCone - 0.7034186147 * mCone + 1.707614701 * sCone)),
    alpha,
  };
}

function parseColor(value: string, tokens: TokenMap, seen = new Set<string>()): Rgb {
  const input = value.trim();
  const variable = input.match(/^var\((--[\w-]+)\)$/);
  if (variable) {
    const name = variable[1];
    if (!name) throw new Error(`Malformed CSS variable: ${input}`);
    if (seen.has(name)) throw new Error(`Circular CSS variable: ${name}`);
    const token = tokenValue(tokens, name);
    return parseColor(token, tokens, new Set([...seen, name]));
  }
  if (input.startsWith('#')) return hexToRgb(input);
  if (input === 'black') return hexToRgb('#000');
  if (input === 'white') return hexToRgb('#fff');

  const oklch = input.match(/^oklch\(([\d.]+)\s+([\d.]+)\s+([-\d.]+)(?:\s*\/\s*([\d.]+))?\)$/);
  if (oklch) {
    const [, lightnessValue, chromaValue, hueValue, alphaValue] = oklch;
    if (!lightnessValue || !chromaValue || !hueValue) {
      throw new Error(`Malformed oklch color: ${input}`);
    }
    const lightness = Number(lightnessValue);
    const chroma = Number(chromaValue);
    const hue = (Number(hueValue) * Math.PI) / 180;
    return labToRgb(
      {
        l: lightness,
        a: chroma * Math.cos(hue),
        b: chroma * Math.sin(hue),
      },
      alphaValue === undefined ? 1 : Number(alphaValue),
    );
  }

  const mix = input.match(/^color-mix\(in oklab,\s*(.+)\s+([\d.]+)%,\s*(black|white)\)$/);
  if (mix) {
    const [, foregroundValue, weightValue, endpointValue] = mix;
    if (!foregroundValue || !weightValue || !endpointValue) {
      throw new Error(`Malformed color mix: ${input}`);
    }
    const foreground = rgbToLab(parseColor(foregroundValue, tokens, seen));
    const endpoint = rgbToLab(parseColor(endpointValue, tokens, seen));
    const weight = Number(weightValue) / 100;
    return labToRgb({
      l: foreground.l * weight + endpoint.l * (1 - weight),
      a: foreground.a * weight + endpoint.a * (1 - weight),
      b: foreground.b * weight + endpoint.b * (1 - weight),
    });
  }

  throw new Error(`Unsupported CSS color: ${input}`);
}

function tokenValue(tokens: TokenMap, name: string): string {
  const value = tokens[name];
  if (!value) throw new Error(`Missing CSS variable: ${name}`);
  return value;
}

function composite(foreground: Rgb, background: Rgb): Rgb {
  const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha);
  return {
    r:
      (foreground.r * foreground.alpha + background.r * background.alpha * (1 - foreground.alpha)) /
      alpha,
    g:
      (foreground.g * foreground.alpha + background.g * background.alpha * (1 - foreground.alpha)) /
      alpha,
    b:
      (foreground.b * foreground.alpha + background.b * background.alpha * (1 - foreground.alpha)) /
      alpha,
    alpha,
  };
}

function luminance(color: Rgb): number {
  return 0.2126 * toLinear(color.r) + 0.7152 * toLinear(color.g) + 0.0722 * toLinear(color.b);
}

function contrast(foreground: Rgb, background: Rgb): number {
  const fg = luminance(composite(foreground, background));
  const bg = luminance(background);
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

function resolvedThemes(theme: UiTheme): ResolvedTheme[] {
  return theme === 'system' ? ['dark', 'light'] : [theme];
}

function expectContrast(
  tokens: TokenMap,
  foreground: string,
  background: string,
  minimum: number,
  context: string,
) {
  const ratio = contrast(
    parseColor(tokenValue(tokens, foreground), tokens),
    parseColor(tokenValue(tokens, background), tokens),
  );
  if (ratio < minimum) {
    throw new Error(
      `${context}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1; ` +
        `expected at least ${minimum}:1`,
    );
  }
}

describe('mobile color-token contrast', () => {
  for (const themePref of uiThemeValues) {
    for (const resolvedTheme of resolvedThemes(themePref)) {
      for (const accent of uiAccentValues) {
        const context = `${accent}, ${themePref} preference, ${resolvedTheme} resolved`;
        const tokens = palette(themePref, resolvedTheme, accent);

        describe(context, () => {
          for (const background of ['--bg', '--surface', '--panel-2']) {
            it(`keeps the neutral text ladder readable on ${background}`, () => {
              expectContrast(tokens, '--text-2', background, 6, context);
              expectContrast(tokens, '--muted', background, 6, context);
              expectContrast(tokens, '--dim', background, 4.5, context);
            });

            it(`keeps mobile accent text readable on ${background}`, () => {
              expectContrast(tokens, '--accent-text', background, 4.5, context);

              const base = parseColor(tokenValue(tokens, background), tokens);
              const soft = composite(parseColor(tokenValue(tokens, '--accent-soft'), tokens), base);
              const ratio = contrast(parseColor(tokenValue(tokens, '--accent-deep'), tokens), soft);
              expect(ratio).toBeGreaterThanOrEqual(4.5);
            });
          }

          it('keeps accent fills readable at rest and while pressed', () => {
            expectContrast(tokens, '--accent-ink', '--accent', 4.5, context);
            expectContrast(tokens, '--accent-ink', '--accent-pressed', 4.5, context);
          });
        });
      }
    }
  }
});
