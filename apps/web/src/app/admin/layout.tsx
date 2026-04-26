import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getMe } from '../../lib/server-api';
import { canAccessAdminShell, isOperator } from '../../lib/roles';

/**
 * Auth-only gate for the entire `/admin` tree. Shell selection is handled
 * by nested layouts:
 *   - `/admin/(global)/layout.tsx` renders the `AdminShell` for global pages
 *   - `/admin/companies/[id]/layout.tsx` renders the `CompanyShell` for
 *     company-scoped pages
 * Using route groups (rather than a runtime pathname check) ensures the
 * correct shell is picked up across client-side navigations, since Next's
 * app router caches layout output per segment boundary.
 *
 * RBAC v2 — `isOperator` keeps CONTRACTOR/CLIENT_USER out of `/admin`
 * entirely; `canAccessAdminShell` additionally redirects an operator
 * with `globalAccess=NONE` and no platform capabilities, since that
 * operator's admin shell would be a dashboard with nothing actionable
 * on it. Their landing page will instead be the portal for whichever
 * company membership they hold.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  if (!cookieStore.get('ws_session')) redirect('/login');

  const me = await getMe();
  if (!me) redirect('/login');
  if (!isOperator(me.role)) redirect('/');
  if (!canAccessAdminShell(me)) redirect('/');

  return <>{children}</>;
}
