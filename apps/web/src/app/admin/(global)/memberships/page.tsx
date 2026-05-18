import { redirect } from 'next/navigation';
import type { MembershipRole } from '@weavestream/shared';
import { getMe, serverApiFetch } from '../../../../lib/server-api';
import { hasCapability } from '../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Panel, Tag } from '../../../../components/ui';
import { MembershipsTable } from './memberships-table';

type Listing = {
  items: Array<{
    id: string;
    role: MembershipRole;
    expiresAt: string | null;
    createdAt: string;
    user: { id: string; name: string; email: string; role: string };
    company: { id: string; name: string; slug: string };
  }>;
  nextCursor: string | null;
};

export default async function MembershipsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    role?: string;
    expired?: string;
    expiringWithinDays?: string;
  }>;
}) {
  const me = (await getMe())!;
  if (!hasCapability(me, 'MEMBERSHIP_MANAGE')) {
    // Operators without MEMBERSHIP_MANAGE still see scoped memberships
    // through each company's Users tab; the global view is gated.
    redirect('/admin/companies');
  }
  const sp = await searchParams;
  const params = new URLSearchParams();
  params.set('limit', '200');
  if (sp.q) params.set('q', sp.q);
  if (sp.role) params.set('role', sp.role);
  if (sp.expired === '1') params.set('expired', 'true');
  if (sp.expiringWithinDays) params.set('expiringWithinDays', sp.expiringWithinDays);
  const res = await serverApiFetch<Listing>(`/memberships?${params.toString()}`);
  const rows = res.data?.items ?? [];

  const expiringCount = rows.filter((r) => {
    if (!r.expiresAt) return false;
    const days = (new Date(r.expiresAt).getTime() - Date.now()) / 86_400_000;
    return days > 0 && days <= 14;
  }).length;
  const expiredCount = rows.filter(
    (r) => r.expiresAt && new Date(r.expiresAt).getTime() <= Date.now(),
  ).length;

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'Memberships' },
        ]}
        title="All memberships"
        description="Cross-tenant view of who has access where. Use filters to surface contractor expirations before they become access issues."
      />
      <PageBody>
        <Panel
          title={
            <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
              {rows.length} active
              {expiringCount > 0 && (
                <Tag tone="warn">
                  {expiringCount} expiring ≤14d
                </Tag>
              )}
              {expiredCount > 0 && (
                <Tag tone="danger">
                  {expiredCount} expired
                </Tag>
              )}
            </span>
          }
          noPad
        >
          <MembershipsTable rows={rows} filters={sp} />
        </Panel>
      </PageBody>
    </>
  );
}
