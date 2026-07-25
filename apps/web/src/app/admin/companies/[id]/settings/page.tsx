import { redirect } from 'next/navigation';
import {
  getCompanyDetail,
  getMe,
  getSettings,
  throwUnlessFound,
} from '../../../../../lib/server-api';
import { canWriteCompany } from '../../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../../components/shell/page-header';
import { buildTerm } from '../../../../../lib/term';
import { companyCrumbs } from '../../../../../lib/company-crumbs';
import { CompanySettingsForm } from './settings-form';

export default async function CompanySettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const me = await getMe();
  if (!me) redirect('/login');
  const term = buildTerm(await getSettings());
  const companyRes = await getCompanyDetail(id);
  const company = throwUnlessFound(companyRes, `/companies/${id}`);
  if (!canWriteCompany(me, company.id)) redirect(`/admin/companies/${id}`);

  return (
    <>
      <PageHeader
        crumbs={companyCrumbs(term, company, { label: 'Settings' })}
        title={`${company.name} · Settings`}
        description={`Edit identity, contact, address, and notes for this ${term.one.toLowerCase()}.`}
      />
      <PageBody>
        <CompanySettingsForm company={company} />
      </PageBody>
    </>
  );
}
