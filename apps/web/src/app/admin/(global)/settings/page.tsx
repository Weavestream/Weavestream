import { redirect } from 'next/navigation';
import { requireMe } from '../../../../lib/server-api/auth';
import {
  getAiSettings,
  getEmailSettings,
  getIntegrationPriority,
  getSettings,
} from '../../../../lib/server-api/settings';
import { hasCapability } from '../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Panel } from '../../../../components/ui';
import { SettingsTabs } from './settings-tabs';
import { resolveSettingsTab } from './tab-ids';

/**
 * Workspace + tenant-term configuration. The fields here are cosmetic —
 * URL routes, Prisma column names, and RBAC keys all continue to read
 * "company" under the hood. Gated by SETTINGS_MANAGE so a senior
 * operator can rebrand without needing the SUPER_ADMIN role.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const sp = await searchParams;
  const me = await requireMe();
  if (!hasCapability(me, 'SETTINGS_MANAGE')) redirect('/admin');

  const [settings, emailSettings, aiSettings, integrationPriority] = await Promise.all([
    getSettings(),
    getEmailSettings(),
    getAiSettings(),
    getIntegrationPriority(),
  ]);

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'Settings' },
        ]}
        title="Workspace settings"
        description="Manage workspace defaults, password generator defaults, SMTP email delivery, integration priority, and API access."
      />
      <PageBody>
        <Panel noPad>
          <SettingsTabs
            initialTab={resolveSettingsTab(sp.tab)}
            settings={settings}
            emailSettings={emailSettings}
            aiSettings={aiSettings}
            integrationPriority={integrationPriority}
            currentUserEmail={me.email}
          />
        </Panel>
      </PageBody>
    </>
  );
}
