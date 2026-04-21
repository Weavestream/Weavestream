import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { assetReferenceOptionsSchema } from '@weavestream/shared';
import type {
  FieldRelateCtx,
  FieldTypeStrategy,
} from '../field-type-strategy.js';

/**
 * ASSET_REFERENCE stores an array of target asset UUIDs, even for
 * single-target fields (normalized to a 1-element array). The per-write
 * `onRelate` hook upserts matching `Relation` rows and deletes rows that
 * the new value no longer contains — all inside the parent write's
 * transaction so a failure rolls both back.
 *
 * Even though `options.multiple` may be false, we always persist an array
 * because changing `multiple` later must not require a data migration.
 */
export class AssetReferenceStrategy implements FieldTypeStrategy {
  readonly kind = 'ASSET_REFERENCE' as const;
  readonly searchable = false;
  readonly optionsSchema = assetReferenceOptionsSchema;

  valueSchema(options: Record<string, unknown>): z.ZodTypeAny {
    const arr = z.array(z.string().uuid()).max(100);
    // Accept null, a single uuid, or an array. Normalize widens to array.
    return z.union([z.null(), z.string().uuid(), arr]).superRefine((v, ctx) => {
      if ((options as { multiple?: boolean }).multiple !== true) {
        if (Array.isArray(v) && v.length > 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'This reference field accepts a single asset.',
          });
        }
      }
    });
  }

  normalize(input: unknown): Prisma.InputJsonValue {
    if (input === null || input === undefined)
      return [] as unknown as Prisma.InputJsonValue;
    if (Array.isArray(input)) {
      const ids = Array.from(
        new Set(input.filter((v): v is string => typeof v === 'string' && v.length > 0)),
      );
      return ids as unknown as Prisma.InputJsonValue;
    }
    if (typeof input === 'string' && input.length > 0) {
      return [input] as unknown as Prisma.InputJsonValue;
    }
    return [] as unknown as Prisma.InputJsonValue;
  }

  toPlaintext(): string {
    // Plain ids are not useful in the search corpus. Phase 6 may enrich
    // this later by dereferencing each id's primary field, but today
    // the value is indexed only via the Relation table.
    return '';
  }

  async onRelate(value: unknown, ctx: FieldRelateCtx): Promise<void> {
    const targetIds = Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string')
      : [];
    const relationType =
      ((ctx.field.options as { relationType?: string }).relationType ?? '').length > 0
        ? (ctx.field.options as { relationType: string }).relationType
        : ctx.field.slug;

    await ctx.relations.replaceForField({
      companyId: ctx.companyId,
      sourceType: 'Asset',
      sourceId: ctx.assetId,
      targetType: 'Asset',
      relationType,
      targetIds,
      actorId: ctx.actorId,
      tx: ctx.tx,
    });
  }
}
