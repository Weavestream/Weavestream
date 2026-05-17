import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { notFound } from 'next/navigation';
import type {
  AiSettings,
  AlertConfig,
  ArticleEditorMode,
  BackupConfig,
  BackupRunDto,
  FieldType,
  GlobalAccess,
  EmailSettings,
  MembershipRole,
  PasswordGeneratorDefaults,
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
  BackupConfig,
  BackupRunDto,
  FieldType,
  GlobalAccess,
  EmailSettings,
  MembershipRole,
  PasswordGeneratorDefaults,
  PlatformCapability,
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
 * Thrown when a server component's read hits the API-level rate
 * limiter (HTTP 429). Separated from generic 4xx / 5xx failures so
 * the nearest `error.tsx` boundary can render a dedicated "please
 * slow down" banner instead of the misleading 404 the old "return
 * `notFound()` on any non-OK" pattern used to produce.
 *
 * `retryAfterSeconds` is the honoured cooldown — the server-side
 * throttler returns it in the `retry-after` header (per-bucket) and
 * in a `retry-after-global` header for the app-wide limit; we pick
 * the larger of the two so the UI countdown actually matches what
 * the next request will see.
 */
/**
 * Magic prefix on `error.digest` that the top-level `error.tsx`
 * client boundary matches against to render a retry banner instead of
 * the generic "Something went wrong" page. We encode the retry
 * cooldown into the digest because Next.js App Router only forwards
 * `message` and `digest` across the RSC → client boundary in
 * production (everything else on the `Error` instance is stripped as
 * sensitive), so digest is the only channel for out-of-band state.
 * Keep the format in sync with `app/error.tsx`'s parser.
 */
export const RATE_LIMIT_DIGEST_PREFIX = 'WS_RATE_LIMITED:';

export class RateLimitedError extends Error {
  readonly path: string;
  readonly method: string;
  readonly retryAfterSeconds: number;
  /** Read by Next's error boundary; see `RATE_LIMIT_DIGEST_PREFIX`. */
  readonly digest: string;
  constructor(
    path: string,
    method: string,
    retryAfterSeconds: number,
    message = 'Rate limited',
  ) {
    super(`${message} — ${method} ${path} (retry in ${retryAfterSeconds}s)`);
    this.name = 'RateLimitedError';
    this.path = path;
    this.method = method;
    this.retryAfterSeconds = retryAfterSeconds;
    this.digest = `${RATE_LIMIT_DIGEST_PREFIX}${retryAfterSeconds}`;
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

/**
 * Parse an HTTP `Retry-After` / `retry-after-global` header value.
 * Throttler emits raw seconds (e.g. `"59841"` ms from `@nestjs/throttler`'s
 * debug variant, or `"60"` from the standard one) so we only need to
 * handle the numeric form — HTTP-date variants are not produced by our
 * stack. Returns seconds ≥ 0 or `undefined` when the header is absent
 * or unparseable.
 */
function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  // `@nestjs/throttler` emits milliseconds on the global header in some
  // versions (5-digit values > 1000 are implausible as seconds — that's
  // >16 minutes). If the value looks like a millisecond count convert it.
  if (n > 1000) return Math.ceil(n / 1000);
  return n;
}

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
  /**
   * Honoured cooldown in seconds when `status === 429`, derived from
   * the `retry-after` and `retry-after-global` response headers
   * (`@nestjs/throttler` emits both). Always ≥ 1 when present so the
   * countdown UI never renders "retry in 0s". `undefined` for every
   * non-429 response.
   */
  retryAfterSeconds?: number;
};

/**
 * Canonical helper for "I expect a resource, show the right error
 * otherwise" branches in RSC pages. Call it with a `ServerApiResponse`
 * that should have a non-null `data` and it:
 *
 *   - returns the unwrapped `data` when the call succeeded,
 *   - renders the Next.js 404 page for genuine `404` and other client-
 *     meaningful not-found states (no `data` on a 2xx),
 *   - throws `RateLimitedError` on HTTP 429 so the nearest `error.tsx`
 *     boundary can render a cool-down banner (the old pattern masked
 *     these as 404s, which is why the Docker debug chase was so
 *     confusing),
 *   - throws `ApiUnavailableError` on network-level failures so the
 *     same boundary can render "backend unreachable" instead of a
 *     misleading empty page.
 *
 * Authentication (401) is intentionally left to the outer layout
 * guards: by the time an inner page calls this helper, those have
 * already redirected to `/login` on null `me`, so a 401 here almost
 * always means "session dropped mid-render" and mapping it to
 * `notFound()` is fine.
 */
export function throwUnlessFound<T>(
  res: ServerApiResponse<T>,
  path: string,
): T {
  if (res.ok && res.data != null) return res.data;
  if (res.status === 429) {
    // We let Next's error boundary render this — matches the UX
    // pattern we use for `ApiUnavailableError` today.
    throw new RateLimitedError(
      path,
      'GET',
      res.retryAfterSeconds ?? 30,
      extractProblemTitle(res.problem) ?? 'Rate limited',
    );
  }
  if (res.networkError) {
    throw new ApiUnavailableError(
      path,
      'GET',
      extractProblemDetail(res.problem) ?? `HTTP ${res.status}`,
    );
  }
  // Anything else — 404, 403, a 2xx with an empty body — is rendered
  // as the Next.js 404 page. `notFound()` throws a tagged error that
  // Next's router uses to render `not-found.tsx`.
  notFound();
}

function extractProblemTitle(problem: unknown): string | undefined {
  if (problem && typeof problem === 'object' && 'title' in problem) {
    const t = (problem as { title?: unknown }).title;
    if (typeof t === 'string' && t.length > 0) return t;
  }
  return undefined;
}

function extractProblemDetail(problem: unknown): string | undefined {
  if (problem && typeof problem === 'object' && 'detail' in problem) {
    const d = (problem as { detail?: unknown }).detail;
    if (typeof d === 'string' && d.length > 0) return d;
  }
  return undefined;
}

export async function serverApiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<ServerApiResponse<T>> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const outgoing = new Headers(init.headers);
  if (!outgoing.has('Accept')) outgoing.set('Accept', 'application/json');
  if (cookieHeader) outgoing.set('cookie', cookieHeader);

  // Forward the browser's identifying headers to the API so Express's
  // `req.ip` reflects the real client rather than the `web` container's
  // internal bridge address. Needed for correct per-IP throttling, audit
  // logs, and any future IP-based policy. `app.set('trust proxy', 1)` on
  // the API is the other half of this fix — it tells Express to honour
  // these headers.
  //
  // We append rather than replace so chained proxies (e.g. Traefik →
  // web → api) don't lose upstream hops. `headers()` throws outside a
  // request scope (scripts / build), which we catch and ignore.
  try {
    const incoming = await headers();
    const clientXff = incoming.get('x-forwarded-for');
    const remoteIp = incoming.get('x-real-ip');
    if (clientXff) {
      outgoing.set('x-forwarded-for', clientXff);
    } else if (remoteIp) {
      outgoing.set('x-forwarded-for', remoteIp);
    }
    const proto = incoming.get('x-forwarded-proto');
    if (proto) outgoing.set('x-forwarded-proto', proto);
    const host = incoming.get('x-forwarded-host') ?? incoming.get('host');
    if (host) outgoing.set('x-forwarded-host', host);
  } catch {
    // outside of a request context — nothing to forward
  }

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
        headers: outgoing,
        cache: 'no-store',
      });
      const contentType = res.headers.get('content-type') ?? '';
      let data: T | null = null;
      let problem: unknown;
      if (contentType.includes('problem+json')) {
        problem = await res.json().catch(() => null);
      } else if (contentType.includes('json')) {
        // Successful responses carry the resource payload in the body.
        // Non-OK responses with a plain `application/json` body (the
        // NestJS default exception filter, not RFC7807) still contain
        // useful context — surface it as `problem` instead of pinning
        // it on `data`, where call-sites would try to type-cast it.
        if (res.ok) {
          data = (await res.json().catch(() => null)) as T | null;
        } else {
          problem = await res.json().catch(() => null);
        }
      }
      // `retry-after-global` is set by `@nestjs/throttler` when the
      // app-wide limit is the one that tripped; the per-endpoint
      // `retry-after` is set when a route-level throttler wins. We take
      // the larger of the two because requesting again before the longer
      // cooldown elapses will just bounce off the same 429 again.
      let retryAfterSeconds: number | undefined;
      if (res.status === 429) {
        const perBucket = parseRetryAfter(res.headers.get('retry-after'));
        const global = parseRetryAfter(
          res.headers.get('retry-after-global'),
        );
        const longest = Math.max(perBucket ?? 0, global ?? 0);
        retryAfterSeconds = longest > 0 ? Math.ceil(longest) : 30;
      }
      return {
        ok: res.ok,
        status: res.status,
        data,
        problem,
        retryAfterSeconds,
      };
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
export const DEFAULT_SETTINGS: Settings = {
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

export const DEFAULT_EMAIL_SETTINGS: EmailSettings = {
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

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  baseUrl: null,
  defaultModel: null,
  apiKeyConfigured: false,
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

export type LoginActivityBucket = {
  identifier: string;
  success: number;
  failure: number;
  lastSeen: string;
};

export type LoginActivityRow = {
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

export type LockoutEntry = {
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

export type ActorRef = { id: string; name: string };

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
    externalId: string;
    lastSyncedAt: string;
  }>;
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
  articleCount: number;
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
  createdByUser: ActorRef | null;
  updatedByUser: ActorRef | null;
  createdAt: string;
  updatedAt: string;
};

export type ArticleDetail = ArticleSummary & {
  editorMode: 'tiptap' | 'markdown';
  /** Tiptap JSON when `editorMode` is `tiptap`, else `null`. */
  content: unknown | null;
  /** Raw Markdown when `editorMode` is `markdown`, else `null`. */
  markdownSource: string | null;
  contentPlaintext: string;
  /**
   * True if the signed-in user has starred this article.
   */
  isStarred: boolean;
  /**
   * True if there is an in-progress autosave draft for this article.
   * Drives the editor's Cancel-with-revert path and the "draft in
   * progress" badge in the history panel. List responses always
   * report `false` (omitted server-side to avoid an N+1) — this is
   * only meaningful on detail loads.
   */
  hasDraft: boolean;
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

export type ArticleVersionSummary = {
  version: number;
  isDraft: boolean;
  title: string;
  slug: string;
  editorMode: 'tiptap' | 'markdown';
  changedFields: string[];
  changedBy: string;
  changedByName: string | null;
  changeReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ArticleVersionDetail = ArticleVersionSummary & {
  folderId: string | null;
  visibleToClients: boolean;
  content: unknown | null;
  markdownSource: string | null;
  contentPlaintext: string;
  excerpt: string | null;
};

export async function listArticleVersions(
  companyId: string,
  id: string,
): Promise<ArticleVersionSummary[]> {
  const res = await serverApiFetch<ArticleVersionSummary[]>(
    `/companies/${companyId}/articles/${id}/versions`,
  );
  if (!res.ok || !res.data) return [];
  return res.data;
}

export async function getArticleVersion(
  companyId: string,
  id: string,
  version: number,
): Promise<ArticleVersionDetail | null> {
  const res = await serverApiFetch<ArticleVersionDetail>(
    `/companies/${companyId}/articles/${id}/versions/${version}`,
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
  /**
   * Article that embeds this upload, resolved server-side by scanning
   * article bodies. Populated only for `attachedToType === 'article'`
   * uploads — those rows store no `attachedToId` so the photos gallery
   * needs this to build a "back to article" link.
   */
  sourceArticle: { id: string; slug: string; title: string } | null;
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
  /** v2 — latest hygiene score (percentage 0-100). NULL if never scored. */
  latestScore: number | null;
  /** v2 — operator-supplied DKIM selectors (CSV). */
  dkimSelectorOverride: string | null;
  archivedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DomainScoreTier =
  | 'excellent'
  | 'good'
  | 'fair'
  | 'poor'
  | 'critical';

export type DomainScoreBreakdownItem = {
  id: string;
  label: string;
  points: number;
  max: number;
  status: 'pass' | 'partial' | 'fail' | 'skip';
  evidence?: string;
};

export type DomainCheckDetails = {
  schemaVersion?: number;
  whois?: {
    registrar?: string | null;
    registeredAt?: string | null;
    expiresAt?: string | null;
    source?: 'rdap' | 'whois43' | 'none';
    statusCodes?: string[];
    locked?: boolean;
    hold?: boolean;
    whoisNs?: string[];
  };
  dns?: {
    a?: string[];
    aaaa?: string[];
    mx?: Array<{ preference: number; exchange: string }>;
    ns?: string[];
    txt?: string[];
    caa?: Array<{ flag: number; tag: string; value: string }>;
    dnssec?: {
      signed: boolean;
      source: 'rdap' | 'dnskey' | 'none';
      dsRecordCount?: number;
    };
    nsMatch?: {
      dnsNs: string[];
      whoisNs: string[];
      match: 'match' | 'mismatch' | 'unverifiable';
    };
  };
  email?: {
    hasMx: boolean;
    spf?: {
      present: boolean;
      record?: string | null;
      mechanisms?: string[];
      all?: '+all' | '-all' | '~all' | '?all' | null;
      lookupCount?: number;
      valid: boolean;
    };
    dmarc?: {
      present: boolean;
      policy?: 'none' | 'quarantine' | 'reject' | null;
      subdomainPolicy?: 'none' | 'quarantine' | 'reject' | null;
      pct?: number | null;
      rua?: string[];
      ruf?: string[];
      raw?: string | null;
    };
    dkim?: {
      selectorsChecked: string[];
      selectorsFound: string[];
      provider?: 'google' | 'microsoft' | 'mailgun' | 'sendgrid' | 'unknown';
    };
  };
  tls?: {
    validFrom?: string | null;
    validTo?: string | null;
    issuer?: string | null;
    subjectAltNames?: string[];
    chainLength?: number;
    protocol?: string | null;
    authorized?: boolean | null;
    authorizationError?: string | null;
    cert?: {
      keyAlgo?: string | null;
      keyBits?: number | null;
      sigAlgo?: string | null;
      mustStaple?: boolean;
      ocspStapled?: boolean;
      daysUntilExpiry?: number | null;
    };
  };
  http?: {
    redirectsToHttps: boolean;
    finalStatus?: number | null;
    finalUrl?: string | null;
    hsts?: {
      present: boolean;
      maxAge?: number | null;
      includeSubDomains?: boolean;
      preload?: boolean;
    };
    error?: string | null;
  };
  score?: {
    version: number;
    total: number;
    max: number;
    percent: number;
    tier: DomainScoreTier;
    breakdown: DomainScoreBreakdownItem[];
    hardOverride?: { kind: 'force_critical' | 'cap_fair'; reason: string } | null;
  };
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
export type AdminStats = {
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

export type ExpirationStatus = 'EXPIRED' | 'WARNING';

export type AssetFieldExpiration = {
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

export type DomainExpiration = {
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

export type PasswordExpiration = {
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

export type PasswordSummary = {
  id: string;
  companyId: string;
  folderId: string | null;
  assetId: string | null;
  name: string;
  username: string | null;
  url: string | null;
  color: string | null;
  tags: string[];
  hasTotp: boolean;
  passwordStrength: number | null;
  pwnedCount: number | null;
  lastRotatedAt: string | null;
  rotationReminderDays: number | null;
  expiresAt: string | null;
  visibleToClients: boolean;
  requireReasonToView: boolean;
  restrictedToUserIds: string[];
  archivedAt: string | null;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

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

export async function getPasswordDetail(
  companyId: string,
  id: string,
): Promise<PasswordDetail | null> {
  const res = await serverApiFetch<PasswordDetail>(
    `/companies/${companyId}/passwords/${id}`,
  );
  if (!res.ok || !res.data) return null;
  return res.data;
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

export type SubnetUtilization = {
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
  if (!res.ok || !res.data) return null;
  return res.data;
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

// ---------------------------------------------------------------------
// Phase 5: IP allow/deny rules (global, enforced before auth)
// ---------------------------------------------------------------------

export type IpRuleAction = 'ALLOW' | 'DENY';

export type IpRule = {
  id: string;
  cidr: string;
  action: IpRuleAction;
  note: string | null;
  priority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

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
export type TicketListPage = import('@weavestream/shared').TicketListResponse;
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

