import type {
  GlobalAccess,
  MembershipRole,
  PlatformCapability,
  UserRole,
} from '@weavestream/shared';
import type { Me, Membership } from './server-api';

export type { GlobalAccess, MembershipRole, PlatformCapability, UserRole };

export const OPERATOR_ROLES: UserRole[] = ['SUPER_ADMIN', 'OPERATOR'];

/**
 * The smallest possible "viewer" identity the helpers need to evaluate
 * a permission check. Most callers pass `Me` directly; the predicates
 * also accept a stripped-down shape so the auth-page guards (which
 * have already destructured `me`) don't need to round-trip through the
 * full type.
 */
export type ViewerLike = Pick<
  Me,
  'role' | 'globalAccess' | 'platformCapabilities' | 'memberships'
>;

// ───────────────────────────────────────────────────────────────────
// Role predicates
// ───────────────────────────────────────────────────────────────────

export function isSuperAdmin(
  me: Pick<Me, 'role'> | null | undefined,
): boolean {
  return !!me && me.role === 'SUPER_ADMIN';
}

export function isOperator(role: UserRole | string | undefined | null): boolean {
  return !!role && OPERATOR_ROLES.includes(role as UserRole);
}

export function isContractor(
  me: Pick<Me, 'role'> | null | undefined,
): boolean {
  return !!me && me.role === 'CONTRACTOR';
}

export function isClientUser(
  me: Pick<Me, 'role'> | null | undefined,
): boolean {
  return !!me && me.role === 'CLIENT_USER';
}

// ───────────────────────────────────────────────────────────────────
// Memberships
// ───────────────────────────────────────────────────────────────────

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

export function activeMembershipFor(
  me: Pick<Me, 'memberships'> | null | undefined,
  companyId: string,
): Membership | null {
  if (!me) return null;
  return (
    activeMemberships(me).find((m) => m.company.id === companyId) ?? null
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

// ───────────────────────────────────────────────────────────────────
// RBAC v2 — capability + access resolution
//
// Mirrors `apps/api/src/rbac/permission.service.ts`. The web layer
// only uses these to *hide* unreachable controls; the server is still
// the source of truth and will 403 anything stale.
// ───────────────────────────────────────────────────────────────────

export type CompanyAccess = 'FULL' | 'READONLY' | 'NONE';

/**
 * Per-company effective access for the current viewer. Resolution
 * order matches the API's `can()`:
 *   1. SUPER_ADMIN → always FULL
 *   2. Active `Membership` on the company → its role wins (FULL or READONLY)
 *   3. Operator with `globalAccess=FULL/READONLY` → that tier
 *   4. Anything else → NONE
 */
export function effectiveCompanyAccess(
  me: ViewerLike | null | undefined,
  companyId: string,
): CompanyAccess {
  if (!me) return 'NONE';
  if (me.role === 'SUPER_ADMIN') return 'FULL';

  const membership = activeMembershipFor(me, companyId);
  if (membership) return membership.role;

  // Only OPERATORs ever benefit from the global tier — CONTRACTOR and
  // CLIENT_USER without a matching membership get nothing.
  if (me.role === 'OPERATOR') {
    if (me.globalAccess === 'FULL') return 'FULL';
    if (me.globalAccess === 'READONLY') return 'READONLY';
  }

  return 'NONE';
}

export function canReadCompany(
  me: ViewerLike | null | undefined,
  companyId: string,
): boolean {
  return effectiveCompanyAccess(me, companyId) !== 'NONE';
}

export function canWriteCompany(
  me: ViewerLike | null | undefined,
  companyId: string,
): boolean {
  return effectiveCompanyAccess(me, companyId) === 'FULL';
}

/**
 * Capability check. SUPER_ADMIN implicitly holds every capability; an
 * OPERATOR holds only the ones explicitly granted on `User.platformCapabilities`.
 * CONTRACTOR/CLIENT_USER never hold capabilities.
 */
export function hasCapability(
  me: Pick<Me, 'role' | 'platformCapabilities'> | null | undefined,
  capability: PlatformCapability,
): boolean {
  if (!me) return false;
  if (me.role === 'SUPER_ADMIN') return true;
  return me.platformCapabilities.includes(capability);
}

export function hasAnyCapability(
  me: Pick<Me, 'role' | 'platformCapabilities'> | null | undefined,
  capabilities: readonly PlatformCapability[],
): boolean {
  if (!me) return false;
  if (me.role === 'SUPER_ADMIN') return true;
  return capabilities.some((c) => me.platformCapabilities.includes(c));
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
  USER_MANAGE: 'Manage users (excl. Super Admin)',
  MEMBERSHIP_MANAGE: 'Manage company memberships',
  AUDIT_READ: 'Read the audit log',
  SETTINGS_MANAGE: 'Edit workspace settings',
  EXPORT_CREATE: 'Create exports',
};

export function capabilityLabel(c: PlatformCapability): string {
  return CAPABILITY_LABEL[c];
}
