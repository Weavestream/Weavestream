import { isValidTiptapDoc, type TiptapDoc } from './tiptap.js';

/**
 * Coerce any value the API or local state may hand us into a Tiptap
 * doc. Handles three shapes:
 *
 *   1. A real Tiptap doc — `{ type: 'doc', content: [...] }`. Returned as-is.
 *   2. A legacy Phase-3 wrapper — `{ v: TiptapDoc, plain: string }`.
 *      Older articles were written this way before the API switched to
 *      raw docs; we unwrap so existing rows still hydrate.
 *   3. A plain string — wrapped as a single paragraph.
 *
 * Anything else (null, empty object, missing `type`) falls through to an
 * empty doc rather than crashing the editor / read view.
 *
 * Tightened on promotion to shared (Phase 2b): both the direct root and
 * the unwrapped legacy `v` must pass `isValidTiptapDoc` — previously any
 * object merely *containing* a `type` key was returned, which let a
 * non-doc root (`{ v: { type: 'paragraph' } }`) escape as a "doc". Such
 * values now fall through to the empty doc instead.
 */
export function normaliseTiptapDoc(value: unknown): TiptapDoc {
  if (isValidTiptapDoc(value)) {
    return value;
  }

  if (
    value &&
    typeof value === 'object' &&
    'v' in (value as Record<string, unknown>)
  ) {
    const inner = (value as { v: unknown }).v;
    if (isValidTiptapDoc(inner)) {
      return inner;
    }
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }],
    };
  }

  return { type: 'doc', content: [{ type: 'paragraph' }] };
}
