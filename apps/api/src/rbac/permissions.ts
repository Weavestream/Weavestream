import type { GlobalAccess, MembershipRole, PlatformCapability } from '@weavestream/shared';

/**
 * Single source of truth for every authorization decision in the system.
 *
 * The model has two orthogonal axes for non-SUPER_ADMIN users:
 *
 *   1. **Per-company access** (`Membership.role` ∪ `User.globalAccess`)
 *      governs CRUD on company-scoped data (assets, articles,
 *      passwords, domains, …). Resolution per (user, companyId):
 *        - if a non-revoked, non-expired membership exists → use
 *          `membership.role` (FULL or READONLY) — the explicit
 *          per-tenant override always wins, even when more restrictive
 *          than `globalAccess`.
 *        - else if user is OPERATOR → use `globalAccess`
 *          (FULL / READONLY / NONE). `NONE` always denies.
 *        - else (CONTRACTOR, CLIENT_USER) → deny.
 *
 *   2. **Platform-admin capabilities** (`User.platformCapabilities`)
 *      gate the operations that previously required SUPER_ADMIN
 *      (managing companies, integrations, layouts, users, memberships,
 *      audit, settings, exports). Each rule that is platform-admin
 *      sets `requiredCapability`; SUPER_ADMIN implicitly satisfies
 *      every capability.
 *
 * Promoting or demoting another user to/from `SUPER_ADMIN` remains a
 * hard SUPER_ADMIN-only check inside `users.service.ts` regardless of
 * `USER_MANAGE`.
 */

export const ActionValues = [
  'user.manage',
  'company.read',
  'company.manage',
  'integration.manage',
  'sync.trigger',
  'membership.read',
  'membership.manage',

  'layout.manage.global',

  'asset.write',
  'asset.read',
  'asset.archive',

  'article.write',
  'article.read',

  'upload.create',
  'upload.read',

  'relation.read',
  'relation.write',

  'domain.read',
  'domain.manage',

  'password.read',
  'password.write',
  'password.reveal',
  'password.archive',

  'audit.read',

  'settings.manage',

  'export.create',
] as const;

export type Action = (typeof ActionValues)[number];

export type PermissionScope = 'global' | 'company' | 'self';

export interface PermissionRule {
  scope: PermissionScope;
  /**
   * Platform-admin gate. When set, the caller must hold this
   * capability (SUPER_ADMIN implicitly holds all). For company-scoped
   * rules with a `requiredCapability`, the capability is sufficient on
   * its own — no additional FULL/READONLY membership check runs (so an
   * elevated operator with `MEMBERSHIP_MANAGE` can administer any
   * company's roster, just like SUPER_ADMIN used to).
   */
  requiredCapability?: PlatformCapability;
  /** Company-scoped: does FULL effective access satisfy the rule? */
  allowFull: boolean;
  /** Company-scoped: does READONLY effective access satisfy the rule? */
  allowReadonly: boolean;
  requireNonExpiredMembership: boolean;
  note?: string;
}

export const PERMISSIONS: Record<Action, PermissionRule> = {
  'user.manage': {
    scope: 'global',
    requiredCapability: 'USER_MANAGE',
    allowFull: false,
    allowReadonly: false,
    requireNonExpiredMembership: false,
    note: 'Promotion to/from SUPER_ADMIN is gated by an additional SA-only check inside UsersService.',
  },
  'company.read': {
    scope: 'company',
    allowFull: true,
    allowReadonly: true,
    requireNonExpiredMembership: false,
    note: 'Read a single Company row. Any FULL/READONLY effective access (membership or operator globalAccess) is sufficient — managing the row still requires COMPANY_MANAGE.',
  },
  'company.manage': {
    scope: 'global',
    requiredCapability: 'COMPANY_MANAGE',
    allowFull: false,
    allowReadonly: false,
    requireNonExpiredMembership: false,
  },
  // Phase 11: integrations are GLOBAL — one Integration row drives sync
  // across many companies via `IntegrationCompanyMapping`. Both
  // creating / editing the connection and pressing "Run sync" are
  // gated by INTEGRATION_MANAGE so a senior operator can be elevated
  // without needing SUPER_ADMIN.
  'integration.manage': {
    scope: 'global',
    requiredCapability: 'INTEGRATION_MANAGE',
    allowFull: false,
    allowReadonly: false,
    requireNonExpiredMembership: false,
  },
  'sync.trigger': {
    scope: 'global',
    requiredCapability: 'INTEGRATION_MANAGE',
    allowFull: false,
    allowReadonly: false,
    requireNonExpiredMembership: false,
  },
  'membership.read': {
    scope: 'company',
    allowFull: true,
    allowReadonly: true,
    requireNonExpiredMembership: false,
    note: 'List the roster for a company. Anyone with FULL/READONLY effective access may see who else has access; only `membership.manage` can change it.',
  },
  'membership.manage': {
    scope: 'company',
    requiredCapability: 'MEMBERSHIP_MANAGE',
    allowFull: false,
    allowReadonly: false,
    requireNonExpiredMembership: false,
    note: 'Membership administration is platform-admin: a holder of MEMBERSHIP_MANAGE may manage any company roster.',
  },

  'layout.manage.global': {
    scope: 'global',
    requiredCapability: 'LAYOUT_MANAGE',
    allowFull: false,
    allowReadonly: false,
    requireNonExpiredMembership: false,
    note: 'Layouts are global (D-007). Read is implicit for every authenticated user; mutation is gated.',
  },

  'asset.write': {
    scope: 'company',
    allowFull: true,
    allowReadonly: false,
    requireNonExpiredMembership: true,
  },
  'asset.read': {
    scope: 'company',
    allowFull: true,
    allowReadonly: true,
    requireNonExpiredMembership: false,
    note: 'CLIENT_USER sees visible_to_clients only; per-row filter applied by AssetsService.',
  },
  'asset.archive': {
    scope: 'company',
    allowFull: true,
    allowReadonly: false,
    requireNonExpiredMembership: true,
  },

  'article.write': {
    scope: 'company',
    allowFull: true,
    allowReadonly: false,
    requireNonExpiredMembership: true,
  },
  'article.read': {
    scope: 'company',
    allowFull: true,
    allowReadonly: true,
    requireNonExpiredMembership: false,
  },

  'upload.create': {
    scope: 'company',
    allowFull: true,
    allowReadonly: false,
    requireNonExpiredMembership: true,
  },
  'upload.read': {
    scope: 'company',
    allowFull: true,
    allowReadonly: true,
    requireNonExpiredMembership: false,
  },

  'relation.read': {
    scope: 'company',
    allowFull: true,
    allowReadonly: true,
    requireNonExpiredMembership: false,
    note: 'CLIENT_USER sees only related articles whose visibleToClients=true; filter applied by RelationsService.listRelated.',
  },
  'relation.write': {
    scope: 'company',
    allowFull: true,
    allowReadonly: false,
    requireNonExpiredMembership: true,
  },

  'domain.read': {
    scope: 'company',
    allowFull: true,
    allowReadonly: true,
    requireNonExpiredMembership: false,
    note: 'CLIENT_USER sees only rows where visibleToClients=true; per-row filter applied by DomainsService.',
  },
  'domain.manage': {
    scope: 'company',
    allowFull: true,
    allowReadonly: false,
    requireNonExpiredMembership: true,
  },

  'password.read': {
    scope: 'company',
    allowFull: true,
    allowReadonly: true,
    requireNonExpiredMembership: false,
    note: 'CLIENT_USER sees only rows where visibleToClients=true.',
  },
  'password.write': {
    scope: 'company',
    allowFull: true,
    allowReadonly: false,
    requireNonExpiredMembership: true,
  },
  'password.reveal': {
    scope: 'company',
    allowFull: true,
    allowReadonly: true,
    requireNonExpiredMembership: true,
    note: 'CLIENT_USER may reveal only passwords flagged visibleToClients=true. `restrictedToUserIds` and `requireReasonToView` are enforced inside PasswordsService.',
  },
  'password.archive': {
    scope: 'company',
    allowFull: true,
    allowReadonly: false,
    requireNonExpiredMembership: true,
  },

  'audit.read': {
    scope: 'global',
    requiredCapability: 'AUDIT_READ',
    allowFull: false,
    allowReadonly: false,
    requireNonExpiredMembership: false,
    note: 'Per the role policy, audit is platform-admin. AUDIT_READ holders may list the global audit feed and may filter by companyId — same surface SUPER_ADMIN gets.',
  },

  'settings.manage': {
    scope: 'global',
    requiredCapability: 'SETTINGS_MANAGE',
    allowFull: false,
    allowReadonly: false,
    requireNonExpiredMembership: false,
    note: 'Workspace name + tenant term live in a singleton `system_settings` row. Read is @AuthedOnly; this gates the PATCH.',
  },

  'export.create': {
    scope: 'global',
    requiredCapability: 'EXPORT_CREATE',
    allowFull: false,
    allowReadonly: false,
    requireNonExpiredMembership: false,
    note: 'Trigger a company vault-archive PDF export. Sensitive — typically delegated only to trusted operators.',
  },
};

export const ACTION_HUMAN_LABELS: Record<Action, string> = {
  'user.manage': 'Manage users',
  'company.read': 'View company',
  'company.manage': 'Manage companies',
  'integration.manage': 'Configure integrations',
  'sync.trigger': 'Trigger manual sync',
  'membership.read': 'View memberships',
  'membership.manage': 'Manage memberships',
  'layout.manage.global': 'Create/edit asset layouts (global catalog)',
  'asset.write': 'Create/edit assets',
  'asset.read': 'View assets',
  'asset.archive': 'Archive/restore assets',
  'article.write': 'Create/edit articles',
  'article.read': 'View articles',
  'upload.create': 'Upload files',
  'upload.read': 'Download files',
  'relation.read': 'View linked items',
  'relation.write': 'Link / unlink items',
  'domain.read': 'View monitored domains',
  'domain.manage': 'Add / edit / archive monitored domains',
  'password.read': 'View saved passwords (metadata + notes)',
  'password.write': 'Create / edit / restore saved passwords',
  'password.reveal': 'Reveal a saved password or TOTP secret',
  'password.archive': 'Archive / restore saved passwords',
  'audit.read': 'View audit log',
  'settings.manage': 'Edit workspace branding and tenant terminology',
  'export.create': 'Trigger a company vault-archive PDF export',
};

// Re-exported for callers that previously consumed the unused
// `PermissionRule.allowGlobal` / `allowMembership` arrays.
export type { GlobalAccess, MembershipRole, PlatformCapability };
