import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getMe } from '../lib/server-api';
import { canAccessAdminShell, preferredMembership } from '../lib/roles';

/**
 * Role-based landing:
 *   - Users with admin-shell access (SUPER_ADMIN, or OPERATOR with
 *     either `globalAccess` or any platform capability) land on
 *     `/admin`.
 *   - Everyone else (CONTRACTOR, CLIENT_USER, or a stripped-down
 *     OPERATOR whose access is purely per-company) lands on the
 *     preferred portal — the most recently visited company falling
 *     back to their first active membership.
 *   - No active membership → `/access-pending` so the user lands
 *     somewhere actionable rather than a dead profile.
 */
export default async function Home() {
  const cookieStore = await cookies();
  if (!cookieStore.get('ws_session')) redirect('/login');

  const me = await getMe();
  if (!me) redirect('/login');

  if (canAccessAdminShell(me)) {
    redirect('/admin');
  }

  const lastCompany = cookieStore.get('ws_last_company')?.value ?? null;
  const target = preferredMembership(me, lastCompany);
  if (!target) redirect('/access-pending');
  redirect(`/portal/${target.company.slug}`);
}
