import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  getMe,
  getSubnetDetail,
} from '../../../../../lib/server-api';
import { PageBody, PageHeader } from '../../../../../components/shell/page-header';
import { Tag } from '../../../../../components/ui';
import { SubnetDetailView } from '../../../../admin/companies/[id]/ipam/[subnetId]/subnet-detail-view';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ companySlug: string; subnetId: string }>;
}): Promise<Metadata> {
  const { companySlug, subnetId } = await params;
  const me = await getMe();
  const membership = me?.memberships.find((m) => m.company.slug === companySlug);
  if (!membership) return {};
  const detail = await getSubnetDetail(membership.company.id, subnetId);
  return { title: detail?.subnet.name ?? 'Subnet' };
}

export default async function PortalSubnetDetailPage({
  params,
}: {
  params: Promise<{ companySlug: string; subnetId: string }>;
}) {
  const { companySlug, subnetId } = await params;
  const me = (await getMe())!;
  const membership = me.memberships.find((m) => m.company.slug === companySlug);
  if (!membership) notFound();

  const detail = await getSubnetDetail(membership.company.id, subnetId);
  if (!detail) notFound();

  return (
    <>
      <PageHeader
        crumbs={[
          { label: membership.company.name },
          { label: 'IPAM', href: `/portal/${companySlug}/ipam` },
          { label: detail.subnet.name },
        ]}
        title={
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {detail.subnet.name}
            <Tag
              tone="outline"
              style={{
                fontFamily: 'var(--font-mono, monospace)',
                fontSize: 12,
              }}
            >
              {detail.subnet.cidr}
            </Tag>
          </span>
        }
        description={detail.subnet.description}
      />
      <PageBody>
        <SubnetDetailView
          companyId={membership.company.id}
          detail={detail}
          canManage={false}
        />
      </PageBody>
    </>
  );
}
