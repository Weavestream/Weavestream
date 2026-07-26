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
