import type { Prisma } from '@prisma/client';
import type { PasswordAccessMode, UserRole } from '@weavestream/shared';

export type PasswordAccessActor = {
  id: string;
  role: UserRole;
  /**
   * Result of the workspace password access policy for this user, resolved
   * once per request (`passesGlobalPasswordPolicy`). It decides access to
   * entries WITHOUT their own allow-list. Required on purpose: a reduced
   * `{ id, role }` actor must not compile, so no read path can forget it.
   */
  globalPasswordAccess: boolean;
};

export type PasswordAccessRow = {
  visibleToClients: boolean;
  restrictedToUserIds: string[];
};

export type GlobalPasswordPolicy = {
  mode: PasswordAccessMode;
  userIds: readonly string[];
};

/**
 * The workspace-wide rule for entries that have no own allow-list.
 * Super admins always pass. `CLIENT_USER` is governed only by
 * `visibleToClients`, so the result does not matter for them.
 */
export function passesGlobalPasswordPolicy(
  user: { id: string; role: UserRole },
  policy: GlobalPasswordPolicy,
): boolean {
  if (user.role === 'SUPER_ADMIN') return true;
  if (policy.mode === 'all_users') return true;
  return policy.userIds.includes(user.id);
}

export function passwordReadWhereFor(
  actor: PasswordAccessActor,
): Prisma.PasswordWhereInput {
  if (actor.role === 'CLIENT_USER') return { visibleToClients: true };
  if (actor.role === 'SUPER_ADMIN') return {};
  // An entry with its own list uses only that list. An entry without one
  // follows the global policy.
  if (!actor.globalPasswordAccess) {
    return { restrictedToUserIds: { has: actor.id } };
  }
  return {
    OR: [
      { restrictedToUserIds: { isEmpty: true } },
      { restrictedToUserIds: { has: actor.id } },
    ],
  };
}

export function canReadPassword(
  actor: PasswordAccessActor,
  row: PasswordAccessRow,
): boolean {
  if (actor.role === 'CLIENT_USER') return row.visibleToClients;
  if (actor.role === 'SUPER_ADMIN') return true;
  if (row.restrictedToUserIds.length > 0) {
    return row.restrictedToUserIds.includes(actor.id);
  }
  return actor.globalPasswordAccess;
}
