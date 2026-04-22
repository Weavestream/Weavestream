import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  getSettings,
  listExpirations,
  serverApiFetch,
  type CompanyDetail,
} from '../../../../../lib/server-api';
import { PageBody, PageHeader } from '../../../../../components/shell/page-header';
import { Panel, Tag } from '../../../../../components/ui';
import { buildTerm, lower } from '../../../../../lib/term';
import { companyCrumbs } from '../../../../../lib/company-crumbs';
import { ExpirationsTable } from '../../../../../components/expirations/expirations-table';

export const metadata: Metadata = { title: 'Expiring soon' };

/**
 * Per-company "Expiring soon" page. Single table that combines
 * asset-field expiries (DATE/DATETIME fields flagged `isExpiry`) with
 * registrar + TLS cert expirations from monitored domains. Ordered by
 * imminence — expired rows appear first, then the soonest upcoming.
 */
export default async function CompanyExpirationsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: companyId } = await params;
  const term = buildTerm(await getSettings());

  const companyRes = await serverApiFetch<CompanyDetail>(
    `/companies/${companyId}`,
  );
  if (!companyRes.ok || !companyRes.data) notFound();
  const company = companyRes.data;

  const rows = await listExpirations(companyId);
  const expiredCount = rows.filter((r) => r.status === 'EXPIRED').length;

  return (
    <>
      <PageHeader
        crumbs={companyCrumbs(term, company, { label: 'Expiring soon' })}
        title="Expiring soon"
        description={
          <>
            Upcoming and past-due deadlines for this {lower(term.one)} —
            warranty dates, licence renewals, cert expiries, and monitored
            domain renewals in one place.
          </>
        }
      />
      <PageBody>
        <Panel
          title={
            <span>
              {rows.length} item{rows.length === 1 ? '' : 's'}
              {expiredCount > 0 && (
                <Tag tone="danger" style={{ marginLeft: 10 }}>
                  {expiredCount} expired
                </Tag>
              )}
            </span>
          }
          noPad
        >
          <ExpirationsTable rows={rows} showCompany={false} />
        </Panel>
      </PageBody>
    </>
  );
}
