import type { UserRole, MembershipRole } from '@weavestream/shared';
import type { Me, Membership } from './server-api';

export type { UserRole, MembershipRole };

export const OPERATOR_ROLES: UserRole[] = ['SUPER_ADMIN', 'OPERATOR'];

export function isOperator(role: UserRole | string | undefined | null): boolean {
  return !!role && OPERATOR_ROLES.includes(role as UserRole);
}

/**
 * Non-revoked, non-expired memberships for the current user. The API
 * already hides revoked rows from `/me`, but expiry is a client-side
 * clock comparison so we normalise it here.
 */
export function activeMemberships(me: Pick<Me, 'memberships'>): Membership[] {
  const now = Date.now();
  return me.memberships.filter(
    (m) => !m.expiresAt || new Date(m.expiresAt).getTime() > now,
  );
}

/**
 * Picks the membership a client user should "land in" when no
 * specific company is addressed by the URL. Preference order:
 *   1. The `ws_last_company` cookie, if it still matches an active
 *      membership.
 *   2. The membership most recently created (stable tiebreaker that
 *      matches the order the API returns).
 *   3. `null` when the user has no active memberships at all.
 */
export function preferredMembership(
  me: Pick<Me, 'memberships'>,
  lastCompanySlug: string | null | undefined,
): Membership | null {
  const active = activeMemberships(me);
  if (active.length === 0) return null;
  if (lastCompanySlug) {
    const remembered = active.find((m) => m.company.slug === lastCompanySlug);
    if (remembered) return remembered;
  }
  return active[0] ?? null;
}

/**
 * Global-role predicate: users that can mutate companies/users/memberships
 * in surfaces that are purely gated on global role (users list, global
 * settings, etc). For *per-company* membership writes prefer
 * `canManageCompanyMemberships` below — it mirrors the API's RBAC rule
 * so the UI stops showing buttons that 403.
 */
export function canManage(role: UserRole | string | undefined | null): boolean {
  return role === 'SUPER_ADMIN' || role === 'OPERATOR';
}

/**
 * Per-company predicate that matches the API's `membership.manage`
 * permission: SUPER_ADMIN always, otherwise a non-expired
 * `OPERATOR_FULL` membership on the target company. A global OPERATOR
 * role alone is *not* enough — that's what [`RequirePermission`](../../../apps/api/src/rbac/require-permission.decorator.ts)
 * enforces on the server.
 */
export function canManageCompanyMemberships(
  me: Pick<Me, 'role' | 'memberships'> | null | undefined,
  companyId: string,
): boolean {
  if (!me) return false;
  if (me.role === 'SUPER_ADMIN') return true;
  const now = Date.now();
  return me.memberships.some(
    (m) =>
      m.company.id === companyId &&
      m.role === 'OPERATOR_FULL' &&
      (!m.expiresAt || new Date(m.expiresAt).getTime() > now),
  );
}

export function initialsFromName(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0] ?? '')
      .join('')
      .toUpperCase() || '?'
  );
}

export function roleLabel(role: string): string {
  return role.toLowerCase().replace(/_/g, ' ');
}
