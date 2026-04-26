import type { ReactNode } from 'react';
import type { Me } from '../../lib/server-api';
import { canManage, initialsFromName, roleLabel } from '../../lib/roles';
import type { Term } from '../../lib/term';
import { Sidebar, type SidebarSection } from './sidebar';
import { SidebarActions } from './sidebar-actions';
import { SidebarToolbar } from './sidebar-toolbar';
import { MobileShellChrome } from './mobile-nav';
import { SearchPaletteProvider } from '../search/search-palette-provider';

export function AdminShell({
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
  const manage = canManage(me.role);
  const isSuperAdmin = me.role === 'SUPER_ADMIN';

  const sections: SidebarSection[] = [
    {
      items: [
        { id: 'dashboard', label: 'Dashboard', icon: 'home', href: '/admin' },
        {
          // Internal sidebar id stays `companies` — it matches the route
          // segment and the `activeId` strings used across admin pages.
          id: 'companies',
          label: term.other,
          icon: 'building',
          href: '/admin/companies',
        },
        {
          id: 'layouts',
          label: 'Asset Layouts',
          icon: 'grid',
          href: '/admin/layouts',
        },
        { id: 'audit', label: 'Audit log', icon: 'shield', href: '/admin/audit' },
      ],
    },
  ];

  if (manage) {
    const adminItems: SidebarSection['items'] = [
      { id: 'users', label: 'Users', icon: 'users', href: '/admin/users' },
      {
        id: 'memberships',
        label: 'Memberships',
        icon: 'network',
        href: '/admin/memberships',
      },
    ];
    // Branding + tenant-term configuration is super-admin-only — it's a
    // global singleton, not a per-company setting.
    if (isSuperAdmin) {
      adminItems.push({
        id: 'integrations',
        label: 'Integrations',
        icon: 'plug',
        href: '/admin/integrations',
      });
      adminItems.push({
        id: 'settings',
        label: 'Settings',
        icon: 'gear',
        href: '/admin/settings',
      });
      adminItems.push({
        id: 'export',
        label: 'Export',
        icon: 'archive',
        href: '/admin/export',
      });
    }
    sections.push({
      title: 'Admin',
      items: adminItems,
    });
  }

  sections.push({
    title: 'Account',
    items: [
      { id: 'me', label: 'Profile', icon: 'person', href: '/me' },
    ],
  });

  const sidebarWorkspace = {
    ...workspace,
    // Admin shell: logo is always the global dashboard, and the
    // title block doubles as the company picker — clicking it lands
    // on `/admin/companies`, which is the canonical list and switcher
    // surface.
    homeHref: '/admin',
    titleHref: '/admin/companies',
  };
  const sidebarUser = {
    initials: initialsFromName(me.name),
    name: me.name,
    subtitle: `${roleLabel(me.role)} · ${me.mfaEnabled ? 'mfa' : 'no mfa'}`,
  };

  return (
    <SearchPaletteProvider scopedCompany={null} defaults={me.searchDefaults}>
      <div style={{ display: 'flex', height: '100vh', background: 'var(--bg)' }}>
        <Sidebar
          workspace={sidebarWorkspace}
          sections={sections}
          user={sidebarUser}
          activeId={activeId}
          footerAction={<SidebarActions />}
          footerToolbar={<SidebarToolbar />}
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
                user={sidebarUser}
                activeId={activeId}
                footerAction={<SidebarActions />}
                footerToolbar={<SidebarToolbar />}
                variant="drawer"
              />
            }
          />
          {children}
        </main>
      </div>
    </SearchPaletteProvider>
  );
}
