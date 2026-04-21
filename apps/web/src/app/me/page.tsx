import { getMe, serverApiFetch } from '../../lib/server-api';
import { PageBody, PageHeader } from '../../components/shell/page-header';
import { Panel, Tag } from '../../components/ui';
import { roleLabel } from '../../lib/roles';
import { ProfileForm } from './profile-form';
import { PasswordForm } from './password-form';
import { SessionsList } from './sessions-list';
import { AppearanceForm } from './appearance-form';

type Session = {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  current: boolean;
};

export default async function MePage() {
  const me = (await getMe())!;
  const sessionsRes = await serverApiFetch<Session[]>('/me/sessions');
  const sessions = sessionsRes.data ?? [];

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Account', href: '/me' }, { label: 'Profile' }]}
        title="Your profile"
        description="Manage your name, password, and active sessions."
      />
      <PageBody>
        <Panel title="Identity">
          <ProfileForm me={me} />
        </Panel>
        <Panel title="Appearance">
          <p
            style={{
              margin: '0 0 18px',
              fontSize: 12.5,
              color: 'var(--dim)',
              maxWidth: 560,
            }}
          >
            Personalize how Weavestream looks on this account. Changes sync across every browser you sign in on.
          </p>
          <AppearanceForm initial={me.preferences} />
        </Panel>
        <Panel title="Security">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: 20,
              marginBottom: 20,
            }}
          >
            <Field label="Role" value={<Tag tone="accent">{roleLabel(me.role)}</Tag>} />
            <Field
              label="Two-factor"
              value={
                me.mfaEnabled ? (
                  <Tag tone="ok" dot>
                    enabled
                  </Tag>
                ) : (
                  <Tag tone="warn" dot>
                    pending
                  </Tag>
                )
              }
            />
            <Field
              label="Enrolled at"
              value={
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: 'var(--dim)',
                  }}
                >
                  {me.mfaEnforcementCompletedAt
                    ? new Date(me.mfaEnforcementCompletedAt).toLocaleString()
                    : 'never'}
                </span>
              }
            />
          </div>
          <PasswordForm />
        </Panel>
        <Panel title={`Active sessions (${sessions.length})`} noPad>
          <SessionsList sessions={sessions} />
        </Panel>
      </PageBody>
    </>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'var(--muted)',
          letterSpacing: 0.6,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 13.5, color: 'var(--text)' }}>{value}</span>
    </div>
  );
}
