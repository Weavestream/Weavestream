import type { ReactNode } from 'react';
import {
  hasAnyTicketingIntegration,
  type Me,
} from '../../lib/server-api';
import { hasCapability, initialsFromName } from '../../lib/roles';
import type { Term } from '../../lib/term';
import { getEffectiveTimezone } from '../../lib/date-format';
import { TimezoneProvider } from '../../lib/timezone-context';
import { Sidebar, type SidebarSection } from './sidebar';
import { MobileShellChrome } from './mobile-nav';
import { SearchPaletteProvider } from '../search/search-palette-provider';
import { ChatPanel } from '../chat-panel/chat-panel';
import { ShellScopeProvider } from './shell-scope-context';

export async function AdminShell({
  me,
  workspace,
  term,
  activeId,
  children,
}: {
  me: Me;
  /**
   * Workspace chip rendered at the top of the sidebar. Fed from the
   * singleton `system_settings` row so each install shows its own name
   * — we never ship product-specific copy ("Spiffy Solutions") here.
   */
  workspace: { name: string; subtitle: string };
  /** Tenant terminology (Company/Client/Department/…). */
  term: Term;
  activeId?: string;
  children: ReactNode;
}) {
  // RBAC v2 — most admin sidebar entries are gated by a single
  // `PlatformCapability`. SUPER_ADMIN holds them all implicitly; an
  // OPERATOR sees only the entries matching the capabilities granted
  // on `User.platformCapabilities`. CONTRACTOR/CLIENT_USER never reach
  // this shell (the layout redirects them away first).
  //
  // Companies is special: the list page is a *read* surface (any
  // OPERATOR with non-NONE `globalAccess`, or any user with at least
  // one active membership, can list the companies they have access to)
  // so we surface it whenever the user already passed the admin-shell
  // gate. `COMPANY_MANAGE` is only enforced for create/update/archive
  // inside that page.
  const showCompanies = true;
  const showLayouts = hasCapability(me, 'LAYOUT_MANAGE');
  const showTags = hasCapability(me, 'TAG_MANAGE');
  const showAudit = hasCapability(me, 'AUDIT_READ');
  const showUsers = hasCapability(me, 'USER_MANAGE');
  const showMemberships = hasCapability(me, 'MEMBERSHIP_MANAGE');
  const showIntegrations = hasCapability(me, 'INTEGRATION_MANAGE');
  const showSettings = hasCapability(me, 'SETTINGS_MANAGE');
  const showExport = hasCapability(me, 'EXPORT_CREATE');
  const showAlerts = hasCapability(me, 'ALERT_MANAGE');
  const showSecurity = hasCapability(me, 'SECURITY_READ');
  const showIpRules = hasCapability(me, 'IP_RULE_MANAGE');
  const showBackups = hasCapability(me, 'BACKUP_MANAGE');
  // Tickets is gated on BOTH the capability AND a ticketing-capable
  // integration being wired up. Without the second check the entry
  // would land on an empty-state page for any operator on a fresh
  // workspace; we'd rather just hide the link until it can do
  // anything useful. The capability probe is cached per-request so
  // there is no extra round-trip cost when the operator lacks the
  // capability.
  const ticketsCapability = hasCapability(me, 'TICKETS_READ');
  const ticketingIntegrationActive = ticketsCapability
    ? await hasAnyTicketingIntegration()
    : false;
  const showTickets = ticketsCapability && ticketingIntegrationActive;

  const primaryItems: SidebarSection['items'] = [
    { id: 'dashboard', label: 'Dashboard', icon: 'home', href: '/admin' },
  ];
  if (showCompanies) {
    primaryItems.push({
      // Internal sidebar id stays `companies` — it matches the route
      // segment and the `activeId` strings used across admin pages.
      id: 'companies',
      label: term.other,
      icon: 'building',
      href: '/admin/companies',
    });
  }
  if (showTickets) {
    primaryItems.push({
      id: 'tickets',
      label: 'Ticket Browser',
      icon: 'chat',
      href: '/admin/tickets',
    });
  }
  if (showLayouts) {
    primaryItems.push({
      id: 'layouts',
      label: 'Asset Layouts',
      icon: 'grid',
      href: '/admin/layouts',
    });
  }
  if (showTags) {
    primaryItems.push({
      id: 'tags',
      label: 'Tags',
      icon: 'tag',
      href: '/admin/tags',
    });
  }
  if (showAudit) {
    primaryItems.push({
      id: 'audit',
      label: 'Audit log',
      icon: 'shield',
      href: '/admin/audit',
    });
  }
  if (showSecurity) {
    primaryItems.push({
      id: 'security',
      label: 'Security',
      icon: 'lock',
      href: '/admin/security',
    });
  }

  const sections: SidebarSection[] = [{ items: primaryItems }];

  const adminItems: SidebarSection['items'] = [];
  if (showUsers) {
    adminItems.push({ id: 'users', label: 'Users', icon: 'users', href: '/admin/users' });
  }
  if (showMemberships) {
    adminItems.push({
      id: 'memberships',
      label: 'Memberships',
      icon: 'network',
      href: '/admin/memberships',
    });
  }
  if (showIntegrations) {
    adminItems.push({
      id: 'integrations',
      label: 'Integrations',
      icon: 'plug',
      href: '/admin/integrations',
    });
  }
  if (showAlerts) {
    adminItems.push({
      id: 'alerts',
      label: 'Alerts',
      icon: 'bell',
      href: '/admin/alerts',
    });
  }
  if (showSettings) {
    adminItems.push({
      id: 'settings',
      label: 'Settings',
      icon: 'sliders',
      href: '/admin/settings',
    });
  }
  if (showIpRules) {
    adminItems.push({
      id: 'ip-rules',
      label: 'IP Rules',
      icon: 'shield',
      href: '/admin/ip-rules',
    });
  }
  if (showExport) {
    adminItems.push({
      id: 'export',
      label: 'Export',
      icon: 'archive',
      href: '/admin/export',
    });
  }
  if (showBackups) {
    adminItems.push({
      id: 'backups',
      label: 'Backups',
      icon: 'box',
      href: '/admin/backups',
    });
  }
  if (adminItems.length > 0) {
    sections.push({ title: 'Admin', items: adminItems });
  }

  // Profile / theme / sign-out moved to the top-bar avatar menu —
  // identity now lives in a single surface so we don't duplicate it
  // in the sidebar footer too.

  const sidebarWorkspace = {
    ...workspace,
    // The whole block is the global dashboard. It used to carry a
    // second destination — the title half linked to `/admin/companies`
    // as the company picker — which now lives in the top-bar scope
    // pill, with the `Companies` nav entry below as the other route in.
    homeHref: '/admin',
  };

  return (
    <TimezoneProvider timezone={getEffectiveTimezone(me)}>
    <ShellScopeProvider
      value={{
        // Admin shell is global — no per-company filtering on the
        // top-bar Expirations/Starred shortcuts.
        companyId: undefined,
        // Matches `SidebarToolbar`'s admin-shell defaults today (both
        // shortcuts default to visible). When we add finer RBAC for
        // these we'll swap to a capability check here, same place we
        // do it for everything else in this shell.
        showStarred: true,
        showExpirations: true,
        showChat: true,
        me: {
          name: me.name,
          email: me.email,
          initials: initialsFromName(me.name),
        },
      }}
    >
    <SearchPaletteProvider scopedCompany={null} defaults={me.searchDefaults}>
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
            workspaceName={workspace.name}
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
        <ChatPanel />
      </div>
    </SearchPaletteProvider>
    </ShellScopeProvider>
    </TimezoneProvider>
  );
}
