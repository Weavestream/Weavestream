import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import type { FieldTypeStrategy } from '../field-type-strategy.js';

const optionsSchema = z.object({}).strict();

export class TextStrategy implements FieldTypeStrategy {
  readonly kind = 'TEXT' as const;
  readonly searchable = true;
  readonly optionsSchema = optionsSchema;

  valueSchema(): z.ZodTypeAny {
    return z
      .union([z.string().max(10_000), z.null()])
      .transform((v) => (v === null || v === '' ? null : v));
  }

  normalize(input: unknown): Prisma.InputJsonValue {
    if (input === null || input === undefined)
      return null as unknown as Prisma.InputJsonValue;
    const trimmed = String(input).trim();
    return (trimmed.length === 0 ? null : trimmed) as unknown as Prisma.InputJsonValue;
  }

  toPlaintext(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }
}

export class TextareaStrategy implements FieldTypeStrategy {
  readonly kind = 'TEXTAREA' as const;
  readonly searchable = true;
  readonly optionsSchema = optionsSchema;

  valueSchema(): z.ZodTypeAny {
    return z.union([z.string().max(50_000), z.null()]);
  }

  normalize(input: unknown): Prisma.InputJsonValue {
    if (input === null || input === undefined) return null as unknown as Prisma.InputJsonValue;
    return String(input) as unknown as Prisma.InputJsonValue;
  }

  toPlaintext(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }
}
