import type { JSONContent } from '@tiptap/react';

/**
 * Coerce any value the API or local state may hand us into a Tiptap
 * `JSONContent` doc. Handles three shapes:
 *
 *   1. A real Tiptap doc — `{ type: 'doc', content: [...] }`. Returned as-is.
 *   2. A legacy Phase-3 wrapper — `{ v: TiptapDoc, plain: string }`.
 *      Older articles were written this way before the API switched to
 *      raw docs; we unwrap so existing rows still hydrate.
 *   3. A plain string — wrapped as a single paragraph.
 *
 * Anything else (null, empty object, missing `type`) falls through to an
 * empty doc rather than crashing the editor / read view.
 */
export function normaliseTiptapDoc(value: unknown): JSONContent {
  if (
    value &&
    typeof value === 'object' &&
    'type' in (value as Record<string, unknown>) &&
    (value as { type?: unknown }).type === 'doc'
  ) {
    return value as JSONContent;
  }

  if (
    value &&
    typeof value === 'object' &&
    'v' in (value as Record<string, unknown>)
  ) {
    const inner = (value as { v: unknown }).v;
    if (
      inner &&
      typeof inner === 'object' &&
      'type' in (inner as Record<string, unknown>)
    ) {
      return inner as JSONContent;
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
