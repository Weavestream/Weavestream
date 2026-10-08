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

/**
 * The subset of NODATA codes that confirm the record does not exist. The
 * rest (REFUSED, NOTIMP, ...) are harmless to fold into "empty" for
 * scoring, but they prove nothing about absence.
 */
const CONFIRMED_ABSENT_CODES = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN', 'NODATA']);

/**
 * `uncertain` is true when `value` is the fallback for any reason other
 * than a confirmed absence: a resolver error, or a soft NODATA code like
 * EREFUSED. Callers that must not mistake "unknown" for "none" read it.
 */
export async function safeResolve<T>(
  fn: () => Promise<T>,
  fallback: T,
): Promise<{ value: T; error: Error | null; uncertain: boolean }> {
  try {
    return { value: await fn(), error: null, uncertain: false };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    const uncertain = !(typeof code === 'string' && CONFIRMED_ABSENT_CODES.has(code));
    if (isNoDataError(err)) return { value: fallback, error: null, uncertain };
    return {
      value: fallback,
      error: err instanceof Error ? err : new Error(String(err)),
      uncertain,
    };
  }
}
