import { cache } from 'react';
import { redirect } from 'next/navigation';
import { API_INTERNAL_URL } from './api-config';
import type {
  AiSettings,
  AlertConfig,
  ArticleDetail as SharedArticleDetail,
  ArticleEditorMode,
  ArticleSummary,
  ArticleVersionDetail,
  ArticleVersionSummary,
  BackupConfig,
  BackupRunDto,
  CatchAllFamilyGap,
  CompanyType,
  DomainCheckDetails,
  DomainScoreBreakdownItem,
  DomainScoreTier,
  FieldType,
  FolderNode,
  GlobalAccess,
  EmailSettings,
  IntegrationTargetProvenance,
  IpRule,
  IpRuleAction,
  MembershipRole,
  PasswordGeneratorDefaults,
  PasswordSummary,
  PlatformCapability,
  UserRole,
  UserSearchDefaults,
  UserUiPreferences,
} from '@weavestream/shared';
import { DEFAULT_PASSWORD_GENERATOR_DEFAULTS } from '@weavestream/shared';

export type {
  AiSettings,
  AlertConfig,
  ArticleEditorMode,
  ArticleSummary,
  ArticleVersionDetail,
  ArticleVersionSummary,
  BackupConfig,
  BackupRunDto,
  CompanyType,
  DomainCheckDetails,
  DomainScoreBreakdownItem,
  DomainScoreTier,
  FieldType,
  FolderNode,
  GlobalAccess,
  EmailSettings,
  IpRule,
  IpRuleAction,
  MembershipRole,
  PasswordGeneratorDefaults,
  PasswordSummary,
  PlatformCapability,
  UserRole,
  UserSearchDefaults,
  UserUiPreferences,
};

// Re-exported from the proxy/edge-safe `api-config` module (which `proxy.ts`
// also consumes) so the value and its default stay defined in one place.
export { API_INTERNAL_URL };

// The error classes, their `error.digest` constants, and the pure response
// classifiers live in the client-safe `api-errors` module so `app/error.tsx`
// (a client boundary) can import the same definitions this file throws.
import { unwrapApiResponse, unwrapMeResponse } from './api-errors';
export { ApiUnavailableError, RateLimitedError } from './api-errors';

// The transport lives in `server-api/core.ts`. Re-exported so existing
// consumers keep importing from here until the domain clients move out.
import {
  forMetadata,
  serverApiFetch,
  type ServerApiResponse,
} from './server-api/core';
export {
  forMetadata,
  serverApiFetch,
  throwUnlessFound,
  type ServerApiResponse,
} from './server-api/core';

export type Membership = {
  id: string;
  role: MembershipRole;
  expiresAt: string | null;
  company: { id: string; name: string; slug: string };
};

export type Me = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  /**
   * RBAC v2 — for OPERATOR users this is the default access level on
   * companies they don't have an explicit `Membership` for. `null` for
   * SUPER_ADMIN, CONTRACTOR, and CLIENT_USER (those roles never fall
   * back to a global tier — see `apps/api/src/rbac/permission.service.ts`).
   */
  globalAccess: GlobalAccess | null;
  /**
   * RBAC v2 — granular platform-admin tasks an OPERATOR has been
   * delegated. SUPER_ADMIN implicitly holds every capability and the
   * API enforces that this array is empty for non-OPERATORs.
   */
  platformCapabilities: PlatformCapability[];
  timezone: string | null;
  mfaEnabled: boolean;
  mfaEnforcementCompletedAt: string | null;
  searchDefaults: UserSearchDefaults | null;
  preferences: UserUiPreferences;
  createdAt: string;
  lastLoginAt: string | null;
  memberships: Membership[];
};

// `cache()` memoizes `getMe` for the duration of a single server request so
// the admin layout and the page it wraps share one `/me` call instead of
// each issuing their own. `serverApiFetch` sets `cache: 'no-store'`, which
// opts out of Next's own `fetch` deduper, so React's request-scoped cache
// is the right primitive here.
//
// Returns `null` ONLY when the user is genuinely unauthenticated
// (401/403) — the one case where the auth-gated layouts
// (`admin/layout.tsx`, `portal/[companySlug]/layout.tsx`, etc.) should
// redirect to `/login`. A network-level failure (after `serverApiFetch`'s
// ~5s retry budget) or a real API/proxy 5xx instead throws
// `ApiUnavailableError` (digest `WS_API_UNAVAILABLE`), which the
// `app/error.tsx` boundary renders as a dedicated backend-unavailable
// page — an outage used to return `null` here too, making it
// indistinguishable from being signed out (WS-021). A 429 throws
// `RateLimitedError` for the existing cooldown banner. Because `cache()`
// memoizes the *rejected* promise as well, the layout, its page, and any
// `generateMetadata` all observe one outcome from one `/me` call.
export const getMe = cache(async (): Promise<Me | null> => {
  return unwrapMeResponse(await serverApiFetch<Me>('/me'));
});

/**
 * Auth-gated convenience around {@link getMe} for pages and layouts that
 * must have a signed-in user. Redirects to `/login` when `getMe` returns
 * null and otherwise returns a non-null `Me`.
 *
 * Use this instead of the `(await getMe())!` non-null assertion: the App
 * Router renders layouts and their child pages in parallel, so even
 * though `/admin/layout.tsx` already redirects on a null `me`, a child
 * page evaluating `me.name` concurrently would throw a TypeError before
 * that redirect lands whenever `/me` momentarily fails or the session
 * has expired. `redirect()` returns `never`, so callers get a value
 * typed as `Me` with no assertion.
 */
export async function requireMe(): Promise<Me> {
  const me = await getMe();
  if (!me) redirect('/login');
  return me;
}


/** `getMe` variant for `generateMetadata`; see {@link forMetadata}. */
export const getMeForMetadata = (): Promise<Me | null> => forMetadata(getMe);

/**
 * Workspace branding + tenant terminology, fed from the singleton
 * `system_settings` row. Every authenticated page reads this once via
 * the root layout, so it's request-scoped memoized.
 */
export type Settings = {
  workspaceName: string;
  workspaceSubtitle: string;
  tenantTermSingular: string;
  tenantTermPlural: string;
  tenantTermPossessive: string | null;
  passwordGeneratorDefaults: PasswordGeneratorDefaults;
  articleAutosaveEnabled: boolean;
  /**
   * Workspace-wide default editor mode applied to *newly created*
   * articles. Existing articles keep their own `editorMode`. Resolved
   * server-side from `SystemSetting.articleDefaultEditorMode` and
   * piped into `ArticleForm` via the create-page server component.
   */
  articleDefaultEditorMode: ArticleEditorMode;
  updatedAt: string;
};

/**
 * Hard-coded defaults shipped with the product. Used when the API is
 * unreachable during SSR (first-paint on cold boot, or when running the
 * unauthenticated /login page). Must match the migration seed defaults
 * in packages/db/prisma/migrations/0006_phase5_system_settings.
 */
const DEFAULT_SETTINGS: Settings = {
  workspaceName: 'My Company',
  workspaceSubtitle: 'workspace',
  tenantTermSingular: 'Company',
  tenantTermPlural: 'Companies',
  tenantTermPossessive: null,
  passwordGeneratorDefaults: DEFAULT_PASSWORD_GENERATOR_DEFAULTS,
  articleAutosaveEnabled: false,
  articleDefaultEditorMode: 'tiptap',
  updatedAt: new Date(0).toISOString(),
};

// `/settings` is public and is called from the root layout on every
// request, including unauthenticated ones. On ANY failure — 401, 5xx,
// or the synthetic 503 from `serverApiFetch` when the backend is
// unreachable — fall back to `DEFAULT_SETTINGS`. Never throw: the root
// layout is the one thing that absolutely must render so the user can
// at least reach `/login` and re-authenticate. The extended retry loop
// in `serverApiFetch` (~5s) makes a real "down backend" reaching this
// branch exceedingly rare in practice.
export const getSettings = cache(async (): Promise<Settings> => {
  const res = await serverApiFetch<Settings>('/settings');
  if (!res.ok || !res.data) return DEFAULT_SETTINGS;
  return res.data;
});

const DEFAULT_EMAIL_SETTINGS: EmailSettings = {
  enabled: false,
  host: null,
  port: null,
  secureMode: 'STARTTLS',
  username: null,
  fromName: null,
  fromEmail: null,
  replyTo: null,
  passwordConfigured: false,
  updatedAt: new Date(0).toISOString(),
};

export const getEmailSettings = cache(async (): Promise<EmailSettings> => {
  const res = await serverApiFetch<EmailSettings>('/settings/email');
  if (!res.ok || !res.data) return DEFAULT_EMAIL_SETTINGS;
  return res.data;
});

const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  baseUrl: null,
  defaultModel: null,
  apiKeyConfigured: false,
  maxOutputTokens: null,
  contextWindowTokens: null,
  allowPrivateNetwork: false,
  autoSummaries: false,
  updatedAt: new Date(0).toISOString(),
};

export const getAiSettings = cache(async (): Promise<AiSettings> => {
  const res = await serverApiFetch<AiSettings>('/settings/ai');
  if (!res.ok || !res.data) return DEFAULT_AI_SETTINGS;
  return res.data;
});

/**
 * `/alerts` — list every active alert configuration. Returns `[]` on
 * any failure so the admin page can still render with a "no alerts
 * yet" empty state.
 */
export const getAlerts = cache(async (): Promise<AlertConfig[]> => {
  const res = await serverApiFetch<AlertConfig[]>('/alerts');
  if (!res.ok || !res.data) return [];
  return res.data;
});

// ───────────────────────────────────────────────────────────────────
// Request-scoped memoized reads used by the company-scoped RSC tree.
//
// Every route under `/admin/companies/[id]/**` consists of three
// server components stacked on top of each other: the company layout,
// its `generateMetadata`, and the leaf page. Without memoization each
// of them re-issues the same upstream call — `/companies/:id` alone
// got fetched three times per render, and `/layouts`, `/companies/:id/
// assets/counts-by-layout`, `/companies/:id/domains`, and `/companies/
// :id/passwords` twice each. At ~10 extra API calls per navigation,
// that was the dominant consumer of the throttle budget and directly
// caused the 429-as-404 bug in Docker (see apps/api/src/auth/
// user-throttler.guard.ts for the server-side half of the fix).
//
// Each helper below mirrors the un-cached list/fetch function it
// wraps but normalises arguments into primitives so React's
// `cache()` (which keys on `Object.is` equality) actually deduplicates
// matching calls within a single request. Callers that need a non-
// default variant (`includeArchived=true`, custom `q`, …) should stay
// on the un-cached helpers since those are genuinely different reads.
// ───────────────────────────────────────────────────────────────────

/**
 * `/companies/:id` — used by the shared company layout, its
 * `generateMetadata`, and every nested page. Returns the raw
 * `ServerApiResponse` so callers can still branch on 404 vs 401 vs
 * 429 via the web UX helper (`throwUnlessFound`).
 */
export const getCompanyDetail = cache(
  async (id: string): Promise<ServerApiResponse<CompanyDetail>> =>
    serverApiFetch<CompanyDetail>(`/companies/${id}`),
);

/**
 * `/layouts` — active layouts only. Shared by the company layout
 * (sidebar counts), the assets index page, the layouts detail page,
 * and the "new asset" page. Pages that need archived layouts should
 * still call `listLayouts({ includeArchived: true })` directly.
 */
export const getActiveLayouts = cache(
  async (): Promise<LayoutSummary[]> => listLayouts(),
);

export const getCompanyAssetCounts = cache(
  async (companyId: string): Promise<Record<string, number>> =>
    getAssetCountsByLayout(companyId),
);

/**
 * `/companies/:id/domains` — the first 200 active-and-non-active rows.
 * The shared layout pulls this for sidebar counts/alert badges and
 * the company home page renders the same list for its "needs
 * attention" banner. Pages that actually paginate (`domains/page.tsx`)
 * stay on `listDomains` since they set custom filters.
 */
export const getCompanyDomainsBasic = cache(
  async (
    companyId: string,
  ): Promise<{ items: MonitoredDomain[]; nextCursor: string | null }> =>
    listDomains(companyId, { limit: 200 }),
);

/**
 * `/companies/:id/passwords` — active only, no filters. The layout
 * uses the full row set for count + stale-badge math and the
 * passwords index page uses the same shape when it's showing the
 * default "active" view. Callers that need archived rows keep
 * `listPasswords(..., { archived: true })`.
 */
export const getCompanyActivePasswords = cache(
  async (companyId: string): Promise<PasswordSummary[]> =>
    listPasswords(companyId),
);

export const getCompanyFolderTree = cache(
  async (companyId: string): Promise<FolderNode[]> =>
    listFolderTree(companyId),
);

export const getCompanyPasswordFolders = cache(
  async (companyId: string): Promise<PasswordFolderRow[]> =>
    listPasswordFolders(companyId),
);

/**
 * One row of `/companies/:id/memberships`. Declared here so the Members
 * page and the client table it renders share a single definition —
 * previously the same shape was mirrored in both files.
 */
export type CompanyMembership = {
  id: string;
  role: MembershipRole;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    isActive: boolean;
    mfaEnabled: boolean;
  };
};

/**
 * `/companies/:id/memberships` — the active roster for one company.
 * Returns the raw `ServerApiResponse` (as `getCompanyDetail` does)
 * because the Members page renders an `ErrorBanner` on a failed read
 * rather than degrading to an empty table.
 */
export const getCompanyMemberships = cache(
  async (
    companyId: string,
  ): Promise<ServerApiResponse<CompanyMembership[]>> =>
    serverApiFetch<CompanyMembership[]>(`/companies/${companyId}/memberships`),
);

type CompanyLogo = {
  uploadId: string;
  url: string | null;
  thumbnailUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  uploadedAt: string;
};

export type CompanyParentRef = {
  id: string;
  name: string;
  slug: string;
  archivedAt: string | null;
};

export type CompanyListItem = {
  id: string;
  name: string;
  slug: string;
  notes: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  memberCount: number;
  type: CompanyType;
  city: string | null;
  region: string | null;
  country: string | null;
  website: string | null;
  logoUploadId: string | null;
  logo: CompanyLogo | null;
  // Phase 9b.3: per-caller flag so list rows can render the star state
  // without a second round-trip. Always present.
  isStarred: boolean;
};

export type CompanyPage = {
  items: CompanyListItem[];
  nextCursor: string | null;
};

export type CompanyDetail = CompanyListItem & {
  createdBy: string | null;
  quickNotes: string | null;
  parentCompanyId: string | null;
  parent: CompanyParentRef | null;
  childrenCount: number;
  contactName: string | null;
  contactTitle: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  generalEmail: string | null;
  phone: string | null;
  fax: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  stickyNoteText: string | null;
  stickyNoteSeverity: 'INFO' | 'WARN' | 'CRITICAL' | null;
};

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

// ───────────────────────────────────────────────────────────────────
// Security Center (Phase 12 — read-only first)
//
// All four reads are gated server-side by the `security.read` action,
// which maps to the `SECURITY_READ` platform capability. Session
// revocation lives at `DELETE /security/sessions/:id` and escalates
// to `user.manage`.
// ───────────────────────────────────────────────────────────────────

type LoginActivityBucket = {
  identifier: string;
  success: number;
  failure: number;
  lastSeen: string;
};

type LoginActivityRow = {
  id: string;
  action: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  actorId: string | null;
  actor: { id: string; name: string; email: string } | null;
  attemptedEmail: string | null;
};

export type LoginActivity = {
  windowHours: number;
  since: string;
  counts: { success: number; failure: number; mfaFailure: number };
  byIp: LoginActivityBucket[];
  byEmail: LoginActivityBucket[];
  recent: LoginActivityRow[];
};

type LockoutEntry = {
  identifier: string;
  failures: number;
  ttlSeconds: number | null;
  locked: boolean;
};

export type LockoutsResponse = {
  threshold: number;
  windowMinutes: number;
  ip: LockoutEntry[];
  email: LockoutEntry[];
};

export type ThrottleBlockEntry = {
  throttler: string;
  tracker: string;
  blockedUntil: string | null;
  remainingMs: number;
};

// WS-024 connection diagnostics — mirrors `ConnectionDiagnostics` in
// `apps/api/src/security/security.service.ts`. Fetched client-side (via
// `apiFetch`, not `serverApiFetch`) so the request travels the real
// browser → proxy → API path being diagnosed; see the Security Center
// client component. No server fetch helper here by design.
export type ConnectionDiagnostics = {
  resolvedIp: string;
  socketPeer: string;
  peerTrusted: boolean;
  forwardedForReceived: string | null;
  inboundForwardedFor: string;
  trustProxyHops: number;
  webTrustProxyHops: number | null;
  interpretation: string[];
};

export type SecuritySessionRow = {
  id: string;
  ip: string;
  userAgent: string;
  mfaPending: boolean;
  createdAt: string;
  expiresAt: string;
  user: {
    id: string;
    name: string;
    email: string;
    role: UserRole;
    mfaEnabled: boolean;
    mfaEnrolled: boolean;
    isActive: boolean;
  };
};

export async function getSecurityLoginActivity(
  windowHours = 24,
): Promise<LoginActivity | null> {
  const res = await serverApiFetch<LoginActivity>(
    `/security/login-activity?windowHours=${windowHours}`,
  );
  return res.ok ? res.data : null;
}

export async function getSecurityLockouts(): Promise<LockoutsResponse | null> {
  const res = await serverApiFetch<LockoutsResponse>('/security/lockouts');
  return res.ok ? res.data : null;
}

// Whether the enabled IP rules deny one address family entirely but leave
// the other to default-allow — see `GET /security/ip-rule-coverage` and
// `findCatchAllFamilyGap` in `@weavestream/shared`.
export type IpRuleCoverage = { gap: CatchAllFamilyGap | null };

export async function getSecurityIpRuleCoverage(): Promise<IpRuleCoverage | null> {
  const res = await serverApiFetch<IpRuleCoverage>('/security/ip-rule-coverage');
  return res.ok ? res.data : null;
}

export async function getSecurityThrottleBlocks(): Promise<
  ThrottleBlockEntry[] | null
> {
  const res = await serverApiFetch<ThrottleBlockEntry[]>(
    '/security/throttle-blocks',
  );
  return res.ok ? res.data : null;
}

export async function getSecuritySessions(): Promise<
  SecuritySessionRow[] | null
> {
  const res = await serverApiFetch<{ items: SecuritySessionRow[] }>(
    '/security/sessions?limit=200',
  );
  return res.ok ? (res.data?.items ?? []) : null;
}

export type EgressBlockRow = {
  id: string;
  createdAt: string;
  userAgent: string | null;
  url: string | null;
  hostname: string | null;
  resolvedIps: string[];
  reason: string | null;
  matchedCidr: string | null;
};

export type EgressBlocksResponse = {
  windowHours: number;
  since: string;
  total: number;
  recent: EgressBlockRow[];
};

export async function getSecurityEgressBlocks(
  windowHours = 168,
): Promise<EgressBlocksResponse | null> {
  const res = await serverApiFetch<EgressBlocksResponse>(
    `/security/egress-blocks?windowHours=${windowHours}`,
  );
  return res.ok ? res.data : null;
}

// ───────────────────────────────────────────────────────────────────
// Phase 3: asset layouts + assets
// ───────────────────────────────────────────────────────────────────

export type LayoutFieldSummary = {
  id: string;
  name: string;
  slug: string;
  fieldType: FieldType;
  position: number;
  isRequired: boolean;
  isUniquePerCompany: boolean;
  visibleToClients: boolean;
  isPrimary: boolean;
  showInTable: boolean;
  options: Record<string, unknown>;
  archivedAt: string | null;
};

export type LayoutSummary = {
  id: string;
  name: string;
  slug: string;
  icon: string;
  color: string;
  isActive: boolean;
  version: number;
  position: number;
  archivedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  fields: LayoutFieldSummary[];
};

export type LayoutStats = {
  fieldCount: number;
  assetCount: number;
  companyCount: number;
};

export async function listLayouts(params?: {
  q?: string;
  includeArchived?: boolean;
}): Promise<LayoutSummary[]> {
  const q = new URLSearchParams();
  if (params?.q) q.set('q', params.q);
  if (params?.includeArchived) q.set('includeArchived', 'true');
  const res = await serverApiFetch<{ items: LayoutSummary[] }>(
    `/layouts${q.toString() ? `?${q.toString()}` : ''}`,
  );
  // Throws on network failure / 5xx / 429 — an empty list here would
  // cascade into "layout not found" 404s on every layout-driven page.
  return unwrapApiResponse(res, '/layouts')?.items ?? [];
}

export async function getLayout(
  id: string,
  withStats = false,
): Promise<{ layout: LayoutSummary; stats?: LayoutStats } | null> {
  const res = await serverApiFetch<{ layout: LayoutSummary; stats?: LayoutStats }>(
    `/layouts/${id}${withStats ? '?stats=true' : ''}`,
  );
  if (!res.ok || !res.data) return null;
  return res.data;
}

type ActorRef = { id: string; name: string };

export type AssetSummary = {
  id: string;
  companyId: string;
  assetLayoutId: string;
  layoutName: string;
  layoutSlug: string;
  layoutIcon: string;
  layoutColor: string;
  name: string;
  externalId: string | null;
  externalSource: string | null;
  /**
   * Phase 11 — last time an integration successfully wrote to this
   * asset. Null for manually-created or untouched assets. Populated by
   * the API's `hydrateSyncMetadata` helper based on the matching
   * `IntegrationSyncRecord` row.
   */
  lastSyncedAt: string | null;
  /**
   * Layout-field ids that were last touched by the integration sync.
   * Used by the edit form to render a subtle "synced" indicator next
   * to fields the operator may want to leave alone (or knowingly
   * override). Empty for manual assets.
   */
  syncedFieldIds: string[];
  /**
   * Phase 11.2 — every IntegrationSyncRecord linked to this asset.
   * One asset can be claimed by several integrations at once (e.g.
   * Action1 endpoint + UniFi client representing the same machine);
   * the UI surfaces all of them rather than just the "primary" one
   * stored on `externalSource`. Empty array for manual assets.
   */
  syncSources: Array<{
    integrationId: string;
    integrationName: string;
    driver: string;
    resourceKey: string;
    lastSyncedAt: string;
  }>;
  provenance: IntegrationTargetProvenance[];
  archivedAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdByUser: ActorRef | null;
  updatedByUser: ActorRef | null;
  createdAt: string;
  updatedAt: string;
  fieldValues: Record<string, unknown>;
  fields: Array<{
    id: string;
    slug: string;
    name: string;
    fieldType: FieldType;
    isPrimary: boolean;
    visibleToClients: boolean;
    options: Record<string, unknown>;
  }>;
  /**
   * Server-resolved labels for ASSET_REFERENCE values, keyed by the
   * referenced asset id. The list + detail endpoints populate this with
   * a single batched lookup so tables and detail views can render the
   * target asset's name instead of a bare uuid. Missing entries = the
   * referent was hard-deleted or is out of scope.
   */
  references: Record<
    string,
    { id: string; name: string; archivedAt: string | null }
  >;
  /**
   * True if the signed-in user has starred this asset (detail only).
   */
  isStarred: boolean;
};

export type AssetPage = { items: AssetSummary[]; nextCursor: string | null };

export async function listAssets(
  companyId: string,
  params: {
    layoutId?: string;
    q?: string;
    includeArchived?: boolean;
    fieldFilters?: Record<string, string>;
    limit?: number;
    cursor?: string;
  } = {},
): Promise<AssetPage> {
  const q = new URLSearchParams();
  if (params.layoutId) q.set('layout', params.layoutId);
  if (params.q) q.set('q', params.q);
  if (params.includeArchived) q.set('includeArchived', 'true');
  if (params.limit) q.set('limit', String(params.limit));
  if (params.cursor) q.set('cursor', params.cursor);
  for (const [k, v] of Object.entries(params.fieldFilters ?? {})) {
    q.set(`field.${k}`, v);
  }
  const res = await serverApiFetch<AssetPage>(
    `/companies/${companyId}/assets${q.toString() ? `?${q.toString()}` : ''}`,
  );
  // Throws on network failure / 5xx / 429 — an empty page here would
  // render as "no assets" when the backend is actually broken.
  return (
    unwrapApiResponse(res, `/companies/${companyId}/assets`) ?? {
      items: [],
      nextCursor: null,
    }
  );
}

/**
 * `{ assetLayoutId -> count }` map of active assets in this company.
 * Missing ids should be read as zero. Used by the company-scoped
 * sidebar to decorate layout entries with live counts.
 */
export async function getAssetCountsByLayout(
  companyId: string,
): Promise<Record<string, number>> {
  const res = await serverApiFetch<Record<string, number>>(
    `/companies/${companyId}/assets/counts-by-layout`,
  );
  return res.data ?? {};
}

/**
 * `/companies/:companyId/assets/:id` — shared by an asset detail page and
 * its separately streamed `generateMetadata` call. Request-scoped
 * memoization is important here: two independent reads can consume two
 * throttle slots and, if metadata alone is rate-limited, leave the page
 * rendered with the parent company's fallback title until a later refresh.
 * Primitive arguments keep React's identity-keyed cache deterministic.
 */
export const getAsset = cache(
  async (companyId: string, id: string): Promise<AssetSummary | null> => {
    const path = `/companies/${companyId}/assets/${id}`;
    const res = await serverApiFetch<AssetSummary>(path);
    return unwrapApiResponse(res, path);
  },
);

// ───────────────────────────────────────────────────────────────────
// Phase 4: folders, articles, uploads
// ───────────────────────────────────────────────────────────────────

export async function listFolderTree(
  companyId: string,
): Promise<FolderNode[]> {
  const res = await serverApiFetch<{ items: FolderNode[] }>(
    `/companies/${companyId}/folders/tree`,
  );
  return res.data?.items ?? [];
}

// The shared detail omits `provenance` on purpose (see `articleDetailSchema`);
// the web reader renders it, so the web type adds it back.
export type ArticleDetail = SharedArticleDetail & {
  provenance: IntegrationTargetProvenance[];
};

export type ArticlePage = { items: ArticleSummary[]; nextCursor: string | null };

export async function listArticles(
  companyId: string,
  params: {
    folderId?: string | null;
    q?: string;
    includeArchived?: boolean;
    visibleToClientsOnly?: boolean;
    limit?: number;
    cursor?: string;
  } = {},
): Promise<ArticlePage> {
  const q = new URLSearchParams();
  if (params.folderId !== undefined)
    q.set('folderId', params.folderId === null ? 'root' : params.folderId);
  if (params.q) q.set('q', params.q);
  if (params.includeArchived) q.set('includeArchived', 'true');
  if (params.visibleToClientsOnly) q.set('visibleToClientsOnly', 'true');
  if (params.limit) q.set('limit', String(params.limit));
  if (params.cursor) q.set('cursor', params.cursor);
  const res = await serverApiFetch<ArticlePage>(
    `/companies/${companyId}/articles${q.toString() ? `?${q.toString()}` : ''}`,
  );
  return res.data ?? { items: [], nextCursor: null };
}

/**
 * Every article in a scope, by following the API's cursor until it runs
 * out.
 *
 * The admin browser filters titles as you type and counts its folder
 * rail off the same rows, which is only honest if it holds the whole
 * list — a page-at-a-time list would filter whichever page you happened
 * to land on. A page is cheap here: the article list projection is
 * metadata-only, so no bodies cross the wire.
 *
 * The ceiling is set high enough that reaching it is not a realistic
 * knowledge base, because the failure past it is quiet: the cut runs by
 * `(archivedAt, title, id)` across the whole company, so a folder whose
 * articles all sort past it reads 0 and looks empty rather than short.
 * Its cost is paid only by the companies that need the pages — a
 * 300-article company still makes two requests. `truncated` reports that
 * the ceiling stopped us rather than the data running out, so the caller
 * can say so instead of presenting a slice as the total.
 */
export async function listAllArticles(
  companyId: string,
  params: { folderId?: string | null; includeArchived?: boolean } = {},
): Promise<{ items: ArticleSummary[]; truncated: boolean }> {
  /** The API's own per-request ceiling; asking for more is clamped. */
  const PAGE_SIZE = 200;
  /** 50 x 200 = 10,000 articles in one company, then `truncated`. */
  const MAX_PAGES = 50;
  const items: ArticleSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await listArticles(companyId, {
      ...params,
      limit: PAGE_SIZE,
      cursor,
    });
    items.push(...res.items);
    if (!res.nextCursor) return { items, truncated: false };
    cursor = res.nextCursor;
  }
  return { items, truncated: true };
}

export async function getArticle(
  companyId: string,
  id: string,
): Promise<ArticleDetail | null> {
  const res = await serverApiFetch<ArticleDetail>(
    `/companies/${companyId}/articles/${id}`,
  );
  if (!res.ok || !res.data) return null;
  return res.data;
}

export async function getArticleBySlug(
  companyId: string,
  slug: string,
): Promise<ArticleDetail | null> {
  const res = await serverApiFetch<ArticleDetail>(
    `/companies/${companyId}/articles/by-slug/${encodeURIComponent(slug)}`,
  );
  if (!res.ok || !res.data) return null;
  return res.data;
}


type ArticleLinkState = 'live' | 'versioned' | 'archived' | 'orphan';

export type UploadSummary = {
  id: string;
  companyId: string;
  uploaderId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
  width: number | null;
  height: number | null;
  attachedToType: string | null;
  attachedToId: string | null;
  createdAt: string;
  thumbnailUrl: string | null;
  downloadUrl: string | null;
  /**
   * Article that embeds this upload, resolved server-side by scanning
   * article bodies. Populated only for `attachedToType === 'article'`
   * uploads — those rows store no `attachedToId` so the photos gallery
   * needs this to build a "back to article" link. Non-null for `live`,
   * `versioned`, and `archived` link states (archived still carries an
   * id+slug+title so the UI can deep-link to the archived detail page).
   */
  sourceArticle: { id: string; slug: string; title: string } | null;
  /**
   * Link state for article-attached uploads:
   *   live      — in the live body of a non-archived article
   *   versioned — only in a non-draft `ArticleVersion` of a live article
   *   archived  — only reachable through an archived article
   *   orphan    — not referenced anywhere
   * `null` for non-article uploads.
   */
  articleLinkState: ArticleLinkState | null;
};

// ---------------------------------------------------------------------
// Phase 8: monitored domains
// ---------------------------------------------------------------------

type DomainStatus = 'OK' | 'EXPIRING' | 'EXPIRED' | 'FAIL' | 'UNKNOWN';

export type MonitoredDomain = {
  id: string;
  companyId: string;
  hostname: string;
  checkWhois: boolean;
  checkDns: boolean;
  checkTls: boolean;
  alertThresholdDays: number;
  visibleToClients: boolean;
  lastCheckedAt: string | null;
  whoisExpiresAt: string | null;
  tlsExpiresAt: string | null;
  latestStatus: DomainStatus;
  /** v2 — latest hygiene score (percentage 0-100). NULL if never scored. */
  latestScore: number | null;
  /** v2 — operator-supplied DKIM selectors (CSV). */
  dkimSelectorOverride: string | null;
  archivedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DomainCheck = {
  id: string;
  monitoredDomainId: string;
  companyId: string;
  checkedAt: string;
  whoisStatus: 'OK' | 'WARN' | 'FAIL' | 'SKIP' | null;
  dnsStatus: 'OK' | 'WARN' | 'FAIL' | 'SKIP' | null;
  tlsStatus: 'OK' | 'WARN' | 'FAIL' | 'SKIP' | null;
  whoisExpiresAt: string | null;
  tlsExpiresAt: string | null;
  details: DomainCheckDetails;
  error: string | null;
  /** v2 — denormalised percent score. NULL for legacy rows. */
  score: number | null;
  /** v2 — rubric version this row was scored under. */
  schemaVersion: number | null;
};

export type DomainAlert = {
  companyId: string;
  companyName: string;
  companySlug: string;
  domainId: string;
  hostname: string;
  status: DomainStatus;
  visibleToClients: boolean;
  whoisExpiresAt: string | null;
  tlsExpiresAt: string | null;
  /** v2 — latest hygiene score (percent). NULL when never scored. */
  latestScore: number | null;
};

export async function listDomains(
  companyId: string,
  params: {
    q?: string;
    status?: DomainStatus;
    includeArchived?: boolean;
    limit?: number;
    cursor?: string;
  } = {},
): Promise<{ items: MonitoredDomain[]; nextCursor: string | null }> {
  const q = new URLSearchParams();
  if (params.q) q.set('q', params.q);
  if (params.status) q.set('status', params.status);
  if (params.includeArchived) q.set('includeArchived', 'true');
  if (params.limit) q.set('limit', String(params.limit));
  if (params.cursor) q.set('cursor', params.cursor);
  const res = await serverApiFetch<{
    items: MonitoredDomain[];
    nextCursor: string | null;
  }>(
    `/companies/${companyId}/domains${q.toString() ? `?${q.toString()}` : ''}`,
  );
  return res.data ?? { items: [], nextCursor: null };
}

export async function getDomain(
  companyId: string,
  id: string,
): Promise<MonitoredDomain | null> {
  const res = await serverApiFetch<MonitoredDomain>(
    `/companies/${companyId}/domains/${id}`,
  );
  if (!res.ok || !res.data) return null;
  return res.data;
}

export async function listDomainChecks(
  companyId: string,
  id: string,
  limit = 30,
): Promise<DomainCheck[]> {
  const res = await serverApiFetch<DomainCheck[]>(
    `/companies/${companyId}/domains/${id}/checks?limit=${limit}`,
  );
  return res.data ?? [];
}

export async function listDomainAlerts(
  limit = 50,
): Promise<DomainAlert[]> {
  const res = await serverApiFetch<{ items: DomainAlert[] }>(
    `/domains/alerts?limit=${limit}`,
  );
  return res.data?.items ?? [];
}

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

// ---------------------------------------------------------------------
// Passwords (Phase 10 — vault)
// ---------------------------------------------------------------------

export type PasswordDetail = PasswordSummary & {
  notes: unknown | null;
  totpAlgorithm: 'SHA1' | 'SHA256' | 'SHA512';
  totpDigits: number;
  totpPeriod: number;
  /**
   * True if the signed-in user has starred this password.
   */
  isStarred: boolean;
};

export type PasswordFolderRow = {
  id: string;
  companyId: string;
  parentId: string | null;
  name: string;
  icon: string | null;
  color: string | null;
  position: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PasswordVersionRow = {
  version: number;
  changedFields: string[];
  changedBy: string;
  changedByName: string | null;
  changeReason: string | null;
  createdAt: string;
};

export type PasswordAccessUser = {
  id: string;
  name: string;
  email: string;
  role: 'SUPER_ADMIN' | 'OPERATOR' | 'CONTRACTOR';
  accessSource: 'super_admin' | 'membership' | 'global';
  alwaysIncluded: boolean;
};

export async function listPasswords(
  companyId: string,
  params: {
    q?: string;
    folderId?: string;
    assetId?: string;
    tag?: string;
    archived?: boolean;
    stale?: boolean;
  } = {},
): Promise<PasswordSummary[]> {
  const q = new URLSearchParams();
  if (params.q) q.set('q', params.q);
  if (params.folderId) q.set('folderId', params.folderId);
  if (params.assetId) q.set('assetId', params.assetId);
  if (params.tag) q.set('tag', params.tag);
  if (params.archived) q.set('archived', 'true');
  if (params.stale) q.set('stale', 'true');
  const res = await serverApiFetch<{ items: PasswordSummary[] }>(
    `/companies/${companyId}/passwords${q.toString() ? `?${q.toString()}` : ''}`,
  );
  return res.data?.items ?? [];
}

/**
 * Status-aware password-detail fetch. `getPasswordDetail` collapses
 * every failure to `null`, which forces a page into `notFound()` even
 * when the API said 403 ("restricted to specific internal users"). The
 * admin detail page needs to tell 403 apart from a genuine 404 so it can
 * render a "you don't have access" state instead of a bare not-found.
 *
 * Only the HTTP status is surfaced here — callers should branch **only**
 * on `403`. Every other non-OK status (404, 429, 503, network failure)
 * yields `data: null`, matching `getPasswordDetail`'s existing fallback
 * so 429/503 keep rendering as the 404 page rather than a misleading
 * "no access" screen. (Intentionally not routed through
 * `throwUnlessFound`, which has bespoke 429/network semantics.)
 */
export async function getPasswordDetailResult(
  companyId: string,
  id: string,
): Promise<{ status: number; data: PasswordDetail | null }> {
  const res = await serverApiFetch<PasswordDetail>(
    `/companies/${companyId}/passwords/${id}`,
  );
  return { status: res.status, data: res.ok ? res.data : null };
}

export async function getPasswordDetail(
  companyId: string,
  id: string,
): Promise<PasswordDetail | null> {
  const { data } = await getPasswordDetailResult(companyId, id);
  return data;
}

export async function listPasswordFolders(
  companyId: string,
): Promise<PasswordFolderRow[]> {
  const res = await serverApiFetch<{ items: PasswordFolderRow[] }>(
    `/companies/${companyId}/password-folders`,
  );
  return res.data?.items ?? [];
}

export async function listPasswordVersions(
  companyId: string,
  id: string,
): Promise<PasswordVersionRow[]> {
  const res = await serverApiFetch<{ items: PasswordVersionRow[] }>(
    `/companies/${companyId}/passwords/${id}/versions`,
  );
  return res.data?.items ?? [];
}

// ---------------------------------------------------------------------
// IPAM — company-scoped subnet registry + reservations
// ---------------------------------------------------------------------

export type SubnetOccupant = {
  ip: string;
  assetId: string;
  assetName: string;
  assetLayoutId: string;
  assetLayoutName: string;
  assetLayoutColor: string;
  assetLayoutIcon: string;
  assetFieldId: string;
  fieldName: string;
};

type SubnetUtilization = {
  totalUsable: number;
  claimed: number;
  free: number;
  conflictCount: number;
};

export type SubnetRow = {
  id: string;
  companyId: string;
  name: string;
  cidr: string;
  prefix: number;
  vlanId: number | null;
  gateway: string | null;
  dhcpRangeStart: string | null;
  dhcpRangeEnd: string | null;
  description: string | null;
  archivedAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  utilization: SubnetUtilization;
  conflictCount: number;
};

export type IpReservationRow = {
  id: string;
  companyId: string;
  subnetId: string;
  ipAddress: string;
  label: string;
  notes: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SubnetDetail = {
  subnet: SubnetRow;
  utilization: SubnetUtilization;
  occupants: SubnetOccupant[];
  reservations: IpReservationRow[];
  conflicts: Array<{ ip: string; entries: SubnetOccupant[] }>;
  provenance: IntegrationTargetProvenance[];
};

export async function listSubnets(
  companyId: string,
  params: { q?: string; includeArchived?: boolean } = {},
): Promise<SubnetRow[]> {
  const q = new URLSearchParams();
  if (params.q) q.set('q', params.q);
  if (params.includeArchived) q.set('includeArchived', 'true');
  const res = await serverApiFetch<SubnetRow[]>(
    `/companies/${companyId}/ipam/subnets${q.toString() ? `?${q.toString()}` : ''}`,
  );
  return res.data ?? [];
}

export const getCompanySubnetsBasic = cache(
  async (companyId: string): Promise<SubnetRow[]> =>
    listSubnets(companyId),
);

export async function getSubnetDetail(
  companyId: string,
  id: string,
): Promise<SubnetDetail | null> {
  const res = await serverApiFetch<SubnetDetail>(
    `/companies/${companyId}/ipam/subnets/${id}`,
  );
  return unwrapApiResponse(res, `/companies/${companyId}/ipam/subnets/${id}`);
}

export async function listPhotos(
  companyId: string,
  params: {
    attachedToType?: string;
    attachedToId?: string;
    limit?: number;
    cursor?: string;
    includeNonLatest?: boolean;
  } = {},
): Promise<{ items: UploadSummary[]; nextCursor: string | null }> {
  const q = new URLSearchParams();
  if (params.attachedToType) q.set('attachedToType', params.attachedToType);
  if (params.attachedToId) q.set('attachedToId', params.attachedToId);
  if (params.limit) q.set('limit', String(params.limit));
  if (params.cursor) q.set('cursor', params.cursor);
  if (params.includeNonLatest) q.set('includeNonLatest', '1');
  const res = await serverApiFetch<{
    items: UploadSummary[];
    nextCursor: string | null;
  }>(`/companies/${companyId}/photos${q.toString() ? `?${q.toString()}` : ''}`);
  return res.data ?? { items: [], nextCursor: null };
}

// ---------------------------------------------------------------------
// Phase 5: IP allow/deny rules (global, enforced before auth)
// ---------------------------------------------------------------------

export async function listIpRules(): Promise<IpRule[]> {
  const res = await serverApiFetch<{ items: IpRule[] }>('/ip-rules');
  return res.data?.items ?? [];
}

// ───────────────────────────────────────────────────────────────────
// Backups admin (`/admin/backups`)
//
// Server-rendered first paint loads schedules and recent runs. The
// client component then refreshes via `apiFetch` after mutations and
// while polling a "Run now" attempt to terminal status.
// ───────────────────────────────────────────────────────────────────

export async function listBackupConfigs(): Promise<BackupConfig[]> {
  const res = await serverApiFetch<BackupConfig[]>('/backups/configs');
  if (!res.ok || !res.data) return [];
  return res.data;
}

export async function listBackupRuns(): Promise<BackupRunDto[]> {
  const res = await serverApiFetch<BackupRunDto[]>('/backups/runs?limit=50');
  if (!res.ok || !res.data) return [];
  return res.data;
}

// ───────────────────────────────────────────────────────────────────
// Phase 12+: global admin ticket browse (read-only)
//
// Tickets live in the upstream system (NinjaOne today); these helpers
// only proxy the API. The "capability" probe is used by the admin
// shell to gate the sidebar entry without disclosing the underlying
// mapping/driver identity. Both routes are gated by
// `tickets.read.global` on the API.
// ───────────────────────────────────────────────────────────────────

export type TicketListItem = import('@weavestream/shared').TicketListDto;
export type TicketDetail = import('@weavestream/shared').TicketDetailDto;
export type TicketActivity = import('@weavestream/shared').TicketActivityDto;
type TicketListPage = import('@weavestream/shared').TicketListResponse;
export type TicketListFilters =
  import('@weavestream/shared').TicketListFilter;

export const hasAnyTicketingIntegration = cache(async (): Promise<boolean> => {
  const res = await serverApiFetch<{ enabled: boolean }>(`/tickets/_capability`);
  return res.ok && res.data?.enabled === true;
});

export async function listTickets(
  params: TicketListFilters & { cursor?: string | null } = {},
): Promise<TicketListPage> {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.priority) q.set('priority', params.priority);
  if (params.boardId) q.set('boardId', params.boardId);
  if (params.search) q.set('search', params.search);
  if (params.cursor) q.set('cursor', params.cursor);
  const path = `/tickets${q.toString() ? `?${q.toString()}` : ''}`;
  const res = await serverApiFetch<TicketListPage>(path);
  if (!res.ok || !res.data) return { records: [], cursor: null };
  return res.data;
}

export async function getTicket(
  ticketId: string,
): Promise<TicketDetail | null> {
  const res = await serverApiFetch<TicketDetail>(
    `/tickets/${encodeURIComponent(ticketId)}`,
  );
  if (!res.ok || !res.data) return null;
  return res.data;
}
