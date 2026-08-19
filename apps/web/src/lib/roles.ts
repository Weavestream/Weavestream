import type {
  GlobalAccess,
  MembershipRole,
  PlatformCapability,
  UserRole,
  ViewerLike,
} from '@weavestream/shared';
import { activeMemberships } from '@weavestream/shared';
import type { Me, Membership } from './server-api';

const OPERATOR_ROLES: UserRole[] = ['SUPER_ADMIN', 'OPERATOR'];

// The access-resolution helpers moved to `packages/shared` (same reason
// as `initialsFromName` below: `apps/mobile` gates its write UI on them
// and cannot import out of `apps/web`). Only the ones web actually
// imports through `lib/roles` are re-exported here — `activeMembershipFor`,
// `effectiveCompanyAccess`, `canReadCompany`, `hasAnyCapability`,
// `CompanyAccess` and `MembershipLike` had no importer on this path and
// are reached from `@weavestream/shared` directly, which is how mobile
// already consumes them. `ViewerLike` is structural over there — `Me`
// still satisfies it, so callers are unaffected.
export {
  activeMemberships,
  canWriteCompany,
  hasCapability,
} from '@weavestream/shared';
export type { ViewerLike } from '@weavestream/shared';

// ───────────────────────────────────────────────────────────────────
// Role predicates
// ───────────────────────────────────────────────────────────────────

export function isOperator(role: UserRole | string | undefined | null): boolean {
  return !!role && OPERATOR_ROLES.includes(role as UserRole);
}

// ───────────────────────────────────────────────────────────────────
// Memberships
// ───────────────────────────────────────────────────────────────────

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
 * Should the user see the `/admin` shell at all? SUPER_ADMINs always;
 * OPERATORs whenever they have either a non-NONE globalAccess (so
 * cross-tenant reads are possible) or any platform capability (so the
 * users / integrations / audit screens are reachable). CONTRACTORs and
 * CLIENT_USERs never see the admin shell — they live in `/portal`.
 */
export function canAccessAdminShell(
  me: ViewerLike | null | undefined,
): boolean {
  if (!me) return false;
  if (me.role === 'SUPER_ADMIN') return true;
  if (me.role !== 'OPERATOR') return false;
  if (me.globalAccess && me.globalAccess !== 'NONE') return true;
  if (me.platformCapabilities.length > 0) return true;
  // Operator with NONE global access and no capabilities — they only
  // have per-company memberships, same UX as a CONTRACTOR.
  return false;
}

// ───────────────────────────────────────────────────────────────────
// Display helpers
// ───────────────────────────────────────────────────────────────────
//
// `initialsFromName` and `roleLabel` moved to `packages/shared` so
// `apps/mobile` can use them — its eslint config hard-blocks importing
// out of `apps/web`, and copying them would have been the wrong answer.
// Re-exported here (not reimplemented) so the ~15 existing call sites
// keep their `lib/roles` import path and there is still one
// implementation.
export { initialsFromName, roleLabel } from '@weavestream/shared';

const MEMBERSHIP_ROLE_LABEL: Record<MembershipRole, string> = {
  FULL: 'Full access',
  READONLY: 'Read-only',
};

export function membershipRoleLabel(role: MembershipRole): string {
  return MEMBERSHIP_ROLE_LABEL[role];
}

const GLOBAL_ACCESS_LABEL: Record<GlobalAccess, string> = {
  FULL: 'Full access',
  READONLY: 'Read-only',
  NONE: 'No default access',
};

export function globalAccessLabel(value: GlobalAccess): string {
  return GLOBAL_ACCESS_LABEL[value];
}

const CAPABILITY_LABEL: Record<PlatformCapability, string> = {
  COMPANY_MANAGE: 'Manage companies',
  INTEGRATION_MANAGE: 'Manage integrations & syncs',
  LAYOUT_MANAGE: 'Manage asset layouts',
  TAG_MANAGE: 'Manage tags (rename / delete)',
  USER_MANAGE: 'Manage users (excl. Super Admin)',
  MEMBERSHIP_MANAGE: 'Manage company memberships',
  AUDIT_READ: 'Read the audit log',
  SETTINGS_MANAGE: 'Edit workspace settings',
  EXPORT_CREATE: 'Create exports',
  ALERT_MANAGE: 'Manage alert configurations',
  SECURITY_READ: 'View Security Center (logins, lockouts, sessions)',
  IP_RULE_MANAGE: 'Manage IP allow/deny rules',
  BACKUP_MANAGE: 'Manage scheduled Postgres exports',
  TICKETS_READ: 'Browse helpdesk tickets (global)',
};

export function capabilityLabel(c: PlatformCapability): string {
  return CAPABILITY_LABEL[c];
}
