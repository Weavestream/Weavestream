import { redirect } from 'next/navigation';
import { getMe, getSettings } from '../../../../lib/server-api';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Panel } from '../../../../components/ui';
import { SettingsForm } from './settings-form';

/**
 * Workspace + tenant-term configuration. The fields here are cosmetic —
 * URL routes, Prisma column names, and RBAC keys all continue to read
 * "company" under the hood. Only SUPER_ADMIN may land here; operators
 * get bounced to the admin dashboard to avoid a CTA that would 403 on
 * submit anyway.
 */
export default async function SettingsPage() {
  const me = (await getMe())!;
  if (me.role !== 'SUPER_ADMIN') redirect('/admin');

  const settings = await getSettings();

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'Settings' },
        ]}
        title="Workspace settings"
        description="Rename the workspace and pick the terminology that fits your organization. Changes take effect on the next page load for every user."
      />
      <PageBody>
        <Panel title="Branding & terminology">
          <SettingsForm initial={settings} />
        </Panel>
      </PageBody>
    </>
  );
}
