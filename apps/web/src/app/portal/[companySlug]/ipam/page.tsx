import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

export const metadata: Metadata = { title: 'IPAM' };

import { getMe, listSubnets } from '../../../../lib/server-api';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Panel } from '../../../../components/ui';
import { SubnetList } from './subnet-list';

export default async function PortalIpamPage({
  params,
}: {
  params: Promise<{ companySlug: string }>;
}) {
  const { companySlug } = await params;
  const me = (await getMe())!;
  const membership = me.memberships.find((m) => m.company.slug === companySlug);
  if (!membership) notFound();
  const companyId = membership.company.id;

  const subnets = await listSubnets(companyId);

  return (
    <>
      <PageHeader
        crumbs={[{ label: membership.company.name }, { label: 'IPAM' }]}
        title="IPAM"
        description="IPv4 subnet overview for this company."
      />
      <PageBody>
        <Panel
          title={
            <span>
              {subnets.length} subnet{subnets.length === 1 ? '' : 's'}
            </span>
          }
          noPad
        >
          {subnets.length === 0 ? (
            <div
              style={{
                padding: 32,
                textAlign: 'center',
                color: 'var(--muted)',
                fontSize: 13,
              }}
            >
              No subnets configured for this company.
            </div>
          ) : (
            <SubnetList items={subnets} companySlug={companySlug} />
          )}
        </Panel>
      </PageBody>
    </>
  );
}
