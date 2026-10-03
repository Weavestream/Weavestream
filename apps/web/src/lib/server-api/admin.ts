import type {
  GlobalAccess,
  MembershipRole,
  PlatformCapability,
  UserRole,
} from '@weavestream/shared';
import { serverApiFetch } from './core';
import type { CompanyLogo } from './companies';

export type UserListItem = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  /**
   * RBAC v2 — `null` for non-OPERATOR roles. The API rejects writes
   * that try to set this on any other role, so the UI can rely on
   * non-null implying OPERATOR.
   */
  globalAccess: GlobalAccess | null;
  /**
   * RBAC v2 — empty array unless the user is an OPERATOR with
   * delegated platform-admin capabilities. SUPER_ADMINs implicitly
   * hold every capability and the API enforces that this array stays
   * empty for them, so don't conflate "empty" with "no access".
   */
  platformCapabilities: PlatformCapability[];
  isActive: boolean;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  deactivatedAt: string | null;
  timezone: string | null;
};

export type UserPage = {
  items: UserListItem[];
  nextCursor: string | null;
};

export type UserDetail = UserListItem & {
  mfaEnforcementCompletedAt: string | null;
  memberships: Array<{
    id: string;
    role: MembershipRole;
    expiresAt: string | null;
    revokedAt: string | null;
    createdAt: string;
    company: { id: string; name: string; slug: string; archivedAt: string | null };
  }>;
};

export type AuditEntry = {
  id: string;
  createdAt: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  entityName: string | null;
  companyId: string | null;
  companyName: string | null;
  actorId: string | null;
  ip: string | null;
  userAgent: string | null;
  actor: { id: string; name: string; email: string } | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

export type AuditPage = {
  items: AuditEntry[];
  total: number | null;
  page: number | null;
  pageSize: number;
  nextCursor: string | null;
};

// ---------------------------------------------------------------------
// Admin stats — totals shown on the global dashboard's "At a glance"
// panel. Endpoint is gated to SUPER_ADMIN + OPERATOR with non-NONE
// globalAccess; for any other viewer it 403s and we return `null` so
// the dashboard can degrade gracefully.
// ---------------------------------------------------------------------
type AdminStats = {
  companies: number;
  users: number;
  assets: number;
  passwords: number;
  articles: number;
  domains: number;
};

export async function getAdminStats(): Promise<AdminStats | null> {
  const res = await serverApiFetch<AdminStats>('/admin/stats');
  return res.ok ? res.data : null;
}

// ---------------------------------------------------------------------
// Expirations — unified feed across asset-field (isExpiry) dates and
// domain (registrar/TLS) expiries. Read-only; no mutating endpoints.
// ---------------------------------------------------------------------

type ExpirationStatus = 'EXPIRED' | 'WARNING';

type AssetFieldExpiration = {
  kind: 'asset-field';
  companyId: string;
  companyName: string;
  companySlug: string;
  assetId: string;
  assetName: string;
  layoutId: string;
  layoutName: string;
  layoutIcon: string;
  layoutColor: string;
  fieldId: string;
  fieldSlug: string;
  fieldLabel: string;
  fieldType: 'DATE' | 'DATETIME';
  expiresAt: string;
  daysUntil: number;
  status: ExpirationStatus;
  warnWithinDays: number;
};

type DomainExpiration = {
  kind: 'domain';
  companyId: string;
  companyName: string;
  companySlug: string;
  domainId: string;
  hostname: string;
  source: 'registrar' | 'tls';
  expiresAt: string;
  daysUntil: number;
  status: ExpirationStatus;
};

type PasswordExpiration = {
  kind: 'password';
  companyId: string;
  companyName: string;
  companySlug: string;
  passwordId: string;
  passwordName: string;
  /**
   * `expiry` = hard `Password.expiresAt` cutoff; `rotation` = soft
   * "should have been rotated by now" date derived from
   * `lastRotatedAt + rotationReminderDays`. A single credential can
   * surface up to one row of each kind.
   */
  source: 'expiry' | 'rotation';
  expiresAt: string;
  daysUntil: number;
  status: ExpirationStatus;
};

export type ExpirationRow =
  | AssetFieldExpiration
  | DomainExpiration
  | PasswordExpiration;

/**
 * Fetch the unified expiring-soon feed. Pass `companyId` for a
 * tenant-scoped list, omit for the global (SUPER_ADMIN) cross-tenant
 * feed. Returns an empty list on 403 so callers can use the result to
 * decide whether to render the link at all.
 */
export async function listExpirations(
  companyId?: string,
): Promise<ExpirationRow[]> {
  const path = companyId
    ? `/companies/${companyId}/expirations`
    : '/expirations';
  const res = await serverApiFetch<{ items: ExpirationRow[] }>(path);
  return res.data?.items ?? [];
}

/**
 * A single entry in the unified `GET /me/stars` response. Each
 * variant is discriminated by `type` so callers can `switch` on it
 * with full TypeScript narrowing — the dashboard panel uses this to
 * pick the right icon, sub-line, and link target per entity.
 */
export type StarredItem =
  | {
      type: 'company';
      id: string;
      name: string;
      slug: string;
      archivedAt: string | null;
      starredAt: string;
      companyId: string;
      companyName: string;
      memberCount: number;
      logo: CompanyLogo | null;
    }
  | {
      type: 'password';
      id: string;
      name: string;
      archivedAt: string | null;
      starredAt: string;
      companyId: string;
      companyName: string;
      companyArchivedAt: string | null;
    }
  | {
      type: 'asset';
      id: string;
      name: string;
      archivedAt: string | null;
      starredAt: string;
      companyId: string;
      companyName: string;
      companyArchivedAt: string | null;
      layoutName: string | null;
      layoutIcon: string | null;
    }
  | {
      type: 'article';
      id: string;
      name: string;
      slug: string;
      archivedAt: string | null;
      starredAt: string;
      companyId: string;
      companyName: string;
      companyArchivedAt: string | null;
    };

export async function listStarred(): Promise<StarredItem[]> {
  const res = await serverApiFetch<{ items: StarredItem[] }>('/me/stars');
  return res.data?.items ?? [];
}

export type RecentActivityItem = {
  type: 'asset' | 'article';
  id: string;
  name: string;
  companyId: string;
  companyName: string;
  companySlug: string;
  action: 'created' | 'updated';
  updatedAt: string;
  updatedByName: string | null;
};

export async function listRecentActivity(
  limit = 10,
): Promise<RecentActivityItem[]> {
  const res = await serverApiFetch<{ items: RecentActivityItem[] }>(
    `/activity/recent?limit=${limit}`,
  );
  return res.data?.items ?? [];
}
