import { redirect } from 'next/navigation';
import { requireMe } from '../../../../lib/server-api';
import { hasCapability } from '../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { ExportWizard } from './export-wizard';

/**
 * Global data-export tools page. Gated by EXPORT_CREATE — the PDF
 * export may contain plaintext passwords, so we don't grant this to
 * every operator by default, only those an admin has elevated.
 */
export default async function ExportPage() {
  const me = await requireMe();
  if (!hasCapability(me, 'EXPORT_CREATE')) redirect('/admin');

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
