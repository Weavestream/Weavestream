import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import {
  isValidTiptapDoc,
  stringToTiptapDoc,
  tiptapToPlaintext,
} from '@weavestream/shared';
import type { FieldTypeStrategy } from '../field-type-strategy.js';

const optionsSchema = z.object({}).strict();

/**
 * RICH_TEXT storage shape: a Tiptap JSON document — i.e. the raw output
 * of `editor.getJSON()` — stored verbatim. The editor handles every
 * StarterKit node (headings, lists, task lists, code blocks, blockquotes,
 * horizontal rules) plus links, mentions, and images, and we must not
 * reject any of those at the API boundary. We validate *structurally*
 * (it's an object with `type: 'doc'` and an optional content array) and
 * defer per-node validation to the client + Tiptap's own parser.
 *
 * Two legacy input shapes are tolerated for backward compatibility:
 *   - A plain string (older CLI / form clients) is lifted into a Tiptap
 *     doc via `stringToTiptapDoc`.
 *   - A `{ v: TiptapDoc, plain: string }` wrapper (the Phase 3 stub shape
 *     that pre-computed plaintext alongside the doc) is unwrapped. Search
 *     is rebuilt from the doc on demand via `tiptapToPlaintext`, so the
 *     precomputed `plain` field is no longer needed.
 *
 * Stored rows written under the old wrapper shape continue to read back
 * correctly because `toPlaintext` still understands both layouts.
 */
const legacyWrappedSchema = z.object({
  v: z.unknown(),
  plain: z.string().max(200_000).optional(),
});

const valueSchema = z.union([
  z.null(),
  z.string().max(200_000),
  z
    .custom<unknown>((v) => isValidTiptapDoc(v), {
      message: 'Expected a Tiptap document ({ type: "doc", content: [...] })',
    }),
  legacyWrappedSchema.refine((obj) => isValidTiptapDoc(obj.v), {
    message: 'Legacy wrapper must hold a valid Tiptap document in `v`',
  }),
]);

export class RichTextStrategy implements FieldTypeStrategy {
  readonly kind = 'RICH_TEXT' as const;
  readonly searchable = true;
  readonly optionsSchema = optionsSchema;

  valueSchema(): z.ZodTypeAny {
    return valueSchema;
  }

  normalize(input: unknown): Prisma.InputJsonValue {
    if (input === null || input === undefined) {
      return null as unknown as Prisma.InputJsonValue;
    }
    if (typeof input === 'string') {
      const trimmed = input.trim();
      if (trimmed.length === 0) {
        return null as unknown as Prisma.InputJsonValue;
      }
      return stringToTiptapDoc(input) as unknown as Prisma.InputJsonValue;
    }
    if (
      input &&
      typeof input === 'object' &&
      'v' in (input as Record<string, unknown>) &&
      !('type' in (input as Record<string, unknown>))
    ) {
      const inner = (input as { v: unknown }).v;
      if (isValidTiptapDoc(inner)) {
        return inner as unknown as Prisma.InputJsonValue;
      }
    }
    return input as Prisma.InputJsonValue;
  }

  toPlaintext(value: unknown): string {
    if (!value) return '';
    if (
      typeof value === 'object' &&
      'plain' in (value as Record<string, unknown>) &&
      typeof (value as { plain?: unknown }).plain === 'string'
    ) {
      return (value as { plain: string }).plain;
    }
    if (
      typeof value === 'object' &&
      'v' in (value as Record<string, unknown>)
    ) {
      return tiptapToPlaintext((value as { v: unknown }).v);
    }
    return tiptapToPlaintext(value);
  }
}
