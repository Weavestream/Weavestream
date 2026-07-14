import { notFound } from 'next/navigation';
import { unwrapApiResponse } from './api-errors';
import { canAccessAdminShell } from './roles';
import { serverApiFetch, type CompanyPage, type Me } from './server-api';

/**
 * Resolves the portal company for a given slug. Membership rows are
 * the fast path; admins (SUPER_ADMIN or OPERATORs with non-NONE
 * `globalAccess` / platform capabilities — i.e. `canAccessAdminShell`)
 * fall through to the `/companies` list endpoint so they can preview
 * the portal without holding an explicit membership.
 *
 * Authorization is enforced at the API tier: `/companies?q=` filters
 * server-side to the rows the actor is allowed to read (memberships +
 * RBAC v2 global access), so a non-admin or an operator with
 * `globalAccess=NONE` who isn't a member of the target company gets an
 * empty list and falls through to `notFound()`. Every downstream
 * per-company data call (`listPasswords`, `getAsset`, …) re-enforces
 * its own permission at the controller layer, so this helper is *not*
 * the security boundary — it is a UX shortcut.
 *
 * Calls `notFound()` if no matching company is accessible to the user.
 */
export async function resolvePortalCompany(
  me: Me,
  companySlug: string,
): Promise<{ id: string; name: string; slug: string }> {
  const membership = me.memberships.find((m) => m.company.slug === companySlug);
  if (membership) return membership.company;

  if (canAccessAdminShell(me)) {
    // Use the API's hard `limit` cap (200) and paginate defensively
    // so we don't miss an exact slug match when many companies share
    // a substring with the requested slug. Slugs are globally unique,
    // so the loop terminates as soon as we see the exact match or
    // exhaust the result set. We cap at 5 pages = 1000 rows to bound
    // the worst case; a deployment with more than 1000 companies
    // whose slugs share a common substring is well outside the
    // current product envelope and can add a slug-lookup endpoint.
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const cursorParam: string = cursor
        ? `&cursor=${encodeURIComponent(cursor)}`
        : '';
      const res = await serverApiFetch<CompanyPage>(
        `/companies?q=${encodeURIComponent(companySlug)}&limit=200${cursorParam}`,
      );
      // Throws on network failure / 5xx / 429 — treating a broken
      // `/companies` response as "no match" would surface the outage
      // as a misleading 404 on every admin portal preview.
      const data = unwrapApiResponse(res, '/companies');
      const items = data?.items ?? [];
      const company =
        items.find((c: { slug: string }) => c.slug === companySlug) ?? null;
      if (company) return company;
      cursor = data?.nextCursor ?? null;
      if (!cursor) break;
    }
  }

  // Dev-only Safari gotcha (not a bug in this code — leave the throw
  // as-is): this `notFound()` is logged by Next's bundled React
  // *development* reconciler via `performance.measure(name, { start,
  // end, detail })`. WebKit rejects that call for an aborted render and
  // raises a bare `TypeError` ("Type error" at `measure [native
  // code]`), which pops the Next.js dev error overlay even though the
  // 404 renders fine. The instrumentation is stripped from the
  // production React build (zero prod impact) and doesn't reproduce in
  // Chromium. Revisit only if Next bundles a React that guards the call.
  notFound();
}
