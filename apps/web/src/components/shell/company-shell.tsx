import type { ReactNode } from 'react';
import type {
  CompanyListItem,
  LayoutSummary,
  Me,
} from '../../lib/server-api';
import {
  activeMemberships,
  canAccessAdminShell,
  initialsFromName,
  membershipRoleLabel,
  roleLabel,
} from '../../lib/roles';
import type { Term } from '../../lib/term';
import { LayoutSwatch } from '../ui';
import { SidebarActions } from './sidebar-actions';
import { SidebarToolbar } from './sidebar-toolbar';
import {
  Sidebar,
  type SidebarSection,
  type SidebarSwitcherEntry,
} from './sidebar';
import { MobileShellChrome } from './mobile-nav';
import {
  StickyNoteProvider,
  type StickyNoteSeverity,
} from './sticky-note-context';
import { SearchPaletteProvider } from '../search/search-palette-provider';
import { ChatPanelProvider } from '../chat-panel/chat-panel-provider';
import { ChatPanel } from '../chat-panel/chat-panel';

export type CompanyShellMode = 'admin' | 'portal';

/**
 * Server-rendered shell for every company-scoped route. Drives both
 * `/admin/companies/[id]/**` (operators, `mode='admin'`) and
 * `/portal/[slug]/**` (client users, `mode='portal'`), which are the
 * two places the product needs a company-scoped sidebar.
 *
 * Contract:
 *   - Header logo leaves company scope: `/admin` for operators, the
 *     tenant-picker portal home for multi-membership clients, or a
 *     static chip for single-membership clients (nothing to go back
 *     to).
 *   - Title block is either the company picker (admin) or the
 *     membership picker (portal with multiple memberships) — a
 *     single-membership client gets a static block since clicking
 *     would navigate them straight back.
 *   - Nav lists the company-scoped surfaces (Home, Articles, Photos,
 *     All assets), every `AssetLayout` in a "Layouts" section with
 *     swatches + live counts (including empty layouts — that's how a
 *     user discovers a layout and adds the first asset), and an
 *     operator-only "Admin console" jump when the viewer has
 *     operator privileges.
 *
 * Counts are precomputed server-side (via `countsByLayout`) so the
 * sidebar renders in a single pass with no client loading states.
 */
export function CompanyShell({
  me,
  company,
  layouts,
  counts,
  term,
  mode = 'admin',
  activeId,
  children,
  domainCount,
  domainBadge,
  portalHasDomains = true,
  passwordCount,
  passwordStaleBadge,
  portalHasPasswords = true,
  subnetCount,
  subnetConflictBadge,
  portalHasSubnets = true,
  stickyNote,
}: {
  me: Me;
  company: Pick<CompanyListItem, 'id' | 'name' | 'slug'>;
  layouts: LayoutSummary[];
  counts: Record<string, number>;
  term: Term;
  mode?: CompanyShellMode;
  activeId?: string;
  children: ReactNode;
  /**
   * Total number of active (non-archived) domains for this company.
   * Rendered as a dim numeric count on the Domains sidebar entry,
   * matching the pattern used by layout entries. `undefined` hides it.
   */
  domainCount?: number;
  /**
   * Number of domains in EXPIRING/EXPIRED/FAIL state for this company.
   * Rendered as a warning-toned badge on the Domains sidebar entry
   * alongside the total count. `0` or `undefined` hides the badge.
   */
  domainBadge?: number;
  /**
   * On the portal side, the Domains entry is hidden entirely when the
   * tenant has no visible domains so client users aren't teased with a
   * dead link. Defaults to true so admin pages don't need to set it.
   */
  portalHasDomains?: boolean;
  /**
   * Total number of active (non-archived) passwords visible to the
   * current viewer. Renders as a dim count on the Passwords entry.
   */
  passwordCount?: number;
  /**
   * Number of passwords flagged as stale (rotation reminder elapsed or
   * `expires_at` in the past). Renders as a warning-toned badge.
   */
  passwordStaleBadge?: number;
  /**
   * Portal-only toggle — hide the Passwords entry entirely when the
   * tenant has no client-visible credentials. Defaults to true.
   */
  portalHasPasswords?: boolean;
  /** Total active subnets. Dim count on the IPAM sidebar entry. */
  subnetCount?: number;
  /** Number of subnets with at least one IP conflict. Warning badge. */
  subnetConflictBadge?: number;
  /** Hide IPAM entry on the portal when the tenant has no subnets. */
  portalHasSubnets?: boolean;
  /**
   * Optional per-company banner shown above the breadcrumbs on every
   * page. Populated from the company settings — admin layout passes
   * it through; portal layout omits it (admin-only feature).
   */
  stickyNote?: { text: string; severity: StickyNoteSeverity } | null;
}) {
  const isAdmin = mode === 'admin';
  const base = isAdmin
    ? `/admin/companies/${company.id}`
    : `/portal/${company.slug}`;

  const activeLayouts = layouts.filter((l) => l.archivedAt === null);
  // Clients only ever see client-visible fields; filtering layouts
  // themselves isn't necessary (the API already returns only what
  // they're allowed to read), but we hide ones where every field is
  // internal so an empty-detail view never materialises. Portal mode
  // additionally hides layouts with zero assets in this tenant —
  // clients can't create anything, so a layout with no content is a
  // dead link. Admin mode keeps empty layouts visible because
  // operators need to discover them to seed the first asset.
  const visibleLayouts = isAdmin
    ? activeLayouts
    : activeLayouts
        .filter((l) =>
          l.fields.some((f) => f.visibleToClients && f.archivedAt === null),
        )
        .filter((l) => (counts[l.id] ?? 0) > 0);

  const showDomains = isAdmin || portalHasDomains;
  const showPasswords = isAdmin || portalHasPasswords;
  const showIpam = isAdmin || (portalHasSubnets ?? false);
  // Portal nav is intentionally a subset: no Photos, no All-assets
  // catch-all. Each content surface shows up only when the tenant
  // actually has something in it (layouts are filtered by count above,
  // Domains by `portalHasDomains`). Admin keeps the full set so
  // operators can navigate to empty surfaces and seed them.
  const sections: SidebarSection[] = [
    {
      items: [
        { id: 'overview', label: 'Home', icon: 'home', href: base },
        { id: 'articles', label: 'Articles', icon: 'doc', href: `${base}/articles` },
        ...(isAdmin
          ? [
              {
                id: 'photos',
                label: 'Photos',
                icon: 'image' as const,
                href: `${base}/photos`,
              },
              {
                id: 'assets',
                label: 'All assets',
                icon: 'box' as const,
                href: `${base}/assets`,
              },
            ]
          : []),
        ...(showDomains
          ? [
              {
                id: 'domains',
                label: 'Domains',
                icon: 'globe' as const,
                href: `${base}/domains`,
                count: domainCount,
                badge:
                  domainBadge && domainBadge > 0
                    ? String(domainBadge)
                    : undefined,
              },
            ]
          : []),
        ...(showIpam
          ? [
              {
                id: 'ipam',
                label: 'IPAM',
                icon: 'globe' as const,
                href: `${base}/ipam`,
                count: subnetCount,
                badge:
                  subnetConflictBadge && subnetConflictBadge > 0
                    ? String(subnetConflictBadge)
                    : undefined,
              },
            ]
          : []),
        ...(showPasswords
          ? [
              {
                id: 'passwords',
                label: 'Passwords',
                icon: 'lock' as const,
                href: `${base}/passwords`,
                count: passwordCount,
                badge:
                  passwordStaleBadge && passwordStaleBadge > 0
                    ? String(passwordStaleBadge)
                    : undefined,
              },
            ]
          : []),
      ],
    },
  ];

  if (visibleLayouts.length > 0) {
    sections.push({
      title: 'Layouts',
      items: visibleLayouts.map((l) => ({
        id: `layout:${l.id}`,
        label: l.name,
        icon: 'box',
        leading: <LayoutSwatch icon={l.icon} color={l.color} size={18} />,
        href: `${base}/layouts/${l.slug}`,
        count: counts[l.id] ?? 0,
      })),
    });
  }

  // The Admin-console jump is gated by `canAccessAdminShell` — it
  // holds for SUPER_ADMINs and any OPERATOR with non-NONE
  // `globalAccess` or a granted platform capability. Surfaced from
  // both modes so an operator viewing a client portal still has a
  // one-click escape back to admin.
  const adminAccess = canAccessAdminShell(me);
  if (adminAccess) {
    sections.push({
      title: 'Operator',
      items: [
        {
          id: 'admin-console',
          label: 'Admin console',
          icon: 'gear',
          href: '/admin',
        },
      ],
    });
  }

  sections.push({
    title: 'Account',
    items: [{ id: 'me', label: 'Profile', icon: 'person', href: '/me' }],
  });

  // Header link targets diverge by mode:
  //   admin   : logo -> /admin,                  title -> /admin/companies
  //   portal  : logo -> /             (when the user has options to
  //              pick from — i.e. >1 membership or operator access),
  //              title -> popover picker for multi-membership clients,
  //                       /admin/companies for operators, static otherwise
  const operatorAccess = adminAccess;
  const portalMemberships = activeMemberships(me);
  const hasMultipleMemberships = portalMemberships.length > 1;
  const hasOptions = hasMultipleMemberships || operatorAccess;
  const homeHref = isAdmin
    ? '/admin'
    : hasOptions
      ? operatorAccess
        ? '/admin'
        : '/'
      : undefined;
  // A multi-membership client gets a real in-sidebar picker instead
  // of a link back to `/` (which would just round-trip through the
  // last-used cookie and land them on the same company). Operators
  // still use `/admin/companies` since that's their full switcher.
  const showPortalSwitcher = !isAdmin && hasMultipleMemberships;
  const titleHref =
    isAdmin
      ? '/admin/companies'
      : showPortalSwitcher
        ? undefined
        : hasOptions
          ? operatorAccess
            ? '/admin/companies'
            : '/'
          : undefined;
  const switcherEntries: SidebarSwitcherEntry[] | null = showPortalSwitcher
    ? portalMemberships
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

  const sidebarWorkspace = {
    name: company.name,
    // The mono "All {companies}" subtitle doubles as a company-picker
    // affordance on the admin side. In portal mode it promises
    // switching that clients can't actually do, so we drop it and let
    // the title block breathe.
    subtitle: isAdmin ? `All ${term.other}` : undefined,
    homeHref,
    titleHref,
    titleSwitcher: switcherEntries
      ? { label: 'Your companies', entries: switcherEntries }
      : undefined,
  };
  const sidebarUser = {
    initials: initialsFromName(me.name),
    name: me.name,
    subtitle: `${roleLabel(me.role)} · ${me.mfaEnabled ? 'mfa' : 'no mfa'}`,
  };

  // Footer toolbar layout:
  //   admin   : Expiring-soon shortcut + Starred drawer.
  //   portal  : Expiring-soon links to /admin (gated by AdminLayout) so
  //             we hide it for clients; Starred is admin-only too. When
  //             nothing remains (CLIENT_USER without operator access),
  //             we omit the whole row so the divider above it doesn't
  //             render either.
  const showStarred = isAdmin || operatorAccess;
  const showExpirations = isAdmin;
  // The toolbar always renders so the chat-panel toggle is reachable on
  // every shell, including client portals where the starred/expirations
  // shortcuts are hidden.
  const footerToolbar = (
    <SidebarToolbar
      companyId={company.id}
      showStarred={showStarred}
      showExpirations={showExpirations}
    />
  );

  return (
    <StickyNoteProvider value={stickyNote ?? null}>
    <SearchPaletteProvider
      scopedCompany={{ id: company.id, name: company.name }}
      defaults={me.searchDefaults}
    >
      <ChatPanelProvider>
      <div style={{ display: 'flex', height: '100vh', background: 'var(--bg)' }}>
        <Sidebar
          workspace={sidebarWorkspace}
          sections={sections}
          user={sidebarUser}
          activeId={activeId}
          footerAction={<SidebarActions />}
          footerToolbar={footerToolbar}
          className="hide-on-mobile"
        />
        <main
          className="scroll"
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'auto',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <MobileShellChrome
            workspaceName={company.name}
            sidebar={
              <Sidebar
                workspace={sidebarWorkspace}
                sections={sections}
                user={sidebarUser}
                activeId={activeId}
                footerAction={<SidebarActions />}
                footerToolbar={footerToolbar}
                variant="drawer"
              />
            }
          />
          {children}
        </main>
        <ChatPanel />
      </div>
      </ChatPanelProvider>
    </SearchPaletteProvider>
    </StickyNoteProvider>
  );
}
