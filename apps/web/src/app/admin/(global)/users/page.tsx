import { getMe, serverApiFetch, type UserPage } from '../../../../lib/server-api';
import { canManage } from '../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Panel } from '../../../../components/ui';
import { UsersTable } from './users-table';
import { CreateUserButton } from './create-user-button';

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; role?: string; isActive?: string }>;
}) {
  const sp = await searchParams;
  const me = (await getMe())!;
  const params = new URLSearchParams();
  params.set('limit', '200');
  if (sp.q) params.set('q', sp.q);
  if (sp.role) params.set('role', sp.role);
  if (sp.isActive) params.set('isActive', sp.isActive);
  const res = await serverApiFetch<UserPage>(`/users?${params.toString()}`);
  const rows = res.data?.items ?? [];

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'Users' },
        ]}
        title="Users"
        description="Every person with an account in Weavestream. Creating a user generates a one-time setup link; the user sets their own password and enables MFA."
        actions={canManage(me.role) ? <CreateUserButton /> : null}
      />
      <PageBody>
        <Panel title={`${rows.length} ${rows.length === 1 ? 'user' : 'users'}`} noPad>
          <UsersTable rows={rows} filters={sp} canManage={canManage(me.role)} />
        </Panel>
      </PageBody>
    </>
  );
}
