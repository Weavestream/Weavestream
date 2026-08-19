import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Domains' };

import { requireMe, listDomains } from '../../../../lib/server-api';
import { resolvePortalCompany } from '../../../../lib/portal-company';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Icon, LayoutSwatch, Panel } from '../../../../components/ui';
import { DomainList } from './domain-list';

/**
 * Portal — read-only list of the company's domains. The API already
 * filters out non-`visibleToClients` rows for CLIENT_USER, so we just
 * render whatever comes back. No "Check now" / "Edit" / "Archive"
 * controls here: portal users cannot mutate domain state.
 */
export default async function PortalDomainsPage({
  params,
}: {
  params: Promise<{ companySlug: string }>;
}) {
  const { companySlug } = await params;
  const me = await requireMe();
  const company = await resolvePortalCompany(me, companySlug);
  const companyId = company.id;

  const page = await listDomains(companyId, { limit: 100 });

  return (
    <>
      <PageHeader
        crumbs={[
          { label: company.name },
          { label: 'Domains' },
        ]}
        leading={<LayoutSwatch icon="globe" color="var(--accent)" size={48} />}
        title="Domains"
        description="Health of the domains your team uses — WHOIS expiry, SSL/TLS certificate validity, and DNS."
      />
      <PageBody>
        <Panel
          title={
            <span>
              {page.items.length} domain{page.items.length === 1 ? '' : 's'}
            </span>
          }
          noPad
          fillHeight
        >
          {page.items.length === 0 ? <EmptyState /> : <DomainList items={page.items} />}
        </Panel>
      </PageBody>
    </>
  );
}

function EmptyState() {
  return (
    <div
      style={{
        padding: 48,
        textAlign: 'center',
        color: 'var(--muted)',
        fontSize: 13,
      }}
    >
      <div style={{ fontSize: 24, marginBottom: 8 }}>
        <Icon.globe size={24} />
      </div>
      No domains are being tracked for your workspace yet.
    </div>
  );
}
