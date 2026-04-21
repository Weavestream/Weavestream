import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getMe } from '../lib/server-api';
import { isOperator, preferredMembership } from '../lib/roles';

/**
 * Role-based landing:
 *   - Operators go to `/admin`.
 *   - Clients with active memberships go to their portal dashboard.
 *     For multi-membership clients we honour the `ws_last_company`
 *     cookie (stamped by middleware whenever they visit a `/portal/:slug`
 *     page) and fall back to their first active membership.
 *   - Clients with no active membership hit `/access-pending`, so they
 *     don't land on a profile-only page with no way forward.
 */
export default async function Home() {
  const cookieStore = await cookies();
  if (!cookieStore.get('ws_session')) redirect('/login');

  const me = await getMe();
  if (!me) redirect('/login');

  if (me.role === 'SUPER_ADMIN' || me.role === 'OPERATOR') {
    redirect('/admin');
  }

  const lastCompany = cookieStore.get('ws_last_company')?.value ?? null;
  const target = preferredMembership(me, lastCompany);
  if (!target) redirect('/access-pending');
  redirect(`/portal/${target.company.slug}`);
}
