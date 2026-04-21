import {
  getMe,
  getSettings,
  serverApiFetch,
  type AuditPage,
  type CompanyPage,
} from '../../../../lib/server-api';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Panel } from '../../../../components/ui';
import { buildTerm, lower } from '../../../../lib/term';
import { AuditTable } from './audit-table';

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    companyId?: string;
    action?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const me = (await getMe())!;
  const sp = await searchParams;
  const term = buildTerm(await getSettings());

  const [companiesRes, auditRes] = await Promise.all([
    serverApiFetch<CompanyPage>('/companies?limit=200&includeArchived=true'),
    fetchAudit(me.role, sp),
  ]);

  const companies = companiesRes.data?.items ?? [];
  const rows = auditRes?.items ?? [];

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
        <Panel title={`${rows.length} event${rows.length === 1 ? '' : 's'}`} noPad>
          <AuditTable
            rows={rows}
            filters={sp}
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

async function fetchAudit(
  role: string,
  sp: { companyId?: string; action?: string; from?: string; to?: string },
) {
  // Non-super admins need a companyId. Don't even hit the endpoint without one.
  if (role !== 'SUPER_ADMIN' && !sp.companyId) return null;
  const params = new URLSearchParams();
  params.set('limit', '200');
  if (sp.companyId) params.set('companyId', sp.companyId);
  if (sp.action) params.set('action', sp.action);
  if (sp.from) params.set('from', sp.from);
  if (sp.to) params.set('to', sp.to);
  const res = await serverApiFetch<AuditPage>(`/audit?${params.toString()}`);
  return res.ok ? res.data : null;
}
