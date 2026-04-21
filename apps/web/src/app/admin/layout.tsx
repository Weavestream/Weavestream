import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getMe } from '../../lib/server-api';
import { isOperator } from '../../lib/roles';

/**
 * Auth-only gate for the entire `/admin` tree. Shell selection is handled
 * by nested layouts:
 *   - `/admin/(global)/layout.tsx` renders the `AdminShell` for global pages
 *   - `/admin/companies/[id]/layout.tsx` renders the `CompanyShell` for
 *     company-scoped pages
 * Using route groups (rather than a runtime pathname check) ensures the
 * correct shell is picked up across client-side navigations, since Next's
 * app router caches layout output per segment boundary.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  if (!cookieStore.get('ws_session')) redirect('/login');

  const me = await getMe();
  if (!me) redirect('/login');
  if (!isOperator(me.role)) redirect('/');

  return <>{children}</>;
}
