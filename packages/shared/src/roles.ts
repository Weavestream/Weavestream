export const UserRoleValues = [
  'SUPER_ADMIN',
  'OPERATOR',
  'CONTRACTOR',
  'CLIENT_USER',
] as const;
export type UserRole = (typeof UserRoleValues)[number];

export const MembershipRoleValues = ['FULL', 'READONLY'] as const;
export type MembershipRole = (typeof MembershipRoleValues)[number];

// `NONE` means "no default access — only explicit memberships grant
// access". Required for OPERATORs; null for every other role (the
// column is nullable at the DB level so non-OPERATORs persist as null).
export const GlobalAccessValues = ['FULL', 'READONLY', 'NONE'] as const;
export type GlobalAccess = (typeof GlobalAccessValues)[number];

// Granular platform-admin capabilities. SUPER_ADMIN implicitly holds
// every capability — this list is the *delegatable* set, granted to
// elevated OPERATORs ("senior tech / manager"). Promoting or demoting
// another user to/from SUPER_ADMIN remains a hard SUPER_ADMIN-only
// operation regardless of `USER_MANAGE`.
export const PlatformCapabilityValues = [
  'COMPANY_MANAGE',
  'INTEGRATION_MANAGE',
  'LAYOUT_MANAGE',
  'TAG_MANAGE',
  'USER_MANAGE',
  'MEMBERSHIP_MANAGE',
  'AUDIT_READ',
  'SETTINGS_MANAGE',
  'EXPORT_CREATE',
  'ALERT_MANAGE',
  // Phase 12 — read-only Security Center (login failures, active
  // lockouts, throttle blocks, cross-user session list). Write
  // actions on those views (revoking arbitrary sessions, etc.) still
  // require `USER_MANAGE`; this capability gates only the visibility.
  'SECURITY_READ',
  // Phase 5: Manage IP allow/deny rules enforced before authentication.
  'IP_RULE_MANAGE',
  // Scheduled Postgres exports (backup feature). Holders of this
  // capability can read + download full database dumps, so this is
  // deliberately NOT in `MANAGER_PRESET` — it has to be granted
  // explicitly, the same way `SETTINGS_MANAGE` / `EXPORT_CREATE` are.
  'BACKUP_MANAGE',
  // Phase 12+ — read-only global ticket browse across every client
  // visible to the operator. Holders can view ticket subjects,
  // bodies, and activity timelines from the integrated upstream
  // helpdesk. Read-only; no writes back to upstream.
  'TICKETS_READ',
] as const;
export type PlatformCapability = (typeof PlatformCapabilityValues)[number];

// Convenience preset for the "manager / senior tech" persona — the
// user-edit form should expose this as a one-click toggle so admins
// don't have to tick every capability by hand. Excludes
// `SETTINGS_MANAGE` and `EXPORT_CREATE`, which are owner-y enough that
// most teams will want to grant them deliberately.
export const MANAGER_PRESET: readonly PlatformCapability[] = [
  'COMPANY_MANAGE',
  'INTEGRATION_MANAGE',
  'LAYOUT_MANAGE',
  'TAG_MANAGE',
  'USER_MANAGE',
  'MEMBERSHIP_MANAGE',
  'AUDIT_READ',
  'SECURITY_READ',
  'IP_RULE_MANAGE',
  'TICKETS_READ',
] as const;

// ───────────────────────────────────────────────────────────────────
// RBAC v2 — capability + access resolution
// ───────────────────────────────────────────────────────────────────
//
// Mirrors `apps/api/src/rbac/permission.service.ts`. Clients use these
// only to *hide* unreachable controls; the server is still the source
// of truth and will 403 anything stale.
//
// Promoted from `apps/web/src/lib/roles.ts` so `apps/mobile` can gate
// its write UI without importing across the app boundary. The types
// are **structural** because the two apps' `/me` payloads differ in
// one load-bearing way: the web `/me` nests `company: { id }` on each
// membership, while `/auth/me` (which mobile consumes) returns a flat
// `companyId`. `activeMembershipFor` accepts either — matching only
// one shape would silently evaluate every mobile check to NONE.

/** The slice of a membership row the access helpers need. */
export interface MembershipLike {
  role: MembershipRole;
  expiresAt: string | null;
  /** Flat shape (`/auth/me`). */
  companyId?: string;
  /** Nested shape (`/me`). */
  company?: { id: string };
}

/**
 * The smallest possible "viewer" identity the helpers need to evaluate
 * a permission check. Both apps' `Me` types satisfy it structurally.
 */
export interface ViewerLike {
  role: UserRole;
  globalAccess: GlobalAccess | null;
  platformCapabilities: readonly PlatformCapability[];
  memberships: readonly MembershipLike[];
}

export type CompanyAccess = 'FULL' | 'READONLY' | 'NONE';

/**
 * Non-revoked, non-expired memberships for the current user. The API
 * already hides revoked rows from `/me`, but expiry is a client-side
 * clock comparison so we normalise it here. Generic so callers keep
 * their own richer membership type on the way out.
 */
export function activeMemberships<M extends MembershipLike>(me: {
  memberships: readonly M[];
}): M[] {
  const now = Date.now();
  return me.memberships.filter(
    (m) => !m.expiresAt || new Date(m.expiresAt).getTime() > now,
  );
}

export function activeMembershipFor<M extends MembershipLike>(
  me: { memberships: readonly M[] } | null | undefined,
  companyId: string,
): M | null {
  if (!me) return null;
  return (
    activeMemberships(me).find(
      (m) => (m.company?.id ?? m.companyId) === companyId,
    ) ?? null
  );
}

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
  me: Pick<ViewerLike, 'role' | 'platformCapabilities'> | null | undefined,
  capability: PlatformCapability,
): boolean {
  if (!me) return false;
  if (me.role === 'SUPER_ADMIN') return true;
  return me.platformCapabilities.includes(capability);
}

export function hasAnyCapability(
  me: Pick<ViewerLike, 'role' | 'platformCapabilities'> | null | undefined,
  capabilities: readonly PlatformCapability[],
): boolean {
  if (!me) return false;
  if (me.role === 'SUPER_ADMIN') return true;
  return capabilities.some((c) => me.platformCapabilities.includes(c));
}

// ───────────────────────────────────────────────────────────────────
// Display helpers
// ───────────────────────────────────────────────────────────────────
//
// Framework-free, so both apps import them from here rather than
// keeping a copy each. `apps/mobile` needs them for the org-sheet
// avatars and the More tab's profile card, and its eslint config hard-
// blocks importing anything out of `apps/web` — which is the right
// constraint, so the helpers moved instead of being duplicated.

/**
 * Up to two initials from a display name, uppercased.
 *
 * Falls back to `?` rather than an empty string: an empty avatar reads
 * as a rendering bug, whereas `?` reads as missing data.
 */
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

/** `CLIENT_USER` → `client user`. Takes a string so callers can pass
 *  either a `UserRole` or a raw value straight off the wire. */
export function roleLabel(role: string): string {
  return role.toLowerCase().replace(/_/g, ' ');
}
