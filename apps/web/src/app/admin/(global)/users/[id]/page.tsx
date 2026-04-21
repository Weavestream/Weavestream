import { notFound } from 'next/navigation';
import {
  getMe,
  serverApiFetch,
  type UserDetail,
} from '../../../../../lib/server-api';
import { canManage, roleLabel } from '../../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../../components/shell/page-header';
import { Panel, Tag } from '../../../../../components/ui';
import { UserActions } from './user-actions';
import { UserMembershipsList } from './user-memberships';

export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const me = (await getMe())!;
  const res = await serverApiFetch<UserDetail>(`/users/${id}`);
  if (!res.ok || !res.data) notFound();
  const user = res.data;
  const manage = canManage(me.role);
  const isSelf = me.id === user.id;

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'Users', href: '/admin/users' },
          { label: user.name },
        ]}
        title={user.name}
        description={user.email}
        actions={manage ? <UserActions user={user} isSelf={isSelf} /> : null}
      />
      <PageBody>
        <Panel title="Account">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: 20,
            }}
          >
            <Row
              label="Global role"
              value={<Tag tone="accent">{roleLabel(user.role)}</Tag>}
            />
            <Row
              label="Status"
              value={
                user.isActive ? (
                  <Tag tone="ok" dot>
                    active
                  </Tag>
                ) : (
                  <Tag tone="warn" dot>
                    deactivated
                  </Tag>
                )
              }
            />
            <Row
              label="Two-factor"
              value={
                user.mfaEnabled ? (
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
            <Row
              label="Last login"
              value={
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: 'var(--dim)',
                  }}
                >
                  {user.lastLoginAt
                    ? new Date(user.lastLoginAt).toLocaleString()
                    : 'never'}
                </span>
              }
            />
          </div>
        </Panel>
        <Panel title={`Memberships (${user.memberships.filter((m) => !m.revokedAt).length})`} noPad>
          <UserMembershipsList user={user} me={me} canManageUser={manage} />
        </Panel>
      </PageBody>
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
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
