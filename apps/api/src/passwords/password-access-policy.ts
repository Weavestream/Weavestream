import type { Prisma } from '@prisma/client';
import type { UserRole } from '@weavestream/shared';

export type PasswordAccessActor = {
  id: string;
  role: UserRole;
};

export type PasswordAccessRow = {
  visibleToClients: boolean;
  restrictedToUserIds: string[];
};

export function passwordReadWhereFor(
  actor: PasswordAccessActor,
): Prisma.PasswordWhereInput {
  if (actor.role === 'CLIENT_USER') return { visibleToClients: true };
  if (actor.role === 'SUPER_ADMIN') return {};
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
  return (
    row.restrictedToUserIds.length === 0 ||
    row.restrictedToUserIds.includes(actor.id)
  );
}

export function isPasswordRestrictedForInternalUsers(
  row: Pick<PasswordAccessRow, 'restrictedToUserIds'>,
): boolean {
  return row.restrictedToUserIds.length > 0;
}
