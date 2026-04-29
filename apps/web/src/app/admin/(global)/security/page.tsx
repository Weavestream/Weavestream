import { redirect } from 'next/navigation';
import {
  getMe,
  getSecurityEgressBlocks,
  getSecurityLockouts,
  getSecurityLoginActivity,
  getSecuritySessions,
  getSecurityThrottleBlocks,
} from '../../../../lib/server-api';
import { hasCapability } from '../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Panel, Stat } from '../../../../components/ui';
import { SecurityCenterClient } from './security-client';

/**
 * Admin Security Center.
 *
 * Server-rendered first paint stitches together four read endpoints
 * in parallel, then hands every slice to a client component for
 * interactive tabs and the (optional) session-revoke action. The
 * server does not pre-filter what the client can revoke — that's
 * gated by the same `user.manage` capability the API already checks
 * on `DELETE /security/sessions/:id`, surfaced here as `canRevoke`.
 */
export default async function SecurityCenterPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; window?: string }>;
}) {
  const me = (await getMe())!;
  if (!hasCapability(me, 'SECURITY_READ')) redirect('/admin');

  const sp = await searchParams;
  const requestedWindow = parseWindow(sp.window);

  const [activity, lockouts, blocks, sessions, egress] = await Promise.all([
    getSecurityLoginActivity(requestedWindow),
    getSecurityLockouts(),
    getSecurityThrottleBlocks(),
    getSecuritySessions(),
    getSecurityEgressBlocks(168),
  ]);

  const lockedIp = (lockouts?.ip ?? []).filter((r) => r.locked).length;
  const lockedEmail = (lockouts?.email ?? []).filter((r) => r.locked).length;
  const blockCount = blocks?.length ?? 0;
  const sessionCount = sessions?.length ?? 0;
  const egressCount = egress?.total ?? 0;
  const totalFailures =
    (activity?.counts.failure ?? 0) + (activity?.counts.mfaFailure ?? 0);

  const canRevoke = hasCapability(me, 'USER_MANAGE');

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Admin', href: '/admin' }, { label: 'Security' }]}
        title="Security center"
        description="Live view of authentication failures, account lockouts, rate-limit blocks, and active sessions."
      />
      <PageBody>
        <Panel
          title={`Last ${activity?.windowHours ?? requestedWindow}h overview`}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: 18,
              padding: 4,
            }}
          >
            <Stat
              label="Logins"
              value={activity?.counts.success ?? 0}
              delta="successful"
            />
            <Stat
              label="Failures"
              value={totalFailures}
              delta={
                activity?.counts.mfaFailure
                  ? `${activity.counts.mfaFailure} MFA · ${activity.counts.failure} pwd`
                  : 'password + MFA'
              }
            />
            <Stat
              label="Locked IPs"
              value={lockedIp}
              delta={
                lockouts ? `${lockouts.ip.length} tracked` : '—'
              }
            />
            <Stat
              label="Locked emails"
              value={lockedEmail}
              delta={
                lockouts ? `${lockouts.email.length} tracked` : '—'
              }
            />
            <Stat
              label="Rate blocks"
              value={blockCount}
              delta="active"
            />
            <Stat
              label="Sessions"
              value={sessionCount}
              delta="non-revoked"
            />
            <Stat
              label="Egress blocks"
              value={egressCount}
              delta={egress ? `${egress.windowHours}h window` : '—'}
            />
          </div>
        </Panel>

        <SecurityCenterClient
          initialTab={parseTab(sp.tab)}
          initialWindow={requestedWindow}
          activity={activity}
          lockouts={lockouts}
          blocks={blocks}
          sessions={sessions}
          egress={egress}
          canRevoke={canRevoke}
          currentUserId={me.id}
        />
      </PageBody>
    </>
  );
}

function parseWindow(raw: string | undefined): number {
  const n = raw ? parseInt(raw, 10) : 24;
  if (!Number.isFinite(n) || n < 1) return 24;
  return Math.min(n, 168);
}

const VALID_TABS = ['logins', 'lockouts', 'blocks', 'sessions', 'egress'] as const;
type TabId = (typeof VALID_TABS)[number];

function parseTab(raw: string | undefined): TabId {
  if (raw && (VALID_TABS as readonly string[]).includes(raw)) {
    return raw as TabId;
  }
  return 'logins';
}
