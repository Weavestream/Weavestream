import { notFound, redirect } from 'next/navigation';
import {
  getMe,
  getSettings,
  serverApiFetch,
  type CompanyDetail,
} from '../../../../../lib/server-api';
import { canManage } from '../../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../../components/shell/page-header';
import { buildTerm } from '../../../../../lib/term';
import { CompanySettingsForm } from './settings-form';

export default async function CompanySettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const me = await getMe();
  if (!me) redirect('/login');
  if (!canManage(me.role)) redirect(`/admin/companies/${id}`);

  const term = buildTerm(await getSettings());
  const companyRes = await serverApiFetch<CompanyDetail>(`/companies/${id}`);
  if (!companyRes.ok || !companyRes.data) notFound();
  const company = companyRes.data;

  return (
    <>
      <PageHeader
        crumbs={[
          { label: term.other, href: '/admin/companies' },
          { label: company.name, href: `/admin/companies/${id}` },
          { label: 'Settings' },
        ]}
        title={`${company.name} · Settings`}
        description={`Edit identity, contact, address, and notes for this ${term.one.toLowerCase()}.`}
      />
      <PageBody>
        <CompanySettingsForm company={company} />
      </PageBody>
    </>
  );
}
