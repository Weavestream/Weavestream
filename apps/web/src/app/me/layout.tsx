import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AdminShell } from '../../components/shell/admin-shell';
import { CompanyShell } from '../../components/shell/company-shell';
import {
  getAssetCountsByLayout,
  getMe,
  getSettings,
  listDomains,
  listLayouts,
} from '../../lib/server-api';
import {
  canAccessAdminShell,
  preferredMembership,
} from '../../lib/roles';
import { buildTerm } from '../../lib/term';

/**
 * `/me` is the profile/settings surface and exists for every signed-in
 * role. Shell selection mirrors where the user spends the rest of
 * their time:
 *   - Anyone with admin-shell access (SUPER_ADMIN, or OPERATOR with
 *     non-NONE `globalAccess` or any `platformCapabilities`) gets the
 *     global `AdminShell` with "Profile" active.
 *   - Everyone else (client users, contractors, locked-down operators
 *     without admin-shell access) gets the portal `CompanyShell` for
 *     their last-used (or first active) membership so the sidebar they
 *     already know stays in place instead of vanishing on /me.
 *   - Users without any active membership are redirected to
 *     `/access-pending` — there's no company to scope the shell to,
 *     and the profile page isn't actionable for them anyway.
 */
export default async function MeLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  if (!cookieStore.get('ws_session')) redirect('/login');
  const me = await getMe();
  if (!me) redirect('/login');

  if (canAccessAdminShell(me)) {
    const settings = await getSettings();
    const term = buildTerm(settings);
    return (
      <AdminShell
        me={me}
        workspace={{ name: settings.workspaceName, subtitle: settings.workspaceSubtitle }}
        term={term}
        activeId="me"
      >
        {children}
      </AdminShell>
    );
  }

  const lastCompany = cookieStore.get('ws_last_company')?.value ?? null;
  const membership = preferredMembership(me, lastCompany);
  if (!membership) redirect('/access-pending');

  const [layouts, counts, domainList] = await Promise.all([
    listLayouts(),
    getAssetCountsByLayout(membership.company.id),
    listDomains(membership.company.id, { limit: 1 }),
  ]);

  return (
    <CompanyShell
      me={me}
      company={membership.company}
      layouts={layouts}
      counts={counts}
      mode="portal"
      activeId="me"
      portalHasDomains={domainList.items.length > 0}
    >
      {children}
    </CompanyShell>
  );
}
