import { redirect } from 'next/navigation';
import { getMe, getSettings } from '../../../../lib/server-api';
import { hasCapability } from '../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Panel } from '../../../../components/ui';
import { SettingsForm } from './settings-form';

/**
 * Workspace + tenant-term configuration. The fields here are cosmetic —
 * URL routes, Prisma column names, and RBAC keys all continue to read
 * "company" under the hood. Gated by SETTINGS_MANAGE so a senior
 * operator can rebrand without needing the SUPER_ADMIN role.
 */
export default async function SettingsPage() {
  const me = (await getMe())!;
  if (!hasCapability(me, 'SETTINGS_MANAGE')) redirect('/admin');

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
