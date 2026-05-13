/**
 * Shared DNS helpers used across the engine's v2 sub-checks (DNS, email
 * auth, DNSSEC, CAA). Lives in its own module so multiple checks can
 * call `safeResolve` without `dns-check.ts` and `email-check.ts`
 * cycling on each other.
 *
 * Failure semantics — a *resolver* error (SERVFAIL, refused, timeout)
 * is surfaced to the caller; a *NODATA* response (the record type
 * legitimately does not exist) is folded into the empty fallback.
 */

const NODATA_CODES = new Set([
  'ENODATA',
  'ENOTFOUND',
  'ENOTIMP',
  'ENOERROR',
  // .gov / some ccTLDs respond REFUSED for record types they don't
  // serve. We treat that as NODATA so the caller doesn't conflate it
  // with a real resolver failure.
  'EREFUSED',
]);

export function isNoDataError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  return typeof code === 'string' && NODATA_CODES.has(code);
}

export async function safeResolve<T>(
  fn: () => Promise<T>,
  fallback: T,
): Promise<{ value: T; error: Error | null }> {
  try {
    return { value: await fn(), error: null };
  } catch (err) {
    if (isNoDataError(err)) return { value: fallback, error: null };
    return {
      value: fallback,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
