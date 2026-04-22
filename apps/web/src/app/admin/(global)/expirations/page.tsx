import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getMe, listExpirations } from '../../../../lib/server-api';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Panel, Tag } from '../../../../components/ui';
import { ExpirationsTable } from '../../../../components/expirations/expirations-table';

export const metadata: Metadata = { title: 'Expiring soon' };

/**
 * Cross-tenant "Expiring soon" feed. Mirrors the per-company page
 * but aggregates across every company the caller can see. SUPER_ADMIN
 * only — OPERATOR_FULL can still reach the scoped variant from each
 * company shell, but a flat cross-tenant view of everyone's warranty
 * dates is a legitimate SUPER_ADMIN-only affordance (see the matching
 * guard on `/domains/alerts`).
 */
export default async function GlobalExpirationsPage() {
  const me = (await getMe())!;
  if (me.role !== 'SUPER_ADMIN') {
    redirect('/admin');
  }
  const rows = await listExpirations();
  const expiredCount = rows.filter((r) => r.status === 'EXPIRED').length;

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'Expiring soon' },
        ]}
        title="Expiring soon"
        description="Upcoming and past-due deadlines across every tenant — warranty dates, licence renewals, cert expiries, and monitored domain renewals rolled into one feed."
      />
      <PageBody>
        <Panel
          title={
            <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
              {rows.length} item{rows.length === 1 ? '' : 's'}
              {expiredCount > 0 && (
                <Tag tone="danger" dot>
                  {expiredCount} expired
                </Tag>
              )}
            </span>
          }
          noPad
        >
          <ExpirationsTable rows={rows} showCompany={true} />
        </Panel>
      </PageBody>
    </>
  );
}
