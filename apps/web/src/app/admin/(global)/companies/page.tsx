import {
  requireMe,
  getSettings,
  serverApiFetch,
  type CompanyPage,
} from '../../../../lib/server-api';
import { hasCapability } from '../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Panel, Tag } from '../../../../components/ui';
import { buildTerm, lower } from '../../../../lib/term';
import { CompaniesTable } from './companies-table';
import { CreateCompanyButton } from './create-company-button';

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; showArchived?: string }>;
}) {
  const sp = await searchParams;
  const me = await requireMe();
  const manage = hasCapability(me, 'COMPANY_MANAGE');
  const term = buildTerm(await getSettings());
  const params = new URLSearchParams();
  params.set('limit', '200');
  if (sp.showArchived === '1') params.set('includeArchived', 'true');
  if (sp.q) params.set('q', sp.q);
  const res = await serverApiFetch<CompanyPage>(`/companies?${params.toString()}`);
  const items = res.data?.items ?? [];

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Admin', href: '/admin' },
          { label: term.other },
        ]}
        title={term.other}
        description={`Every tenant the operator team manages. Archive a ${lower(
          term.one,
        )} to remove it from portal navigation without deleting its data.`}
        actions={manage ? <CreateCompanyButton /> : null}
      />
      <PageBody>
        <Panel
          title={
            <span>
              {items.length}{' '}
              {items.length === 1 ? lower(term.one) : lower(term.other)}
              {sp.showArchived === '1' && (
                <Tag tone="outline" style={{ marginLeft: 10 }}>
                  incl. archived
                </Tag>
              )}
            </span>
          }
          noPad
        >
          <CompaniesTable
            rows={items}
            showArchived={sp.showArchived === '1'}
            q={sp.q ?? ''}
            canManage={manage}
          />
        </Panel>
      </PageBody>
    </>
  );
}
