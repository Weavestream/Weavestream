import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Domains' };

import {
  getCompanyDetail,
  getCompanyDomainsBasic,
  getMe,
  getSettings,
  listDomains,
  throwUnlessFound,
} from '../../../../../lib/server-api';
import { canWriteCompany } from '../../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../../components/shell/page-header';
import { LayoutSwatch, Panel, Tag } from '../../../../../components/ui';
import { buildTerm, lower } from '../../../../../lib/term';
import { companyCrumbs } from '../../../../../lib/company-crumbs';
import { DomainsBrowser } from './domains-browser';
import { NewDomainAction } from './new-domain-action';

/**
 * Phase 8 — Admin domains list. Operators see every domain (active +
 * archived with `?archived=1`), every status, and inline add/edit/
 * archive controls. The "Check now" button calls the API, which
 * enqueues into BullMQ and blocks until the worker acks.
 */
export default async function CompanyDomainsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: companyId } = await params;
  const sp = await searchParams;
  const me = (await getMe())!;
  const term = buildTerm(await getSettings());

  const companyRes = await getCompanyDetail(companyId);
  const company = throwUnlessFound(companyRes, `/companies/${companyId}`);

  const includeArchived = sp.archived === '1';
  const openNew = sp.new === '1';
  // Default "active only" view reuses the cached list fetched by the
  // layout. Opting in to archived rows hits the un-cached helper since
  // that query is not layout-shared.
  const page = includeArchived
    ? await listDomains(companyId, { includeArchived: true, limit: 200 })
    : await getCompanyDomainsBasic(companyId);

  const manage = canWriteCompany(me, company.id);

  return (
    <>
      <PageHeader
        crumbs={companyCrumbs(term, company, { label: 'Domains' })}
        leading={<LayoutSwatch icon="globe" color="var(--accent)" size={48} />}
        title="Domains"
        description={`WHOIS expiry, SSL/TLS certificate health, and DNS records for this ${lower(
          term.one,
        )}.`}
        actions={manage ? <NewDomainAction /> : null}
      />
      <PageBody>
        <Panel
          title={
            <span>
              {page.items.length} monitored domain
              {page.items.length === 1 ? '' : 's'}
              {includeArchived && (
                <Tag tone="outline" style={{ marginLeft: 10 }}>
                  incl. archived
                </Tag>
              )}
            </span>
          }
          noPad
        >
          <DomainsBrowser
            companyId={companyId}
            rows={page.items}
            canManage={manage}
            openNew={openNew}
          />
        </Panel>
      </PageBody>
    </>
  );
}
