import { requireMe } from '../../lib/server-api/auth';
import { serverApiFetch } from '../../lib/server-api/core';
import { getSettings } from '../../lib/server-api/settings';
import { PageBody, PageHeader } from '../../components/shell/page-header';
import { Panel } from '../../components/ui';
import { MeTabs } from './me-tabs';
import type { ApiKeySummary } from '@weavestream/shared';

type Session = {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  current: boolean;
};

const VALID_TABS = [
  'profile',
  'memberships',
  'appearance',
  'security',
  'sessions',
  'api-keys',
] as const;
type TabId = (typeof VALID_TABS)[number];

export default async function MePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const sp = await searchParams;
  const me = await requireMe();
  const sessionsRes = await serverApiFetch<Session[]>('/me/sessions');
  const sessions = sessionsRes.data ?? [];
  const apiKeysRes = await serverApiFetch<ApiKeySummary[]>('/me/api-keys');
  const apiKeys = apiKeysRes.ok ? (apiKeysRes.data ?? []) : [];
  // Request-scoped cache: the root layout already loaded settings.
  const { apiKeysEnabled } = await getSettings();

  const initialTab: TabId = VALID_TABS.includes(sp.tab as TabId)
    ? (sp.tab as TabId)
    : 'profile';

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Account', href: '/me' }, { label: 'Profile' }]}
        title="Your profile"
        description="Manage your profile, memberships, security, sessions, and API keys."
      />
      <PageBody>
        <Panel noPad>
          <MeTabs
            initialTab={initialTab}
            me={me}
            sessions={sessions}
            apiKeys={apiKeys}
            apiKeysLoadFailed={!apiKeysRes.ok}
            apiKeysEnabled={apiKeysEnabled}
          />
        </Panel>
      </PageBody>
    </>
  );
}
