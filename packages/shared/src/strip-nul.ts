/**
 * Recursively strip NUL bytes (U+0000) from every string in a value.
 *
 * PostgreSQL rejects U+0000 in both `text` and `jsonb` columns with
 * SQLSTATE 22P05 ("unsupported Unicode escape sequence — \u0000 cannot be
 * converted to text"). The JSON spec permits `\u0000`, but Postgres does
 * not store it, so any string that reaches a text/jsonb write must be
 * sanitized first.
 *
 * Upstream integration data (RMM records, driver error messages, externalIds)
 * occasionally carries stray NUL bytes; call this at the boundary where such
 * untrusted data is ingested or persisted. The value's shape is preserved —
 * only the NUL characters are removed.
 */
export function stripNul<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(/\u0000/g, '') as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => stripNul(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        stripNul(v),
      ]),
    ) as T;
  }
  return value;
}
