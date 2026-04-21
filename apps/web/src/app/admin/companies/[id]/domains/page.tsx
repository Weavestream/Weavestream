import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

export const metadata: Metadata = { title: 'Domains' };

import {
  getMe,
  getSettings,
  listDomains,
  serverApiFetch,
  type CompanyDetail,
} from '../../../../../lib/server-api';
import { canManage } from '../../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../../components/shell/page-header';
import { Panel, Tag } from '../../../../../components/ui';
import { buildTerm, lower } from '../../../../../lib/term';
import { companyCrumbs } from '../../../../../lib/company-crumbs';
import { DomainsBrowser } from './domains-browser';

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

  const companyRes = await serverApiFetch<CompanyDetail>(
    `/companies/${companyId}`,
  );
  if (!companyRes.ok || !companyRes.data) notFound();
  const company = companyRes.data;

  const includeArchived = sp.archived === '1';
  const page = await listDomains(companyId, {
    includeArchived,
    limit: 200,
  });

  const manage = canManage(me.role);

  return (
    <>
      <PageHeader
        crumbs={companyCrumbs(term, company, { label: 'Domains' })}
        title="Domains"
        description={`WHOIS expiry, SSL/TLS certificate health, and DNS records for this ${lower(
          term.one,
        )}.`}
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
          />
        </Panel>
      </PageBody>
    </>
  );
}
