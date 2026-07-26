/**
 * Defensive extractors for Tiptap node attributes.
 *
 * `normaliseTiptapDoc` validates only the ROOT of a stored doc; every
 * attr below it is untrusted `unknown` (CLAUDE.md §3/§7 — stored docs
 * are user input). React throws outright on object-valued children, so
 * nothing from `attrs` may reach JSX without passing through one of
 * these.
 */

/** The value iff it is a string, else null. Never coerces. */
export function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * A clamped integer from a finite number or a strictly numeric string.
 * Deliberately NOT `Number(v)`: `Number(true)`, `Number([])`, and
 * `Number('')` are all "valid" coercions (1, 0, 0) and must be rejected
 * — a boolean colspan is malformed data, not a span of 1.
 */
export function boundedInt(v: unknown, min: number, max: number): number | undefined {
  let n: number;
  if (typeof v === 'number' && Number.isFinite(v)) {
    n = Math.trunc(v);
  } else if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) {
    n = parseInt(v.trim(), 10);
  } else {
    return undefined;
  }
  return Math.min(Math.max(n, min), max);
}

/**
 * The desktop editor persists image widths as CSS strings (`"320px"`,
 * see `image-extension.ts`) as well as bare numbers. Accepts both,
 * clamped to 1–2000; anything else (percentages, keywords, garbage)
 * is dropped and the image falls back to natural size under the
 * `max-width: 100%` CSS clamp.
 */
export function parseCssWidth(v: unknown): number | null {
  let n: number;
  if (typeof v === 'number' && Number.isFinite(v)) {
    n = v;
  } else if (typeof v === 'string' && /^\d+(?:\.\d+)?(?:px)?$/.test(v.trim())) {
    n = parseFloat(v.trim());
  } else {
    return null;
  }
  n = Math.round(n);
  if (n < 1) return null;
  return Math.min(n, 2000);
}

/** True for a plain-object candidate node/mark; filters null/holes. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
