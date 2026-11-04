import type { PasswordAccessUser } from '@weavestream/shared';

/**
 * Pure selection rules for picking internal users: the per-entry
 * internal-access dialog and the global password access policy in
 * settings. The UI owns the state; these decide what a toggle, a load, or
 * a save does to it.
 */

/** The fields the selection rules read from a pickable user. */
export type SelectableUser = { id: string; alwaysIncluded: boolean };

/** Every eligible user's id, and the subset that can never be deselected. */
export function accessUserIds(users: readonly SelectableUser[]): {
  selectable: Set<string>;
  alwaysIncluded: Set<string>;
} {
  return {
    selectable: new Set(users.map((u) => u.id)),
    alwaysIncluded: new Set(users.filter((u) => u.alwaysIncluded).map((u) => u.id)),
  };
}

/** The loaded selection, with always-included users ticked. */
export function withAlwaysIncluded(
  selected: ReadonlySet<string>,
  users: readonly SelectableUser[],
): Set<string> {
  const next = new Set(selected);
  for (const user of users) {
    if (user.alwaysIncluded) next.add(user.id);
  }
  return next;
}

/** Flip one user, unless they are always included. */
export function toggleSelection(
  selected: ReadonlySet<string>,
  userId: string,
  alwaysIncluded: ReadonlySet<string>,
): ReadonlySet<string> {
  if (alwaysIncluded.has(userId)) return selected;
  const next = new Set(selected);
  if (next.has(userId)) next.delete(userId);
  else next.add(userId);
  return next;
}

/** Selected ids that are no longer eligible (lost access, deactivated, …). */
export function unavailableSelection(
  selected: ReadonlySet<string>,
  selectable: ReadonlySet<string>,
): string[] {
  return Array.from(selected).filter((id) => !selectable.has(id));
}

/** Drop the unavailable ids, keeping always-included users. */
export function pruneUnavailable(
  selected: ReadonlySet<string>,
  selectable: ReadonlySet<string>,
  alwaysIncluded: ReadonlySet<string>,
): Set<string> {
  return new Set(
    Array.from(selected).filter((id) => selectable.has(id) || alwaysIncluded.has(id)),
  );
}

/**
 * The `restrictedToUserIds` to save: empty when unrestricted, else the
 * selection plus every always-included user, de-duplicated.
 */
export function restrictedIdsToSave(
  restricted: boolean,
  selected: ReadonlySet<string>,
  alwaysIncluded: ReadonlySet<string>,
): string[] {
  if (!restricted) return [];
  return Array.from(new Set([...Array.from(selected), ...Array.from(alwaysIncluded)]));
}

/**
 * The `userIds` to save for the global password access policy. Super admins
 * always pass and the API rejects their ids, so — unlike
 * {@link restrictedIdsToSave} — always-included users are never sent, even
 * though the UI shows them checked. Sorted for a stable request.
 */
export function globalPolicyIdsToSave(
  selected: ReadonlySet<string>,
  alwaysIncluded: ReadonlySet<string>,
): string[] {
  return Array.from(selected)
    .filter((id) => !alwaysIncluded.has(id))
    .sort();
}

export function accessSourceLabel(source: PasswordAccessUser['accessSource']): string {
  switch (source) {
    case 'super_admin':
      return 'always included';
    case 'global':
      return 'global access';
    case 'membership':
      return 'membership';
  }
}
