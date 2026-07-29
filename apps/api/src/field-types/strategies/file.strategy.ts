import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import {
  FILE_MULTI_CAP,
  fileFieldEntrySchema,
  fileOptionsSchema,
  tagsFieldInputSchema,
} from '@weavestream/shared';
import type {
  FieldPreResolveCtx,
  FieldTypeStrategy,
} from '../field-type-strategy.js';

/**
 * FILE storage shape: an array of `fileFieldEntrySchema` entries
 * (`{ uploadId, filename, mimeType, sizeBytes, isImage? }`). The schema
 * is defined once in `@weavestream/shared` so the web dropzone, the
 * upload-confirm response, and this strategy all agree on the field
 * names — previously this file maintained a divergent copy that used
 * `mime` where everything else used `mimeType`, which caused every save
 * to fail Zod validation with `{"path":"<field>","message":"Invalid
 * input"}`.
 */
export class FileStrategy implements FieldTypeStrategy {
  readonly kind = 'FILE' as const;
  readonly searchable = false;
  readonly optionsSchema = fileOptionsSchema;

  valueSchema(options: Record<string, unknown>): z.ZodTypeAny {
    const multiple = (options as { multiple?: boolean }).multiple === true;
    const arr = z.array(fileFieldEntrySchema).max(multiple ? FILE_MULTI_CAP : 1);
    return z.union([z.null(), arr]);
  }

  normalize(input: unknown): Prisma.InputJsonValue {
    if (input === null || input === undefined)
      return [] as unknown as Prisma.InputJsonValue;
    if (Array.isArray(input)) return input as unknown as Prisma.InputJsonValue;
    return [] as unknown as Prisma.InputJsonValue;
  }

  toPlaintext(value: unknown): string {
    if (!Array.isArray(value)) return '';
    return value
      .map((e) => (e && typeof e === 'object' ? (e as { filename?: string }).filename ?? '' : ''))
      .filter(Boolean)
      .join(' ');
  }
}

const tagsOptionsSchema = z.object({}).strict();

/**
 * TAGS storage shape: a JSON array of `Tag.id` UUIDs. Tags are global —
 * `AssetFieldValue.value` references rows in the `tags` table by id, so
 * a rename in the management UI is reflected everywhere on the next read
 * and identical names across companies share a single Tag row.
 *
 * Wire shape (what web sends): a mixed array of `string | { name }`,
 * where strings are existing UUIDs and `{ name }` triggers a server-side
 * upsert. `preResolve` runs inside the asset-write transaction and turns
 * the wire shape into the canonical stored shape (a plain `string[]` of
 * UUIDs) before `valueSchema` validation and `normalize`.
 *
 * `toPlaintext` returns `''` because the strategy itself has no DB access
 * — search-indexing of tag names is intentionally out of scope here. The
 * read-side serializer in AssetsService hydrates `{ id, name }` snapshots
 * for the UI separately.
 */
export class TagsStrategy implements FieldTypeStrategy {
  readonly kind = 'TAGS' as const;
  readonly searchable = false;
  readonly optionsSchema = tagsOptionsSchema;

  valueSchema(): z.ZodTypeAny {
    // Wire shape: a mixed array of existing-tag UUIDs and `{ name }`
    // entries that get upserted server-side via `preResolve`. After
    // `preResolve` runs inside the asset-write tx, the value is a plain
    // `string[]` of UUIDs, which `normalize` then dedupes.
    return z.union([z.null(), tagsFieldInputSchema]);
  }

  async preResolve(
    input: unknown,
    _options: Record<string, unknown>,
    ctx: FieldPreResolveCtx,
  ): Promise<unknown> {
    if (input === null || input === undefined) return [];
    const parsed = tagsFieldInputSchema.safeParse(input);
    if (!parsed.success) {
      // Defer the error to valueSchema validation, where it'll surface
      // with the per-field path in the standard Zod-issue format.
      return input;
    }
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const entry of parsed.data) {
      const id =
        typeof entry === 'string'
          ? entry
          : await ctx.tags.upsertByName(entry.name, ctx.tx, ctx.audit);
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    return ids;
  }

  normalize(input: unknown): Prisma.InputJsonValue {
    if (input === null || input === undefined)
      return [] as unknown as Prisma.InputJsonValue;
    if (!Array.isArray(input)) return [] as unknown as Prisma.InputJsonValue;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of input) {
      if (typeof v !== 'string') continue;
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out as unknown as Prisma.InputJsonValue;
  }

  toPlaintext(): string {
    return '';
  }
}
