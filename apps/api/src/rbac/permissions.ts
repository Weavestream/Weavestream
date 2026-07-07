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
 *      Operator `globalAccess` satisfies EVERY company-scoped action —
 *      including writes, reveals, archives, purges, and uploads. No
 *      action additionally demands an explicit membership (WS-016,
 *      confirmed policy). Memberships exist to RESTRICT or OVERRIDE an
 *      operator's access for one company; when a membership expires or
 *      is revoked the operator reverts to `globalAccess`, by design
 *      even when that widens their access again.
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
  'tag.manage.global',

  'asset.write',
  'asset.read',
  'asset.archive',
  'asset.purge',

  'article.write',
  'article.read',
  'article.purge',

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

  'alert.manage',

  'security.read',

  'ip_rule.manage',

  'backup.manage',

  'tickets.read.global',
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
  note?: string;
}

export const PERMISSIONS: Record<Action, PermissionRule> = {
  'user.manage': {
    scope: 'global',
    requiredCapability: 'USER_MANAGE',
    allowFull: false,
    allowReadonly: false,
    note: 'Promotion to/from SUPER_ADMIN is gated by an additional SA-only check inside UsersService.',
  },
  'company.read': {
    scope: 'company',
    allowFull: true,
    allowReadonly: true,
    note: 'Read a single Company row. Any FULL/READONLY effective access (membership or operator globalAccess) is sufficient — managing the row still requires COMPANY_MANAGE.',
  },
  'company.manage': {
    scope: 'global',
    requiredCapability: 'COMPANY_MANAGE',
    allowFull: false,
    allowReadonly: false,
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
  },
  'sync.trigger': {
    scope: 'global',
    requiredCapability: 'INTEGRATION_MANAGE',
    allowFull: false,
    allowReadonly: false,
  },
  'membership.read': {
    scope: 'company',
    allowFull: true,
    allowReadonly: true,
    note: 'List the roster for a company. Anyone with FULL/READONLY effective access may see who else has access; only `membership.manage` can change it.',
  },
  'membership.manage': {
    scope: 'company',
    requiredCapability: 'MEMBERSHIP_MANAGE',
    allowFull: false,
    allowReadonly: false,
    note: 'Membership administration is platform-admin: a holder of MEMBERSHIP_MANAGE may manage any company roster.',
  },

  'layout.manage.global': {
    scope: 'global',
    requiredCapability: 'LAYOUT_MANAGE',
    allowFull: false,
    allowReadonly: false,
    note: 'Layouts are global (D-007). Read is implicit for every authenticated user; mutation is gated.',
  },

  'tag.manage.global': {
    scope: 'global',
    requiredCapability: 'TAG_MANAGE',
    allowFull: false,
    allowReadonly: false,
    note: 'Tags are global. Read + inline-create on asset save is implicit for every authenticated user; rename/delete is gated.',
  },

  'asset.write': {
    scope: 'company',
    allowFull: true,
    allowReadonly: false,
  },
  'asset.read': {
    scope: 'company',
    allowFull: true,
    allowReadonly: true,
    note: 'CLIENT_USER sees visible_to_clients only; per-row filter applied by AssetsService.',
  },
  'asset.archive': {
    scope: 'company',
    allowFull: true,
    allowReadonly: false,
  },
  'asset.purge': {
    scope: 'company',
    allowFull: true,
    allowReadonly: false,
    note: 'Hard-deletes an asset row (and its field values, sync records, relations, search index). Irreversible — used to expunge duplicates or stop an integration from re-syncing an archived shell. FULL company access only; the asset must be archived first so the operator confirms intent.',
  },

  'article.write': {
    scope: 'company',
    allowFull: true,
    allowReadonly: false,
  },
  'article.read': {
    scope: 'company',
    allowFull: true,
    allowReadonly: true,
  },
  'article.purge': {
    scope: 'company',
    allowFull: true,
    allowReadonly: false,
    note: 'Hard-deletes an article row (and its polymorphic relations + search-index entry). Irreversible — used to permanently expunge an archived draft. FULL company access only; the article must be archived first so the operator confirms intent.',
  },

  'upload.create': {
    scope: 'company',
    allowFull: true,
    allowReadonly: false,
  },
  'upload.read': {
    scope: 'company',
    allowFull: true,
    allowReadonly: true,
  },

  'relation.read': {
    scope: 'company',
    allowFull: true,
    allowReadonly: true,
    note: 'CLIENT_USER sees only related articles whose visibleToClients=true; filter applied by RelationsService.listRelated.',
  },
  'relation.write': {
    scope: 'company',
    allowFull: true,
    allowReadonly: false,
  },

  'domain.read': {
    scope: 'company',
    allowFull: true,
    allowReadonly: true,
    note: 'CLIENT_USER sees only rows where visibleToClients=true; per-row filter applied by DomainsService.',
  },
  'domain.manage': {
    scope: 'company',
    allowFull: true,
    allowReadonly: false,
  },

  'password.read': {
    scope: 'company',
    allowFull: true,
    allowReadonly: true,
    note: 'CLIENT_USER sees only rows where visibleToClients=true.',
  },
  'password.write': {
    scope: 'company',
    allowFull: true,
    allowReadonly: false,
  },
  'password.reveal': {
    scope: 'company',
    allowFull: true,
    allowReadonly: true,
    note: 'CLIENT_USER may reveal only passwords flagged visibleToClients=true. `restrictedToUserIds` and `requireReasonToView` are enforced inside PasswordsService.',
  },
  'password.archive': {
    scope: 'company',
    allowFull: true,
    allowReadonly: false,
  },

  'audit.read': {
    scope: 'global',
    requiredCapability: 'AUDIT_READ',
    allowFull: false,
    allowReadonly: false,
    note: 'Per the role policy, audit is platform-admin. AUDIT_READ holders may list the global audit feed and may filter by companyId — same surface SUPER_ADMIN gets.',
  },

  'settings.manage': {
    scope: 'global',
    requiredCapability: 'SETTINGS_MANAGE',
    allowFull: false,
    allowReadonly: false,
    note: 'Workspace name + tenant term live in a singleton `system_settings` row. Read is @AuthedOnly; this gates the PATCH.',
  },

  'export.create': {
    scope: 'global',
    requiredCapability: 'EXPORT_CREATE',
    allowFull: false,
    allowReadonly: false,
    note: 'Trigger a company vault-archive PDF export. Sensitive — typically delegated only to trusted operators.',
  },

  'alert.manage': {
    scope: 'global',
    requiredCapability: 'ALERT_MANAGE',
    allowFull: false,
    allowReadonly: false,
    note: 'Create / edit / archive alert configurations. Configs may scope to a specific company but the surface itself is global.',
  },

  'security.read': {
    scope: 'global',
    requiredCapability: 'SECURITY_READ',
    allowFull: false,
    allowReadonly: false,
    note: 'Read the admin Security Center: login failures, active lockouts, throttle blocks, and cross-user active sessions. Write actions on those rows still require their own capabilities (e.g. revoking another user\'s session needs USER_MANAGE).',
  },

  'ip_rule.manage': {
    scope: 'global',
    requiredCapability: 'IP_RULE_MANAGE',
    allowFull: false,
    allowReadonly: false,
    note: 'Create, update, and delete IP allow/deny rules enforced globally before authentication.',
  },

  'backup.manage': {
    scope: 'global',
    requiredCapability: 'BACKUP_MANAGE',
    allowFull: false,
    allowReadonly: false,
    note: 'Create, edit, and run scheduled Postgres exports. Holders can download raw database dumps, so grant deliberately.',
  },

  'tickets.read.global': {
    scope: 'global',
    requiredCapability: 'TICKETS_READ',
    allowFull: false,
    allowReadonly: false,
    note: 'Browse tickets from the integrated upstream helpdesk across every client. Read-only — no writes back to upstream. Admin / manager-only.',
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
  'tag.manage.global': 'Rename/delete global tags',
  'asset.write': 'Create/edit assets',
  'asset.read': 'View assets',
  'asset.archive': 'Archive/restore assets',
  'asset.purge': 'Permanently delete archived assets',
  'article.write': 'Create/edit articles',
  'article.read': 'View articles',
  'article.purge': 'Permanently delete archived articles',
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
  'alert.manage': 'Manage alert configurations',
  'security.read': 'View the Security Center (logins, lockouts, sessions)',
  'ip_rule.manage': 'Manage IP allow/deny rules',
  'backup.manage': 'Manage scheduled Postgres exports',
  'tickets.read.global': 'Browse upstream helpdesk tickets (global)',
};

// Re-exported for callers that previously consumed the unused
// `PermissionRule.allowGlobal` / `allowMembership` arrays.
export type { GlobalAccess, MembershipRole, PlatformCapability };
