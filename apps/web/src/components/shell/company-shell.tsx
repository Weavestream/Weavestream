import type { ReactNode } from 'react';
import type {
  CompanyListItem,
  LayoutSummary,
  Me,
} from '../../lib/server-api';
import { canAccessAdminShell, initialsFromName } from '../../lib/roles';
import { companyShellNav } from '../../lib/company-shell-nav';
import { LayoutSwatch } from '../ui';
import { Sidebar, type SidebarSection } from './sidebar';
import { SidebarActiveProvider } from './sidebar-active';
import { MobileShellChrome } from './mobile-nav';
import {
  StickyNoteProvider,
  type StickyNoteSeverity,
} from './sticky-note-context';
import { SearchPaletteProvider } from '../search/search-palette-provider';
import { ChatPanel } from '../chat-panel/chat-panel';
import { CompanyChatContext } from '../chat-panel/company-chat-context';
import { ShellScopeProvider } from './shell-scope-context';
import { getEffectiveTimezone } from '../../lib/date-format';
import { TimezoneProvider } from '../../lib/timezone-context';

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
  workspaceName,
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
  /**
   * `settings.workspaceName` — the install's own name, shown in the
   * sidebar header on admin surfaces so it matches the `AdminShell`
   * aside. Unused in portal mode, where the sidebar shows the client's
   * company instead. Falls back to the company name if a caller omits
   * it, which keeps the header populated rather than blank.
   */
  workspaceName?: string;
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
  // Portal nav is intentionally a subset: no All-assets catch-all.
  // Photos is shared between admin and portal — the API filters out
  // uploads whose parent isn't visible to CLIENT_USER, so the gallery
  // is safe to expose. Each content surface shows up only when the
  // tenant actually has something in it (layouts are filtered by count
  // above, Domains by `portalHasDomains`). Admin keeps the full set so
  // operators can navigate to empty surfaces and seed them.
  const sections: SidebarSection[] = [
    {
      items: [
        { id: 'overview', label: 'Home', icon: 'home', href: base },
        { id: 'articles', label: 'Articles', icon: 'doc', href: `${base}/articles` },
        {
          id: 'photos',
          label: 'Photos',
          icon: 'image' as const,
          href: `${base}/photos`,
        },
        ...(isAdmin
          ? [
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
                icon: 'network' as const,
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
        // Bare glyph in the layout's colour, no chip: `size={14}` is
        // what `NavItem` renders its own icons at, so a layout entry
        // lines up with Home/Articles/Photos above it.
        leading: (
          <LayoutSwatch icon={l.icon} color={l.color} size={14} frame={false} />
        ),
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
          icon: 'sliders',
          href: '/admin',
        },
      ],
    });
  }

  // Profile / theme / sign-out moved to the top-bar avatar menu —
  // identity now lives in a single surface so we don't duplicate it
  // in the sidebar footer too.

  // Header link targets, derived in `companyShellNav` so the "a client
  // user is never handed an /admin href" invariant is covered by tests
  // rather than by reading the ternaries. Admin mode is one block (the
  // workspace identity → /admin); the portal splits by how many
  // tenants the viewer can actually reach.
  const { homeHref, titleHref, switcherEntries } = companyShellNav(
    me,
    company,
    mode,
  );

  const sidebarWorkspace = {
    // Admin: the install's own name, matching the sidebar on every
    // global `/admin/**` page, so the aside reads the same wherever an
    // operator is. Portal: the client's own company — a client user has
    // no notion of the MSP's workspace, and their company name is the
    // one identity that means anything in that shell.
    name: isAdmin ? (workspaceName ?? company.name) : company.name,
    // No subtitle on the admin side: the old one was the "All
    // {companies}" picker affordance, not information. Portal never had
    // one — it promised switching clients can't do.
    subtitle: undefined,
    homeHref,
    titleHref,
    titleSwitcher: switcherEntries
      ? { label: 'Your companies', entries: switcherEntries }
      : undefined,
  };

  // Top-bar action cluster visibility:
  //   admin   : Expiring-soon shortcut + Starred drawer + AI chat.
  //   portal  : Expiring-soon links to /admin (gated by AdminLayout) so
  //             we hide it for clients; Starred is admin-only too;
  //             AI chat has no scoped context for end clients, so we
  //             hide the toggle (the panel itself still mounts for
  //             operators browsing portal routes if they reopen it).
  const showStarred = isAdmin || adminAccess;
  const showExpirations = isAdmin;
  const showChat = isAdmin;

  return (
    <TimezoneProvider timezone={getEffectiveTimezone(me)}>
    <StickyNoteProvider value={stickyNote ?? null}>
    <ShellScopeProvider
      value={{
        companyId: company.id,
        // Same gating as the sidebar footer toolbar — operators see
        // Starred everywhere, Expirations is admin-mode only since the
        // destination lives under `/admin` and bounces CLIENT_USERs.
        showStarred,
        showExpirations,
        showChat,
        me: {
          name: me.name,
          email: me.email,
          initials: initialsFromName(me.name),
        },
      }}
    >
    <SidebarActiveProvider>
    <SearchPaletteProvider
      scopedCompany={{ id: company.id, name: company.name }}
      defaults={me.searchDefaults}
    >
      <div style={{ display: 'flex', height: '100vh', background: 'var(--bg)' }}>
        <Sidebar
          workspace={sidebarWorkspace}
          sections={sections}
          activeId={activeId}
          showCounts={me.preferences.showItemCounts}
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
            // Same identity the desktop sidebar header shows — the
            // install's workspace name on admin surfaces, the client's
            // own company on the portal. Passing `company.name` here
            // made the mobile bar disagree with every wider viewport.
            workspaceName={sidebarWorkspace.name}
            sidebar={
              <Sidebar
                workspace={sidebarWorkspace}
                sections={sections}
                activeId={activeId}
                showCounts={me.preferences.showItemCounts}
                variant="drawer"
              />
            }
          />
          {children}
        </main>
        {isAdmin && <CompanyChatContext companyId={company.id} />}
        <ChatPanel />
      </div>
    </SearchPaletteProvider>
    </SidebarActiveProvider>
    </ShellScopeProvider>
    </StickyNoteProvider>
    </TimezoneProvider>
  );
}
