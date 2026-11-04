/**
 * Escape `\`, `%` and `_` so a Prisma `contains` / `startsWith` /
 * `endsWith` filter matches them literally. Prisma hands the value to
 * Postgres `LIKE`/`ILIKE` as a pattern without escaping it, so a search
 * for `ABC_123` would otherwise also match `ABCX123`, and `%` would
 * match every row. Backslash is the default `LIKE` escape character.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
