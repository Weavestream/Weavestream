import { cache } from 'react';
import type {
  CompanyLogo,
  CompanyType,
  MembershipRole,
} from '@weavestream/shared';
import { serverApiFetch, type ServerApiResponse } from './core';

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
// Each domain module keeps its own helpers: `getCompanyDetail` and
// `getCompanyMemberships` here, `getActiveLayouts` (`layouts.ts`),
// `getCompanyAssetCounts` (`assets.ts`), `getCompanyFolderTree`
// (`articles.ts`), `getCompanyDomainsBasic` (`domains.ts`),
// `getCompanyActivePasswords` and `getCompanyPasswordFolders`
// (`passwords.ts`), and `getCompanySubnetsBasic` (`ipam.ts`).
//
// Each helper mirrors the un-cached list/fetch function it
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
