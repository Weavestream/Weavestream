import type { Prisma } from '@prisma/client';
import {
  passwordAccessForCompany,
  type PasswordAccessMode,
  type PasswordAccessScope,
  type UserRole,
} from '@weavestream/shared';
import { isActiveMembership, type MembershipSnapshot } from '../rbac/permission.service.js';

export type { PasswordAccessScope } from '@weavestream/shared';

export type PasswordAccessActor = {
  id: string;
  role: UserRole;
  /**
   * Who may open entries WITHOUT their own allow-list, per company:
   * the global password access policy (`byDefault`) plus the user's
   * active membership overrides. Resolved once per request
   * (`resolvePasswordAccessScope`). Required on purpose: a reduced
   * `{ id, role }` actor must not compile, so no read path can forget it.
   */
  passwordAccess: PasswordAccessScope;
};

export type PasswordAccessRow = {
  companyId: string;
  visibleToClients: boolean;
  restrictedToUserIds: string[];
};

export type GlobalPasswordPolicy = {
  mode: PasswordAccessMode;
  userIds: readonly string[];
};

/** Full access, no overrides. For super admins, client users and tests. */
export const FULL_PASSWORD_ACCESS: PasswordAccessScope = Object.freeze({
  byDefault: true,
  allowCompanyIds: Object.freeze([]) as readonly string[],
  denyCompanyIds: Object.freeze([]) as readonly string[],
});

/** No access to entries without their own list. Fail-closed default. */
export const NO_PASSWORD_ACCESS: PasswordAccessScope = Object.freeze({
  byDefault: false,
  allowCompanyIds: Object.freeze([]) as readonly string[],
  denyCompanyIds: Object.freeze([]) as readonly string[],
});

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

/**
 * Global policy + the user's ACTIVE membership overrides. Expired and
 * revoked memberships are ignored, so an override ends with its
 * membership. Super admins and client users get FULL_PASSWORD_ACCESS:
 * their role branches decide before the scope is consulted.
 */
export function resolvePasswordAccessScope(
  user: { id: string; role: UserRole },
  policy: GlobalPasswordPolicy,
  memberships: readonly Pick<
    MembershipSnapshot,
    'companyId' | 'revokedAt' | 'expiresAt' | 'passwordAccess'
  >[],
  now: Date = new Date(),
): PasswordAccessScope {
  if (user.role === 'SUPER_ADMIN' || user.role === 'CLIENT_USER') {
    return FULL_PASSWORD_ACCESS;
  }
  const allowCompanyIds: string[] = [];
  const denyCompanyIds: string[] = [];
  for (const m of memberships) {
    if (!isActiveMembership(m, now)) continue;
    if (m.passwordAccess === 'allow') allowCompanyIds.push(m.companyId);
    else if (m.passwordAccess === 'deny') denyCompanyIds.push(m.companyId);
  }
  return {
    byDefault: passesGlobalPasswordPolicy(user, policy),
    allowCompanyIds,
    denyCompanyIds,
  };
}

/**
 * The company part of the rule for entries without their own list, as a
 * Prisma filter. `null` means "no entry without a list is readable".
 */
function companyRuleFor(scope: PasswordAccessScope): Prisma.PasswordWhereInput | null {
  if (scope.byDefault) {
    return scope.denyCompanyIds.length > 0
      ? { companyId: { notIn: [...scope.denyCompanyIds] } }
      : {};
  }
  return scope.allowCompanyIds.length > 0
    ? { companyId: { in: [...scope.allowCompanyIds] } }
    : null;
}

export function passwordReadWhereFor(
  actor: PasswordAccessActor,
): Prisma.PasswordWhereInput {
  if (actor.role === 'CLIENT_USER') return { visibleToClients: true };
  if (actor.role === 'SUPER_ADMIN') return {};
  // An entry with its own list uses only that list. An entry without one
  // follows the membership override for its company, else the global policy.
  const companyRule = companyRuleFor(actor.passwordAccess);
  if (companyRule === null) {
    return { restrictedToUserIds: { has: actor.id } };
  }
  return {
    OR: [
      { restrictedToUserIds: { isEmpty: true }, ...companyRule },
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
  return passwordAccessForCompany(actor.passwordAccess, row.companyId);
}
