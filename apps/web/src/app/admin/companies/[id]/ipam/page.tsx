import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'IPAM' };

import {
  getCompanyDetail,
  getCompanySubnetsBasic,
  requireMe,
  getSettings,
  throwUnlessFound,
} from '../../../../../lib/server-api';
import { canWriteCompany } from '../../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../../components/shell/page-header';
import { LayoutSwatch, Panel, Tag } from '../../../../../components/ui';
import { buildTerm, lower } from '../../../../../lib/term';
import { companyCrumbs } from '../../../../../lib/company-crumbs';
import { SubnetsBrowser } from './subnets-browser';
import { NewSubnetAction } from './new-subnet-action';

export default async function CompanyIpamPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: companyId } = await params;
  const sp = await searchParams;
  const me = await requireMe();
  const term = buildTerm(await getSettings());

  const companyRes = await getCompanyDetail(companyId);
  const company = throwUnlessFound(companyRes, `/companies/${companyId}`);

  const includeArchived = sp.archived === '1';
  const openNew = sp.new === '1';
  const subnets = includeArchived
    ? await import('../../../../../lib/server-api').then((m) =>
        m.listSubnets(companyId, { includeArchived: true }),
      )
    : await getCompanySubnetsBasic(companyId);

  const manage = canWriteCompany(me, company.id);

  return (
    <>
      <PageHeader
        crumbs={companyCrumbs(term, company, { label: 'IPAM' })}
        leading={<LayoutSwatch icon="network" color="var(--accent)" size={48} />}
        title="IPAM"
        description={`IPv4 subnet management for this ${lower(term.one)}. Subnets auto-discover assets by their IP address fields.`}
        actions={manage ? <NewSubnetAction /> : null}
      />
      <PageBody>
        <Panel
          title={
            <span>
              {subnets.length} subnet{subnets.length === 1 ? '' : 's'}
              {includeArchived && (
                <Tag tone="outline" style={{ marginLeft: 10 }}>
                  incl. archived
                </Tag>
              )}
            </span>
          }
          noPad
          fillHeight
        >
          <SubnetsBrowser
            companyId={companyId}
            rows={subnets}
            canManage={manage}
            openNew={openNew}
          />
        </Panel>
      </PageBody>
    </>
  );
}
