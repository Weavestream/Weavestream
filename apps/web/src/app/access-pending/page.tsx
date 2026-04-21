import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getMe, getSettings } from '../../lib/server-api';
import { activeMemberships, isOperator } from '../../lib/roles';
import { AuthShell } from '../../components/shell/auth-shell';
import { LogoutButton } from '../../components/shell/logout-button';

/**
 * Holding page for a signed-in client user who has no active (non-
 * expired, non-revoked) company membership. They can't reach any
 * portal surface, so we dead-end them here with enough context to ask
 * an operator for access and a logout affordance.
 *
 * Anyone who *does* have access — operators, or clients with at least
 * one live membership — is bounced back to `/` which re-runs the
 * landing logic.
 */
export default async function AccessPendingPage() {
  const cookieStore = await cookies();
  if (!cookieStore.get('ws_session')) redirect('/login');

  const me = await getMe();
  if (!me) redirect('/login');
  if (isOperator(me.role)) redirect('/admin');
  if (activeMemberships(me).length > 0) redirect('/');

  const settings = await getSettings();
  const tenantPlural = settings.tenantTermPlural.toLowerCase();

  return (
    <AuthShell
      title="Access pending"
      subtitle={
        <>
          Signed in as <strong style={{ color: 'var(--text)' }}>{me.email}</strong>. You don't
          have access to any {tenantPlural} yet — an administrator needs to grant you a
          membership before your dashboard appears.
        </>
      }
      footer={<span>Access will show up automatically on your next sign-in.</span>}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          alignItems: 'center',
          padding: '4px 0 2px',
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: 12.5,
            color: 'var(--muted)',
            textAlign: 'center',
            lineHeight: 1.55,
          }}
        >
          Contact your administrator at{' '}
          <strong style={{ color: 'var(--text)' }}>{settings.workspaceName}</strong> to be
          added to the right {tenantPlural}. Then refresh this page.
        </p>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginTop: 4,
            fontSize: 12,
            color: 'var(--dim)',
          }}
        >
          <span>Not you?</span>
          <LogoutButton />
        </div>
      </div>
    </AuthShell>
  );
}
