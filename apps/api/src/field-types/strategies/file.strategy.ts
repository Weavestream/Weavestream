import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { fileFieldEntrySchema, fileOptionsSchema } from '@weavestream/shared';
import type { FieldTypeStrategy } from '../field-type-strategy.js';

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
    const arr = z.array(fileFieldEntrySchema).max(multiple ? 100 : 1);
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

export class TagsStrategy implements FieldTypeStrategy {
  readonly kind = 'TAGS' as const;
  readonly searchable = true;
  readonly optionsSchema = tagsOptionsSchema;

  valueSchema(): z.ZodTypeAny {
    return z.union([
      z.null(),
      z
        .array(z.string().min(1).max(60))
        .max(100),
    ]);
  }

  normalize(input: unknown): Prisma.InputJsonValue {
    if (input === null || input === undefined)
      return [] as unknown as Prisma.InputJsonValue;
    if (!Array.isArray(input)) return [] as unknown as Prisma.InputJsonValue;
    const cleaned = Array.from(
      new Set(
        input
          .filter((v): v is string => typeof v === 'string')
          .map((v) => v.trim().toLowerCase())
          .filter((v) => v.length > 0),
      ),
    );
    return cleaned as unknown as Prisma.InputJsonValue;
  }

  toPlaintext(value: unknown): string {
    return Array.isArray(value)
      ? (value as unknown[])
          .filter((v): v is string => typeof v === 'string')
          .join(' ')
      : '';
  }
}
