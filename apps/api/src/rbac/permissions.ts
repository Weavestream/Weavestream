import type { MembershipRole, UserRole } from '@weavestream/shared';

/**
 * Single source of truth for every authorization decision in the system.
 *
 * This file encodes BUILD_PLAN Part 4 exactly. A unit test
 * (`permissions.spec.ts`) iterates the matrix and `docs/permissions.md`
 * is generated from this file so they can never drift.
 *
 * Authorization is two-layered:
 *   - `User.role` (global) governs what the caller can do outside company
 *     scope (SUPER_ADMIN) and grants CONTRACTOR their data plane rights.
 *   - `Membership.role` (per-company) governs what the caller can do
 *     inside a given company.
 *
 * For a permission rule with scope='company':
 *   - If the user's global role is in `allowGlobal`, they satisfy the
 *     rule *provided they have a matching membership for the company*
 *     (or are SUPER_ADMIN, which short-circuits).
 *   - Or, if their membership role for the company is in
 *     `allowMembership`, they satisfy regardless of global role.
 *   - `requireNonExpiredMembership` hard-filters expired memberships.
 *
 * For scope='global', only `allowGlobal` is consulted.
 * For scope='self', the resource owner check happens inside the service.
 */

export const ActionValues = [
  // Global platform administration
  'user.manage',
  'company.manage',

  // Per-company administration
  'integration.manage',
  'sync.trigger',
  'membership.manage',

  // Layouts — always global in v1 (see DECISIONS.md D-007 layouts-are-global).
  // All companies share the same catalog and only SUPER_ADMIN may mutate.
  'layout.manage.global',

  // Assets
  'asset.write',
  'asset.read',
  'asset.archive',

  // Articles
  'article.write',
  'article.read',

  // Uploads
  'upload.create',
  'upload.read',

  // Relations (Phase 5)
  'relation.read',
  'relation.write',

  // Domains (Phase 8)
  'domain.read',
  'domain.manage',

  // Passwords (Phase 10 — encrypted credential vault)
  'password.read',
  'password.write',
  'password.reveal',
  'password.archive',

  // Audit
  'audit.read',

  // Branding & terminology settings (instance-wide singleton row).
  // Read-only GET is @AuthedOnly; this action gates the PATCH.
  'settings.manage',
] as const;

export type Action = (typeof ActionValues)[number];

export type PermissionScope = 'global' | 'company' | 'self';

export interface PermissionRule {
  scope: PermissionScope;
  allowGlobal: UserRole[];
  allowMembership: MembershipRole[];
  requireNonExpiredMembership: boolean;
  note?: string;
}

const G_ADMIN: UserRole[] = ['SUPER_ADMIN'];
const M_OP_FULL: MembershipRole[] = ['OPERATOR_FULL'];
const M_OP_ANY: MembershipRole[] = ['OPERATOR_FULL', 'OPERATOR_READONLY'];
const M_CLIENT_ANY: MembershipRole[] = ['CLIENT_ADMIN', 'CLIENT_VIEWER'];

export const PERMISSIONS: Record<Action, PermissionRule> = {
  'user.manage': {
    scope: 'global',
    allowGlobal: G_ADMIN,
    allowMembership: [],
    requireNonExpiredMembership: false,
  },
  'company.manage': {
    scope: 'global',
    allowGlobal: G_ADMIN,
    allowMembership: [],
    requireNonExpiredMembership: false,
  },
  'integration.manage': {
    scope: 'company',
    allowGlobal: G_ADMIN,
    allowMembership: M_OP_FULL,
    requireNonExpiredMembership: true,
  },
  'sync.trigger': {
    scope: 'company',
    allowGlobal: G_ADMIN,
    allowMembership: M_OP_FULL,
    requireNonExpiredMembership: true,
  },
  'membership.manage': {
    scope: 'company',
    allowGlobal: G_ADMIN,
    allowMembership: M_OP_FULL,
    requireNonExpiredMembership: true,
  },

  'layout.manage.global': {
    scope: 'global',
    allowGlobal: G_ADMIN,
    allowMembership: [],
    requireNonExpiredMembership: false,
    note: 'Layouts are global (D-007). Mutation is SUPER_ADMIN only; read is implicit for every authenticated role so forms and lists render.',
  },

  'asset.write': {
    scope: 'company',
    allowGlobal: ['SUPER_ADMIN', 'CONTRACTOR'],
    allowMembership: M_OP_FULL,
    requireNonExpiredMembership: true,
    note: 'CONTRACTOR needs a non-expired membership; OPERATOR needs OPERATOR_FULL membership.',
  },
  'asset.read': {
    scope: 'company',
    allowGlobal: ['SUPER_ADMIN', 'CONTRACTOR'],
    allowMembership: [...M_OP_ANY, ...M_CLIENT_ANY],
    requireNonExpiredMembership: false,
    note: 'CLIENT_* sees visible_to_clients only; per-row filter applied by asset service.',
  },
  'asset.archive': {
    scope: 'company',
    allowGlobal: ['SUPER_ADMIN', 'CONTRACTOR'],
    allowMembership: M_OP_FULL,
    requireNonExpiredMembership: true,
  },

  'article.write': {
    scope: 'company',
    allowGlobal: ['SUPER_ADMIN', 'CONTRACTOR'],
    allowMembership: M_OP_FULL,
    requireNonExpiredMembership: true,
  },
  'article.read': {
    scope: 'company',
    allowGlobal: ['SUPER_ADMIN', 'CONTRACTOR'],
    allowMembership: [...M_OP_ANY, ...M_CLIENT_ANY],
    requireNonExpiredMembership: false,
  },

  'upload.create': {
    scope: 'company',
    allowGlobal: ['SUPER_ADMIN', 'CONTRACTOR'],
    allowMembership: ['OPERATOR_FULL', 'CLIENT_ADMIN'],
    requireNonExpiredMembership: true,
  },
  'upload.read': {
    scope: 'company',
    allowGlobal: ['SUPER_ADMIN', 'CONTRACTOR'],
    allowMembership: [...M_OP_ANY, ...M_CLIENT_ANY],
    requireNonExpiredMembership: false,
  },

  'relation.read': {
    scope: 'company',
    allowGlobal: ['SUPER_ADMIN', 'CONTRACTOR'],
    allowMembership: [...M_OP_ANY, ...M_CLIENT_ANY],
    requireNonExpiredMembership: false,
    note: 'Linked-items list on asset and article detail pages. CLIENT_* sees only related articles whose visibleToClients=true; filter applied by RelationsService.listRelated.',
  },
  'relation.write': {
    scope: 'company',
    allowGlobal: ['SUPER_ADMIN', 'CONTRACTOR'],
    allowMembership: M_OP_FULL,
    requireNonExpiredMembership: true,
    note: 'Manual link/unlink of polymorphic relations. CLIENT_* cannot mutate; ASSET_REFERENCE field writes run through AssetsService (asset.write) and the RelationsService side-effect rather than this action.',
  },

  'domain.read': {
    scope: 'company',
    allowGlobal: ['SUPER_ADMIN', 'CONTRACTOR'],
    allowMembership: [...M_OP_ANY, ...M_CLIENT_ANY],
    requireNonExpiredMembership: false,
    note: 'CLIENT_* sees only rows where visibleToClients=true. The per-row filter is applied by DomainsService, matching the article pattern.',
  },
  'domain.manage': {
    scope: 'company',
    allowGlobal: G_ADMIN,
    allowMembership: M_OP_FULL,
    requireNonExpiredMembership: true,
    note: 'Covers create / update / archive / restore and flipping visibleToClients, plus the manual "Check now" enqueue.',
  },

  // Password vault — Phase 10. Read/reveal split is enforced by the
  // service (`password.read` only ever returns metadata + decrypted
  // notes, never the password/TOTP secret). `password.reveal` is the
  // separate, audited + rate-limited gate on plaintext. Write/archive
  // are OPERATOR_FULL only — CLIENT_* never mutates credentials.
  'password.read': {
    scope: 'company',
    allowGlobal: ['SUPER_ADMIN', 'CONTRACTOR'],
    allowMembership: [...M_OP_ANY, ...M_CLIENT_ANY],
    requireNonExpiredMembership: false,
    note: 'CLIENT_* sees only rows where visibleToClients=true. Per-row filter applied by PasswordsService (mirrors the article/domain pattern).',
  },
  'password.write': {
    scope: 'company',
    allowGlobal: ['SUPER_ADMIN', 'CONTRACTOR'],
    allowMembership: M_OP_FULL,
    requireNonExpiredMembership: true,
    note: 'Covers create/update + version restore. CLIENT_* never writes credentials.',
  },
  'password.reveal': {
    scope: 'company',
    allowGlobal: ['SUPER_ADMIN', 'CONTRACTOR'],
    allowMembership: ['OPERATOR_FULL', 'OPERATOR_READONLY', 'CLIENT_ADMIN'],
    requireNonExpiredMembership: true,
    note: 'CLIENT_ADMIN may reveal only passwords flagged visibleToClients=true. `restrictedToUserIds` and `requireReasonToView` are enforced inside PasswordsService, which also writes the password.revealed audit row.',
  },
  'password.archive': {
    scope: 'company',
    allowGlobal: ['SUPER_ADMIN', 'CONTRACTOR'],
    allowMembership: M_OP_FULL,
    requireNonExpiredMembership: true,
  },

  'audit.read': {
    scope: 'company',
    allowGlobal: G_ADMIN,
    allowMembership: M_OP_FULL,
    requireNonExpiredMembership: false,
  },

  'settings.manage': {
    scope: 'global',
    allowGlobal: G_ADMIN,
    allowMembership: [],
    requireNonExpiredMembership: false,
    note: 'Workspace name + tenant term live in a singleton `system_settings` row; only SUPER_ADMIN may mutate. Every authenticated user may read via @AuthedOnly GET /settings.',
  },
};

export const ACTION_HUMAN_LABELS: Record<Action, string> = {
  'user.manage': 'Manage users',
  'company.manage': 'Manage companies',
  'integration.manage': 'Configure integrations',
  'sync.trigger': 'Trigger manual sync',
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
};
