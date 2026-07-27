/**
 * Tag chip drafts — the client-side working shape for tag inputs, plus
 * the wire-format serializers both apps use on save.
 *
 * Promoted out of `apps/web/src/components/tags/tags-input.tsx` in
 * Phase 2c so the mobile TAGS field editor can share them (CLAUDE.md:
 * shared logic lives here, never copied across app boundaries). The
 * React input components stay per-app; only the pure shapes/mappers
 * are shared.
 *
 * Wire asymmetry these encode (see `TagsStrategy` in the API):
 *  - Asset TAGS fields READ back hydrated `[{id, name}]` and must
 *    WRITE the mixed `(uuid | {name})[]` shape — echoing the read
 *    shape back fails validation (`{id, name}` is not `{name}`).
 *  - Password tags are a denormalised `string[]` of names.
 */

/**
 * Internal chip representation. Existing tags carry an `id`; freshly typed
 * chips carry only a `name`. Callers serialise this back to whatever wire
 * shape their endpoint expects on save.
 */
export type TagChipDraft = { id?: string; name: string };

/**
 * Asset-style wire shape: mix of UUID strings (existing tags) and
 * `{name}` objects (freshly typed). The API resolves `{name}` to a
 * UUID inside the asset-write transaction via `TagsStrategy.preResolve`.
 */
export function toAssetWireTags(
  chips: TagChipDraft[],
): Array<string | { name: string }> {
  return chips.map((c) => (c.id ? c.id : { name: c.name }));
}

/**
 * Password-style wire shape: plain `string[]` of trimmed names. We
 * drop ids because the password vault keeps tags as a denormalised
 * string array (no FK into the global Tag table). The autocomplete
 * suggestions from `/tags` still help operators reuse consistent
 * naming across the workspace.
 */
export function toPlainNameList(chips: TagChipDraft[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of chips) {
    const t = c.name.trim();
    if (!t) continue;
    const lower = t.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(t);
  }
  return out;
}

/**
 * Coerce a heterogeneous value (legacy plain strings, current rich
 * `{id, name}` objects, or freshly-typed `{name}` chips) into the
 * canonical `TagChipDraft[]` shape the inputs operate on.
 */
export function coerceTagChips(value: unknown): TagChipDraft[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).flatMap<TagChipDraft>((v) => {
    if (typeof v === 'string') {
      return v.length > 0 ? [{ id: v, name: v }] : [];
    }
    if (
      v &&
      typeof v === 'object' &&
      typeof (v as { name?: unknown }).name === 'string'
    ) {
      const obj = v as { id?: unknown; name: string };
      return [
        {
          id: typeof obj.id === 'string' ? obj.id : undefined,
          name: obj.name,
        },
      ];
    }
    return [];
  });
}
