import type { Metadata } from 'next';
import { getSettings } from '../../../../../lib/server-api/settings';
import { getCompanyDetail } from '../../../../../lib/server-api/companies';
import { listExpirations } from '../../../../../lib/server-api/admin';
import { throwUnlessFound } from '../../../../../lib/server-api/core';
import { PageBody, PageHeader } from '../../../../../components/shell/page-header';
import { Panel, Tag } from '../../../../../components/ui';
import { buildTerm, lower } from '../../../../../lib/term';
import { companyCrumbs } from '../../../../../lib/company-crumbs';
import { ExpirationsTable } from '../../../../../components/expirations/expirations-table';
import { DismissedToggle } from '../../../../../components/expirations/dismissed-toggle';

export const metadata: Metadata = { title: 'Expiring soon' };

/**
 * Per-company "Expiring soon" page. Single table that combines
 * asset-field expiries (DATE/DATETIME fields flagged `isExpiry`) with
 * registrar + TLS cert expirations from monitored domains. Ordered by
 * imminence — expired rows appear first, then the soonest upcoming.
 */
export default async function CompanyExpirationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ dismissed?: string }>;
}) {
  const { id: companyId } = await params;
  const showDismissed = (await searchParams).dismissed === '1';
  const term = buildTerm(await getSettings());

  const companyRes = await getCompanyDetail(companyId);
  const company = throwUnlessFound(companyRes, `/companies/${companyId}`);

  const rows = await listExpirations(companyId, showDismissed);
  const active = rows.filter((r) => !r.dismissal);
  const expiredCount = active.filter((r) => r.status === 'EXPIRED').length;

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
            <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {active.length} item{active.length === 1 ? '' : 's'}
              {expiredCount > 0 && <Tag tone="danger">{expiredCount} expired</Tag>}
              <DismissedToggle
                href={`/admin/companies/${companyId}/expirations`}
                showing={showDismissed}
              />
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
