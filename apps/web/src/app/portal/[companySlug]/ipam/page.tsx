import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'IPAM' };

import { getMe, listSubnets } from '../../../../lib/server-api';
import { resolvePortalCompany } from '../../../../lib/portal-company';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { LayoutSwatch, Panel } from '../../../../components/ui';
import { SubnetList } from './subnet-list';

export default async function PortalIpamPage({
  params,
}: {
  params: Promise<{ companySlug: string }>;
}) {
  const { companySlug } = await params;
  const me = (await getMe())!;
  const company = await resolvePortalCompany(me, companySlug);
  const companyId = company.id;

  const subnets = await listSubnets(companyId);

  return (
    <>
      <PageHeader
        crumbs={[{ label: company.name }, { label: 'IPAM' }]}
        leading={<LayoutSwatch icon="network" color="var(--accent)" size={48} />}
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
