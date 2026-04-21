import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

/**
 * Validates a request body with a Zod schema and returns the parsed
 * (stripped) value. Usage:
 *
 *   @Body(new ZodBody(createCompanySchema)) dto: CreateCompanyInput
 *
 * All shared schemas in packages/shared are consumed the same way on
 * the web side via `schema.safeParse`.
 */
export class ZodBody<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      throw new BadRequestException({
        error: 'ValidationError',
        issues,
      });
    }
    return result.data;
  }
}
