import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireMe } from '../../../../lib/server-api/auth';
import { listExpirations } from '../../../../lib/server-api/admin';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Panel, Tag } from '../../../../components/ui';
import { ExpirationsTable } from '../../../../components/expirations/expirations-table';

export const metadata: Metadata = { title: 'Expiring soon' };

/**
 * Cross-tenant "Expiring soon" feed. Mirrors the per-company page
 * but aggregates across every company the caller can see. SUPER_ADMIN
 * only — operators can still reach the scoped variant from each
 * company shell, but a flat cross-tenant view of everyone's warranty
 * dates is a legitimate SUPER_ADMIN-only affordance (see the matching
 * guard on `/domains/alerts`).
 */
export default async function GlobalExpirationsPage({
  searchParams,
}: {
  searchParams: Promise<{ dismissed?: string }>;
}) {
  const showDismissed = (await searchParams).dismissed === '1';
  const me = await requireMe();
  if (me.role !== 'SUPER_ADMIN') {
    redirect('/admin');
  }
  const rows = await listExpirations(undefined, showDismissed);
  const active = rows.filter((r) => !r.dismissal);
  const expiredCount = active.filter((r) => r.status === 'EXPIRED').length;

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
              {active.length} item{active.length === 1 ? '' : 's'}
              {expiredCount > 0 && <Tag tone="danger">{expiredCount} expired</Tag>}
              <DismissedToggle href="/admin/expirations" showing={showDismissed} />
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

function DismissedToggle({ href, showing }: { href: string; showing: boolean }) {
  return (
    <Link href={showing ? href : `${href}?dismissed=1`} style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 400 }}>
      {showing ? 'Hide dismissed' : 'Show dismissed'}
    </Link>
  );
}
