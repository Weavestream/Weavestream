import type { SidebarSwitcherEntry } from '../components/shell/sidebar';
import {
  activeMemberships,
  canAccessAdminShell,
  membershipRoleLabel,
  type ViewerLike,
} from './roles';
import type { Me } from './server-api';

export type CompanyShellNav = {
  /** Where the sidebar mark links. `undefined` renders it static. */
  homeHref?: string;
  /**
   * A title destination distinct from `homeHref`, which splits the
   * sidebar header back into two controls. `undefined` when the title
   * is either the switcher, part of the home link, or static.
   */
  titleHref?: string;
  /** Tenant-picker popover entries, or `null` for no picker. */
  switcherEntries: SidebarSwitcherEntry[] | null;
};

/**
 * Header navigation targets for `CompanyShell`, by viewer and mode.
 *
 * Extracted from the component so the one invariant that matters here
 * is testable rather than asserted by reading:
 *
 *   **A viewer without admin-shell access is never handed an `/admin`
 *   href.** Every route out of the portal for such a user is either a
 *   `/portal/**` link or `/`, which itself re-derives the landing
 *   route from the session and only reaches `/admin` for viewers who
 *   pass the same `canAccessAdminShell` check.
 *
 * Shape by viewer:
 *   admin mode          — one block, the workspace identity → `/admin`.
 *   client, any tenants — the mark is static. A client has nowhere to
 *                         go: `/` only re-derives their landing route
 *                         and, via the `ws_last_company` cookie, drops
 *                         them in the tenant they are already in. With
 *                         2+ tenants the switcher popover is the one
 *                         control that does anything; with 1 there is
 *                         nothing to switch to.
 *   operator previewing — mark → `/admin`, title → `/admin/companies`,
 *                         their real switcher. An operator who also
 *                         holds 2+ memberships gets the popover
 *                         instead, since that switches without leaving
 *                         the portal.
 */
export function companyShellNav(
  me: Me,
  company: { id: string },
  mode: 'admin' | 'portal',
): CompanyShellNav {
  const isAdmin = mode === 'admin';
  const operatorAccess = canAccessAdminShell(me as ViewerLike);
  const memberships = activeMemberships(me);
  const showSwitcher = !isAdmin && memberships.length > 1;

  // `/admin` is the only destination the mark ever has, and only a
  // viewer who passes `canAccessAdminShell` can reach it.
  const homeHref = isAdmin || operatorAccess ? '/admin' : undefined;

  // A second destination for the title, only where one genuinely
  // differs from the mark's: an operator previewing a portal whose own
  // picker lives in the admin shell. Everyone else either has the
  // popover or has nowhere to go, so the block stays a single control.
  const titleHref =
    !isAdmin && !showSwitcher && operatorAccess
      ? '/admin/companies'
      : undefined;

  const switcherEntries: SidebarSwitcherEntry[] | null = showSwitcher
    ? memberships
        .slice()
        .sort((a, b) => a.company.name.localeCompare(b.company.name))
        .map((m) => ({
          id: m.id,
          name: m.company.name,
          subtitle: `/${m.company.slug} · ${membershipRoleLabel(m.role)}`,
          href: `/portal/${m.company.slug}`,
          active: m.company.id === company.id,
        }))
    : null;

  return { homeHref, titleHref, switcherEntries };
}
