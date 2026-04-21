import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import {
  dropdownOptionsSchema,
  multiselectOptionsSchema,
  type FieldOptionChoice,
} from '@weavestream/shared';
import type { FieldTypeStrategy } from '../field-type-strategy.js';

function choices(options: Record<string, unknown>): FieldOptionChoice[] {
  const arr = (options as { choices?: unknown }).choices;
  if (!Array.isArray(arr)) return [];
  return arr.filter(
    (c): c is FieldOptionChoice =>
      !!c &&
      typeof c === 'object' &&
      typeof (c as FieldOptionChoice).slug === 'string',
  );
}

function labelBySlug(list: FieldOptionChoice[], slug: string): string {
  return list.find((c) => c.slug === slug)?.label ?? slug;
}

export class DropdownStrategy implements FieldTypeStrategy {
  readonly kind = 'DROPDOWN' as const;
  readonly searchable = true;
  readonly optionsSchema = dropdownOptionsSchema;

  valueSchema(options: Record<string, unknown>): z.ZodTypeAny {
    const list = choices(options);
    const allowOther = (options as { allowOther?: boolean }).allowOther === true;
    if (list.length === 0) return z.union([z.string().max(200), z.null()]);
    const slugs = list.map((c) => c.slug) as [string, ...string[]];
    const base = z.enum(slugs);
    return z.union([z.null(), allowOther ? z.union([base, z.string().max(200)]) : base]);
  }

  normalize(input: unknown): Prisma.InputJsonValue {
    if (input === null || input === undefined || input === '')
      return null as unknown as Prisma.InputJsonValue;
    return String(input).trim() as unknown as Prisma.InputJsonValue;
  }

  toPlaintext(value: unknown, options: Record<string, unknown>): string {
    if (typeof value !== 'string') return '';
    return labelBySlug(choices(options), value);
  }
}

export class MultiselectStrategy implements FieldTypeStrategy {
  readonly kind = 'MULTISELECT' as const;
  readonly searchable = true;
  readonly optionsSchema = multiselectOptionsSchema;

  valueSchema(options: Record<string, unknown>): z.ZodTypeAny {
    const list = choices(options);
    const max = (options as { maxSelections?: number }).maxSelections;
    const slugs = list.map((c) => c.slug);
    const item =
      slugs.length > 0
        ? z.enum(slugs as [string, ...string[]])
        : z.string().max(200);
    let arr = z.array(item);
    if (max && max > 0) arr = arr.max(max);
    return z.union([z.null(), arr]);
  }

  normalize(input: unknown): Prisma.InputJsonValue {
    if (input === null || input === undefined)
      return null as unknown as Prisma.InputJsonValue;
    if (Array.isArray(input)) {
      const unique = Array.from(
        new Set(
          input
            .filter((v) => v !== null && v !== undefined && v !== '')
            .map((v) => String(v).trim()),
        ),
      );
      return unique as unknown as Prisma.InputJsonValue;
    }
    return [String(input)] as unknown as Prisma.InputJsonValue;
  }

  toPlaintext(value: unknown, options: Record<string, unknown>): string {
    if (!Array.isArray(value)) return '';
    const list = choices(options);
    return value
      .map((v) => (typeof v === 'string' ? labelBySlug(list, v) : ''))
      .filter(Boolean)
      .join(' ');
  }
}
