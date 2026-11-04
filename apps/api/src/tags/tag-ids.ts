const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The unique tag ids in a TAGS field value, safe to pass to a
 * `tag.findMany({ where: { id: { in } } })`.
 *
 * Legacy `AssetFieldValue.value` rows from before the global-Tag
 * migration may still hold raw strings (e.g. "production") instead of
 * UUIDs. Passing those to Prisma's `id: { in: [...] }` on a UUID column
 * raises P2023 ("Error creating UUID"). The plan explicitly chose not to
 * migrate that data, so any non-UUID entry is dropped here — callers
 * treat a missing id as deleted/unknown and skip it.
 *
 * Kept free of Nest dependencies so both `TagsService` and the search
 * indexer can use it without a module cycle.
 */
export function validTagIds(values: readonly unknown[]): string[] {
  const ids = values.filter(
    (v): v is string => typeof v === 'string' && UUID_RE.test(v),
  );
  return Array.from(new Set(ids));
}
