import {
  requireMe,
  getSettings,
  serverApiFetch,
  type AuditPage,
  type CompanyPage,
} from '../../../../lib/server-api';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Panel } from '../../../../components/ui';
import { buildTerm, lower } from '../../../../lib/term';
import { redirect } from 'next/navigation';
import { AuditTable } from './audit-table';

const PAGE_SIZE_OPTIONS = [25, 50, 100];
const DEFAULT_PAGE_SIZE = 50;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    companyId?: string;
    action?: string;
    from?: string;
    to?: string;
    page?: string;
    pageSize?: string;
  }>;
}) {
  const me = await requireMe();
  const sp = await searchParams;
  const term = buildTerm(await getSettings());

  const requestedPage = parsePage(sp.page);
  const pageSize = parsePageSize(sp.pageSize);

  const [companiesRes, auditRes] = await Promise.all([
    serverApiFetch<CompanyPage>('/companies?limit=200&includeArchived=true'),
    fetchAudit(me.role, sp, requestedPage, pageSize),
  ]);

  const companies = companiesRes.data?.items ?? [];
  const rows = auditRes?.items ?? [];
  const total = auditRes?.total ?? 0;
  const page =
    auditRes != null && typeof auditRes.page === 'number' ? auditRes.page : requestedPage;

  if (
    auditRes != null &&
    typeof auditRes.page === 'number' &&
    auditRes.page !== requestedPage
  ) {
    const q = searchParamsToURLSearchParams(sp);
    if (auditRes.page <= 1) q.delete('page');
    else q.set('page', String(auditRes.page));
    redirect(`/admin/audit?${q.toString()}`);
  }

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'Audit log' },
        ]}
        title="Audit log"
        description={
          me.role === 'SUPER_ADMIN'
            ? 'Every auditable action across every tenant.'
            : `Auditable actions for ${lower(term.other)} you manage. Pick a ${lower(term.one)} to view its log.`
        }
      />
      <PageBody>
        <Panel title={`${total.toLocaleString()} event${total === 1 ? '' : 's'}`} noPad>
          <AuditTable
            rows={rows}
            filters={sp}
            page={page}
            pageSize={pageSize}
            total={total}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            companies={companies.map((c) => ({
              id: c.id,
              name: c.name,
              slug: c.slug,
            }))}
            requireCompany={me.role !== 'SUPER_ADMIN'}
          />
        </Panel>
      </PageBody>
    </>
  );
}

function parsePage(raw: string | undefined): number {
  const n = raw ? parseInt(raw, 10) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function parsePageSize(raw: string | undefined): number {
  const n = raw ? parseInt(raw, 10) : DEFAULT_PAGE_SIZE;
  if (!Number.isFinite(n)) return DEFAULT_PAGE_SIZE;
  return PAGE_SIZE_OPTIONS.includes(n) ? n : DEFAULT_PAGE_SIZE;
}

function searchParamsToURLSearchParams(sp: {
  [key: string]: string | string[] | undefined;
}): URLSearchParams {
  const q = new URLSearchParams();
  for (const [key, val] of Object.entries(sp)) {
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      for (const v of val) q.append(key, v);
    } else {
      q.set(key, val);
    }
  }
  return q;
}

async function fetchAudit(
  role: string,
  sp: { companyId?: string; action?: string; from?: string; to?: string },
  page: number,
  pageSize: number,
) {
  // Non-super admins need a companyId. Don't even hit the endpoint without one.
  if (role !== 'SUPER_ADMIN' && !sp.companyId) return null;
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));
  if (sp.companyId) params.set('companyId', sp.companyId);
  if (sp.action) params.set('action', sp.action);
  if (sp.from) params.set('from', sp.from);
  if (sp.to) params.set('to', sp.to);
  const res = await serverApiFetch<AuditPage>(`/audit?${params.toString()}`);
  return res.ok ? res.data : null;
}
