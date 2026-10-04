import type { PasswordAccessUser } from '@weavestream/shared';

/**
 * Pure selection rules for the internal-access dialog. The dialog owns
 * the state; these decide what a toggle, a load, or a save does to it.
 */

/** Every eligible user's id, and the subset that can never be deselected. */
export function accessUserIds(users: readonly PasswordAccessUser[]): {
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
  users: readonly PasswordAccessUser[],
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
