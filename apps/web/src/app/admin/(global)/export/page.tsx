import { redirect } from 'next/navigation';
import { getMe } from '../../../../lib/server-api';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { ExportWizard } from './export-wizard';

/**
 * Global data-export tools page. Restricted to SUPER_ADMIN — operators
 * cannot access this page because the PDF export may contain plaintext
 * passwords and other sensitive data.
 */
export default async function ExportPage() {
  const me = (await getMe())!;
  if (me.role !== 'SUPER_ADMIN') redirect('/admin');

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Admin', href: '/admin' }, { label: 'Export' }]}
        title="Data export"
        description="Export company vault data or create a database backup. Exported files are ephemeral and deleted automatically."
      />
      <PageBody>
        <ExportWizard />
      </PageBody>
    </>
  );
}
