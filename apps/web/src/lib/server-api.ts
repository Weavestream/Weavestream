import { cache } from 'react';
import { cookies } from 'next/headers';
import type {
  FieldType,
  MembershipRole,
  UserRole,
  UserSearchDefaults,
  UserUiPreferences,
} from '@weavestream/shared';

export type {
  FieldType,
  MembershipRole,
  UserRole,
  UserSearchDefaults,
  UserUiPreferences,
};

/**
 * Internal base URL for the API from inside Next.js (docker service name in
 * production, localhost in local dev). Never expose this to the browser —
 * the browser always goes through the `/api/v1` reverse proxy.
 */
export const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://api:4000';

/**
 * Thrown by `getMe`, `getSettings`, and any other server helper that would
 * otherwise silently return a fallback when the API is genuinely
 * unreachable (ECONNREFUSED, dropped socket, etc.). Callers — especially
 * those using non-null assertions like `(await getMe())!` — need this to
 * surface as an exception so the nearest `error.tsx` boundary can render
 * a dedicated "backend unavailable" page instead of a random
 * `TypeError: Cannot read properties of null` deep inside the component tree.
 */
export class ApiUnavailableError extends Error {
  readonly path: string;
  readonly method: string;
  override readonly cause?: unknown;
  constructor(path: string, method: string, message: string, cause?: unknown) {
    super(`API unavailable — ${method} ${path}: ${message}`);
    this.name = 'ApiUnavailableError';
    this.path = path;
    this.method = method;
    this.cause = cause;
  }
}

/**
 * Recognizes the handful of Node `fetch` / undici errors that indicate the
 * API container simply isn't reachable yet (or was just restarted). These
 * are transient during `pnpm dev` cold-boot: tsc-watch finishes building
 * `apps/web` a second or two before `apps/api` binds its port, so the
 * first SSR request after a restart hits `ECONNREFUSED`.
 */
function isTransientNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const cause = (err as { cause?: unknown }).cause as
    | { code?: string; errors?: Array<{ code?: string }> }
    | undefined;
  const code = cause?.code ?? cause?.errors?.[0]?.code;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_SOCKET' ||
    (err as Error).name === 'AbortError'
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ServerApiResponse<T> = {
  ok: boolean;
  status: number;
  data: T | null;
  problem?: unknown;
  /**
   * True when `ok === false` and the failure was a network-level error
   * (API container not reachable), as opposed to an HTTP-level error the
   * API actually responded to (4xx/5xx). Callers that degrade gracefully
   * for 401/404 but need to hard-fail on a down backend branch on this.
   */
  networkError?: boolean;
};

export async function serverApiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<ServerApiResponse<T>> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const headers = new Headers(init.headers);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  if (cookieHeader) headers.set('cookie', cookieHeader);

  // Retry schedule tuned to ride out a typical `pnpm dev` cold boot, where
  // the web server starts serving requests ~3-5s before `apps/api` binds
  // its port. Total budget ~5.3s (200 + 400 + 800 + 1500 + 2400 ms) across
  // 6 attempts. In production this only kicks in during genuine outages,
  // and we'd rather the first request take a few seconds than 500 the page.
  // Only safe methods retry — never re-fire a mutation.
  const method = (init.method ?? 'GET').toUpperCase();
  const isSafeMethod = method === 'GET' || method === 'HEAD';
  const backoffMs = isSafeMethod ? [0, 200, 400, 800, 1500, 2400] : [0];
  const maxAttempts = backoffMs.length;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(backoffMs[attempt] ?? 2400);
    try {
      const res = await fetch(`${API_INTERNAL_URL}/api/v1${path}`, {
        ...init,
        headers,
        cache: 'no-store',
      });
      const contentType = res.headers.get('content-type') ?? '';
      let data: T | null = null;
      let problem: unknown;
      if (contentType.includes('problem+json')) {
        problem = await res.json().catch(() => null);
      } else if (contentType.includes('json')) {
        data = (await res.json().catch(() => null)) as T | null;
      }
      return { ok: res.ok, status: res.status, data, problem };
    } catch (err) {
      lastError = err;
      if (!isTransientNetworkError(err) || attempt === maxAttempts - 1) break;
    }
  }

  // All retries exhausted (or a non-retryable error). Log once so real
  // outages stay visible, and return a synthetic failure flagged with
  // `networkError: true` so hard-fail callers (getMe, getSettings) can
  // distinguish "API is down" from "API returned 401/404".
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  console.warn(
    `[server-api] ${method} ${path} failed after ${maxAttempts} attempt(s): ${message}`,
  );
  return {
    ok: false,
    status: 503,
    data: null,
    networkError: true,
    problem: {
      type: 'about:blank',
      title: 'API unreachable',
      status: 503,
      detail: message,
      networkError: true,
    },
  };
}

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
// Returns `null` for BOTH genuine 401s and network-level failures. Every
// auth-gated layout (`admin/layout.tsx`, `portal/[companySlug]/layout.tsx`,
// etc.) redirects to `/login` on null, which is the right UX for both
// cases: if the user isn't signed in they need to log in, and if the
// backend is temporarily unreachable, bouncing through `/login` gives
// the extended retry loop in `serverApiFetch` (~5s budget) another
// chance to connect before the user sees anything broken.
export const getMe = cache(async (): Promise<Me | null> => {
  const res = await serverApiFetch<Me>('/me');
  if (!res.ok || !res.data) return null;
  return res.data;
});

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
  updatedAt: string;
};

/**
 * Hard-coded defaults shipped with the product. Used when the API is
 * unreachable during SSR (first-paint on cold boot, or when running the
 * unauthenticated /login page). Must match the migration seed defaults
 * in packages/db/prisma/migrations/0006_phase5_system_settings.
 */
export const DEFAULT_SETTINGS: Settings = {
  workspaceName: 'My Company',
  workspaceSubtitle: 'workspace',
  tenantTermSingular: 'Company',
  tenantTermPlural: 'Companies',
  tenantTermPossessive: null,
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

export type CompanyType =
  | 'CLIENT'
  | 'PROSPECT'
  | 'VENDOR'
  | 'INTERNAL'
  | 'PARTNER'
  | 'OTHER';

export type CompanyLogo = {
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
};

export type UserListItem = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
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

export type MembershipListItem = {
  id: string;
  userId: string;
  companyId: string;
  role: MembershipRole;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
  user: { id: string; name: string; email: string; role: UserRole };
  company: { id: string; name: string; slug: string; archivedAt: string | null };
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

export type AuditPage = { items: AuditEntry[]; nextCursor: string | null };

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
  return res.data?.items ?? [];
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
  archivedAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
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
  return res.data ?? { items: [], nextCursor: null };
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

export async function getAsset(
  companyId: string,
  id: string,
): Promise<AssetSummary | null> {
  const res = await serverApiFetch<AssetSummary>(
    `/companies/${companyId}/assets/${id}`,
  );
  if (!res.ok || !res.data) return null;
  return res.data;
}

// ───────────────────────────────────────────────────────────────────
// Phase 4: folders, articles, uploads
// ───────────────────────────────────────────────────────────────────

export type FolderNode = {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  position: number;
  parentId: string | null;
  archivedAt: string | null;
  children: FolderNode[];
};

export async function listFolderTree(
  companyId: string,
): Promise<FolderNode[]> {
  const res = await serverApiFetch<{ items: FolderNode[] }>(
    `/companies/${companyId}/folders/tree`,
  );
  return res.data?.items ?? [];
}

export type ArticleSummary = {
  id: string;
  companyId: string;
  folderId: string | null;
  title: string;
  slug: string;
  excerpt: string | null;
  visibleToClients: boolean;
  archivedAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ArticleDetail = ArticleSummary & {
  content: unknown;
  contentPlaintext: string;
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
    role: UserRole;
    isActive: boolean;
    mfaEnabled: boolean;
  };
};

/**
 * List active memberships for a company. The endpoint requires the
 * `membership.manage` permission — callers that don't hold it (e.g. a
 * TECH-role user reading an article) will get a 403 back, in which case
 * we return an empty array so the page can fall back to rendering raw
 * user IDs or skipping the authors card entirely.
 */
export async function listCompanyMemberships(
  companyId: string,
): Promise<CompanyMembership[]> {
  const res = await serverApiFetch<CompanyMembership[]>(
    `/companies/${companyId}/memberships`,
  );
  if (!res.ok || !res.data) return [];
  return res.data;
}

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
};

// ---------------------------------------------------------------------
// Phase 8: monitored domains
// ---------------------------------------------------------------------

export type DomainStatus = 'OK' | 'EXPIRING' | 'EXPIRED' | 'FAIL' | 'UNKNOWN';

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
  details: Record<string, unknown>;
  error: string | null;
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

export type StarredCompany = {
  id: string;
  name: string;
  slug: string;
  archivedAt: string | null;
  updatedAt: string;
  type: CompanyType;
  city: string | null;
  region: string | null;
  country: string | null;
  website: string | null;
  memberCount: number;
  starredAt: string;
  logo: CompanyLogo | null;
};

export async function listStarredCompanies(): Promise<StarredCompany[]> {
  const res = await serverApiFetch<{ items: StarredCompany[] }>('/me/stars');
  return res.data?.items ?? [];
}

export type RecentActivityItem = {
  type: 'asset' | 'article';
  id: string;
  name: string;
  companyId: string;
  companyName: string;
  companySlug: string;
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

export async function listPhotos(
  companyId: string,
  params: {
    attachedToType?: string;
    attachedToId?: string;
    limit?: number;
    cursor?: string;
  } = {},
): Promise<{ items: UploadSummary[]; nextCursor: string | null }> {
  const q = new URLSearchParams();
  if (params.attachedToType) q.set('attachedToType', params.attachedToType);
  if (params.attachedToId) q.set('attachedToId', params.attachedToId);
  if (params.limit) q.set('limit', String(params.limit));
  if (params.cursor) q.set('cursor', params.cursor);
  const res = await serverApiFetch<{
    items: UploadSummary[];
    nextCursor: string | null;
  }>(`/companies/${companyId}/photos${q.toString() ? `?${q.toString()}` : ''}`);
  return res.data ?? { items: [], nextCursor: null };
}

