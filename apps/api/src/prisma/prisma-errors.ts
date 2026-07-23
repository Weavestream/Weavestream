/**
 * Structural check for Prisma's P2002 unique-constraint violation.
 * Duck-typed on `code` rather than `instanceof
 * PrismaClientKnownRequestError` so callers (and their specs) don't
 * depend on the generated client's error classes.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'code' in error && error.code === 'P2002',
  );
}
