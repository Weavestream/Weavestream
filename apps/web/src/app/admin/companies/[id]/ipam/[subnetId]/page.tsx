import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  getCompanyDetail,
  getMe,
  getSettings,
  getSubnetDetail,
  throwUnlessFound,
} from '../../../../../../lib/server-api';
import { canWriteCompany } from '../../../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../../../components/shell/page-header';
import { Panel, Tag } from '../../../../../../components/ui';
import { buildTerm } from '../../../../../../lib/term';
import { companyCrumbs, companyBaseHref } from '../../../../../../lib/company-crumbs';
import { SubnetDetailView } from './subnet-detail-view';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string; subnetId: string }>;
}): Promise<Metadata> {
  const { id, subnetId } = await params;
  const detail = await getSubnetDetail(id, subnetId);
  return { title: detail?.subnet.name ?? 'Subnet' };
}

export default async function SubnetDetailPage({
  params,
}: {
  params: Promise<{ id: string; subnetId: string }>;
}) {
  const { id: companyId, subnetId } = await params;
  const me = (await getMe())!;
  const term = buildTerm(await getSettings());

  const companyRes = await getCompanyDetail(companyId);
  const company = throwUnlessFound(companyRes, `/companies/${companyId}`);

  const detail = await getSubnetDetail(companyId, subnetId);
  if (!detail) notFound();

  const canManage = canWriteCompany(me, company.id);
  const base = companyBaseHref(company);

  return (
    <>
      <PageHeader
        crumbs={companyCrumbs(
          term,
          company,
          { label: 'IPAM', href: `${base}/ipam` },
          { label: detail.subnet.name },
        )}
        title={
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {detail.subnet.name}
            <Tag tone="outline" style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
              {detail.subnet.cidr}
            </Tag>
            {detail.subnet.archivedAt && <Tag tone="outline">archived</Tag>}
          </span>
        }
        description={detail.subnet.description}
      />
      <PageBody>
        <SubnetDetailView
          companyId={companyId}
          detail={detail}
          canManage={canManage}
        />
      </PageBody>
    </>
  );
}
