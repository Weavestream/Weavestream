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
] as const;
