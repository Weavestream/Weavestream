import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { dateOptionsSchema, datetimeOptionsSchema } from '@weavestream/shared';
import type { FieldTypeStrategy } from '../field-type-strategy.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * Dates are stored as ISO-8601 strings in JSON. We keep them as strings
 * (not JS `Date`) so the value round-trips through Prisma's `Json` type
 * losslessly. Warranty-countdown rendering parses them back into Date on
 * the client side.
 */
export class DateStrategy implements FieldTypeStrategy {
  readonly kind = 'DATE' as const;
  readonly searchable = false;
  readonly optionsSchema = dateOptionsSchema;

  valueSchema(): z.ZodTypeAny {
    return z.union([
      z.null(),
      z.string().regex(ISO_DATE, 'Must be an ISO date (YYYY-MM-DD)'),
    ]);
  }

  normalize(input: unknown): Prisma.InputJsonValue {
    if (input === null || input === undefined || input === '')
      return null as unknown as Prisma.InputJsonValue;
    if (typeof input === 'string') {
      // Accept full ISO datetime and truncate to the date portion.
      const trimmed = input.slice(0, 10);
      return trimmed as unknown as Prisma.InputJsonValue;
    }
    if (input instanceof Date) {
      return input.toISOString().slice(0, 10) as unknown as Prisma.InputJsonValue;
    }
    return null as unknown as Prisma.InputJsonValue;
  }

  toPlaintext(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }
}

export class DateTimeStrategy implements FieldTypeStrategy {
  readonly kind = 'DATETIME' as const;
  readonly searchable = false;
  readonly optionsSchema = datetimeOptionsSchema;

  valueSchema(): z.ZodTypeAny {
    return z.union([
      z.null(),
      z.string().regex(ISO_DATETIME, 'Must be an ISO datetime'),
    ]);
  }

  normalize(input: unknown): Prisma.InputJsonValue {
    if (input === null || input === undefined || input === '')
      return null as unknown as Prisma.InputJsonValue;
    if (input instanceof Date) {
      return input.toISOString() as unknown as Prisma.InputJsonValue;
    }
    return String(input) as unknown as Prisma.InputJsonValue;
  }

  toPlaintext(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }
}
