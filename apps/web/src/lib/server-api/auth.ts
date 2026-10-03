import { cache } from 'react';
import { redirect } from 'next/navigation';
import type {
  GlobalAccess,
  MembershipRole,
  PlatformCapability,
  UserRole,
  UserSearchDefaults,
  UserUiPreferences,
} from '@weavestream/shared';
import { unwrapMeResponse } from '../api-errors';
import { forMetadata, serverApiFetch } from './core';

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
