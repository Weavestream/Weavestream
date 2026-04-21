import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import type { FieldTypeStrategy } from '../field-type-strategy.js';

const optionsSchema = z.object({}).strict();

export class BooleanStrategy implements FieldTypeStrategy {
  readonly kind = 'BOOLEAN' as const;
  readonly searchable = false;
  readonly optionsSchema = optionsSchema;

  valueSchema(): z.ZodTypeAny {
    return z.union([z.boolean(), z.null()]);
  }

  normalize(input: unknown): Prisma.InputJsonValue {
    if (input === null || input === undefined)
      return null as unknown as Prisma.InputJsonValue;
    if (typeof input === 'boolean')
      return input as unknown as Prisma.InputJsonValue;
    if (typeof input === 'string')
      return (input === 'true') as unknown as Prisma.InputJsonValue;
    return Boolean(input) as unknown as Prisma.InputJsonValue;
  }

  toPlaintext(value: unknown): string {
    return value === true ? 'yes' : value === false ? 'no' : '';
  }
}
