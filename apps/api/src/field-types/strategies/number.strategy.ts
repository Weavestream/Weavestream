import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import type { FieldTypeStrategy } from '../field-type-strategy.js';

const optionsSchema = z.object({}).strict();

export class NumberStrategy implements FieldTypeStrategy {
  readonly kind = 'NUMBER' as const;
  readonly searchable = false;
  readonly optionsSchema = optionsSchema;

  valueSchema(): z.ZodTypeAny {
    return z.union([z.number().finite(), z.null()]);
  }

  normalize(input: unknown): Prisma.InputJsonValue {
    if (input === null || input === undefined || input === '')
      return null as unknown as Prisma.InputJsonValue;
    const n = typeof input === 'string' ? Number(input) : (input as number);
    return Number.isFinite(n) ? (n as unknown as Prisma.InputJsonValue) : (null as unknown as Prisma.InputJsonValue);
  }

  toPlaintext(value: unknown): string {
    return typeof value === 'number' ? String(value) : '';
  }
}
