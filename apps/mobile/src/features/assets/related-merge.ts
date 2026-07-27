import type { PasswordSummary } from '@weavestream/shared';
import type { RelatedGroups, RelatedItem } from '../relations/api';

/**
 * Fold the asset's linked credentials (`Password.assetId`) into the
 * Related section's `password` group as ordinary rows — the locked 2c
 * decision: no dedicated Credentials card, "simply link to the
 * password". Embedded credentials don't create `Relation` rows, so the
 * relations endpoint alone would omit them entirely.
 *
 * Relation-born rows come first (server order), then embedded
 * credentials not already present (deduped by password id — a
 * credential can be BOTH assetId-linked and manually related), sorted
 * by name. The synthetic `relationId` is only a React key; these rows
 * have no Relation row to unlink, and mobile has no unlink anyway.
 */
export function mergeCredentialGroups(
  groups: RelatedGroups,
  credentials: PasswordSummary[],
): RelatedGroups {
  const seen = new Set(groups.password.map((item) => item.id));
  const extra: RelatedItem[] = credentials
    .filter((p) => !seen.has(p.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({
      relationId: `asset-cred-${p.id}`,
      kind: 'password' as const,
      id: p.id,
      title: p.name,
      subtitle: p.username,
    }));
  if (extra.length === 0) return groups;
  return { ...groups, password: [...groups.password, ...extra] };
}
