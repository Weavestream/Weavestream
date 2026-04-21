import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import type { FieldTypeStrategy } from '../field-type-strategy.js';

const optionsSchema = z.object({}).strict();

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RX = /^https?:\/\/\S+$/;

function toE164(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits;
  // 10-digit US default. Anything else is kept as-is but prefixed with +.
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  return `+${digits}`;
}

export class EmailStrategy implements FieldTypeStrategy {
  readonly kind = 'EMAIL' as const;
  readonly searchable = true;
  readonly optionsSchema = optionsSchema;

  valueSchema(): z.ZodTypeAny {
    return z.union([
      z.null(),
      z.string().regex(EMAIL_RX, 'Must be a valid email address').max(254),
    ]);
  }

  normalize(input: unknown): Prisma.InputJsonValue {
    if (input === null || input === undefined || input === '')
      return null as unknown as Prisma.InputJsonValue;
    return String(input).trim().toLowerCase() as unknown as Prisma.InputJsonValue;
  }

  toPlaintext(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }
}

export class PhoneStrategy implements FieldTypeStrategy {
  readonly kind = 'PHONE' as const;
  readonly searchable = true;
  readonly optionsSchema = optionsSchema;

  valueSchema(): z.ZodTypeAny {
    return z.union([
      z.null(),
      z.string().regex(/^\+\d{6,20}$/, 'Must be an E.164 phone number (+1…)'),
    ]);
  }

  normalize(input: unknown): Prisma.InputJsonValue {
    if (input === null || input === undefined || input === '')
      return null as unknown as Prisma.InputJsonValue;
    const e164 = toE164(String(input));
    return (e164 ?? null) as unknown as Prisma.InputJsonValue;
  }

  toPlaintext(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }
}

export class UrlStrategy implements FieldTypeStrategy {
  readonly kind = 'URL' as const;
  readonly searchable = true;
  readonly optionsSchema = optionsSchema;

  valueSchema(): z.ZodTypeAny {
    return z.union([
      z.null(),
      z.string().regex(URL_RX, 'Must be an http(s) URL').max(2000),
    ]);
  }

  normalize(input: unknown): Prisma.InputJsonValue {
    if (input === null || input === undefined || input === '')
      return null as unknown as Prisma.InputJsonValue;
    return String(input).trim() as unknown as Prisma.InputJsonValue;
  }

  toPlaintext(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }
}

export class VaultwardenLinkStrategy implements FieldTypeStrategy {
  readonly kind = 'VAULTWARDEN_LINK' as const;
  readonly searchable = false;
  readonly optionsSchema = optionsSchema;

  valueSchema(): z.ZodTypeAny {
    return z.union([
      z.null(),
      z.object({
        url: z.string().regex(URL_RX, 'Must be an http(s) URL').max(2000),
        label: z.string().max(200).optional(),
      }),
      // Accept bare URL strings and widen them in `normalize`.
      z.string().regex(URL_RX).max(2000),
    ]);
  }

  normalize(input: unknown): Prisma.InputJsonValue {
    if (input === null || input === undefined || input === '')
      return null as unknown as Prisma.InputJsonValue;
    if (typeof input === 'string') {
      return { url: input } as Prisma.InputJsonValue;
    }
    return input as Prisma.InputJsonValue;
  }

  toPlaintext(): string {
    // Vault links intentionally do not leak into search corpora.
    return '';
  }
}
