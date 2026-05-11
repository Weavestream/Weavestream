import { redirect } from 'next/navigation';
import {
  getAiSettings,
  getEmailSettings,
  getMe,
  getSettings,
} from '../../../../lib/server-api';
import { hasCapability } from '../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Panel } from '../../../../components/ui';
import { SettingsTabs } from './settings-tabs';

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
  const me = (await getMe())!;
  if (!hasCapability(me, 'SETTINGS_MANAGE')) redirect('/admin');

  const [settings, emailSettings, aiSettings] = await Promise.all([
    getSettings(),
    getEmailSettings(),
    getAiSettings(),
  ]);

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'Settings' },
        ]}
        title="Workspace settings"
        description="Manage workspace defaults, security options, and SMTP email delivery."
      />
      <PageBody>
        <Panel noPad>
          <SettingsTabs
            initialTab={
              (sp.tab as 'general' | 'security' | 'email' | 'ai') ?? 'general'
            }
            settings={settings}
            emailSettings={emailSettings}
            aiSettings={aiSettings}
            currentUserEmail={me.email}
          />
        </Panel>
      </PageBody>
    </>
  );
}
