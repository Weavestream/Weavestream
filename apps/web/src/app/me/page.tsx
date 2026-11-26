import { requireMe } from '../../lib/server-api/auth';
import { serverApiFetch } from '../../lib/server-api/core';
import { getSettings } from '../../lib/server-api/settings';
import { PageBody, PageHeader } from '../../components/shell/page-header';
import { Panel } from '../../components/ui';
import { MeTabs } from './me-tabs';
import type { ApiKeySummary, McpConnectionSummary } from '@weavestream/shared';
import type { SsoLinkStatus } from './sso-link';

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
  'ai-connections',
] as const;
type TabId = (typeof VALID_TABS)[number];

export default async function MePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; sso?: string | string[] }>;
}) {
  const sp = await searchParams;
  const me = await requireMe();
  const sessionsRes = await serverApiFetch<Session[]>('/me/sessions');
  const sessions = sessionsRes.data ?? [];
  const apiKeysRes = await serverApiFetch<ApiKeySummary[]>('/me/api-keys');
  const apiKeys = apiKeysRes.ok ? (apiKeysRes.data ?? []) : [];
  const connectionsRes = await serverApiFetch<McpConnectionSummary[]>('/me/mcp-connections');
  const connections = connectionsRes.ok ? (connectionsRes.data ?? []) : [];
  // Single sign-on: shown only when the instance has it on. A failed lookup
  // hides the section rather than blocking the page.
  const ssoRes = await serverApiFetch<SsoLinkStatus>('/auth/sso/link/status');
  const sso = ssoRes.ok && ssoRes.data?.enabled === true ? ssoRes.data : null;
  const ssoResult = typeof sp.sso === 'string' && sp.sso !== '' ? sp.sso : null;
  // Request-scoped cache: the root layout already loaded settings.
  const { apiKeysEnabled, mcpRemoteEnabled, mcpClientPolicy } = await getSettings();

  // The link callback returns to `/me?sso=<result>`: land where the result is shown.
  const initialTab: TabId = VALID_TABS.includes(sp.tab as TabId)
    ? (sp.tab as TabId)
    : ssoResult !== null
      ? 'security'
      : 'profile';

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Account', href: '/me' }, { label: 'Profile' }]}
        title="Your profile"
        description="Manage your profile, memberships, security, sessions, API keys, and AI connections."
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
            connections={connections}
            connectionsLoadFailed={!connectionsRes.ok}
            mcpRemoteEnabled={mcpRemoteEnabled}
            mcpClientPolicy={mcpClientPolicy}
            sso={sso}
            ssoResult={ssoResult}
          />
        </Panel>
      </PageBody>
    </>
  );
}
