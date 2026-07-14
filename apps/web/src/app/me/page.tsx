import { requireMe, serverApiFetch } from '../../lib/server-api';
import { PageBody, PageHeader } from '../../components/shell/page-header';
import { Panel } from '../../components/ui';
import { MeTabs } from './me-tabs';

type Session = {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  current: boolean;
};

const VALID_TABS = ['profile', 'memberships', 'appearance', 'security', 'sessions'] as const;
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

  const initialTab: TabId = VALID_TABS.includes(sp.tab as TabId)
    ? (sp.tab as TabId)
    : 'profile';

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Account', href: '/me' }, { label: 'Profile' }]}
        title="Your profile"
        description="Manage your profile, memberships, security, and active sessions."
      />
      <PageBody>
        <Panel noPad>
          <MeTabs initialTab={initialTab} me={me} sessions={sessions} />
        </Panel>
      </PageBody>
    </>
  );
}
