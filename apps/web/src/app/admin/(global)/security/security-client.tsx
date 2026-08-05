'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import type { ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Btn,
  DataTable,
  Icon,
  Select,
  Tag,
  useToast,
  type DataColumn,
  type TagTone,
} from '../../../../components/ui';
import { apiFetch } from '../../../../lib/api';
import { FormattedDateTime } from '../../../../lib/timezone-context';
import type {
  ConnectionDiagnostics,
  EgressBlockRow,
  EgressBlocksResponse,
  LockoutsResponse,
  LoginActivity,
  SecuritySessionRow,
  ThrottleBlockEntry,
} from '../../../../lib/server-api';

type TabId =
  | 'logins'
  | 'lockouts'
  | 'blocks'
  | 'sessions'
  | 'egress'
  | 'diagnostics';

const TABS: Array<{ id: TabId; label: string; icon: keyof typeof Icon }> = [
  { id: 'logins', label: 'Login activity', icon: 'shield' },
  { id: 'lockouts', label: 'Lockouts', icon: 'lock' },
  { id: 'blocks', label: 'Rate-limit blocks', icon: 'clock' },
  { id: 'sessions', label: 'Active sessions', icon: 'users' },
  { id: 'egress', label: 'Egress blocks', icon: 'globe' },
  { id: 'diagnostics', label: 'Connection', icon: 'network' },
];

const WINDOW_OPTIONS = [
  { value: 1, label: 'Last 1h' },
  { value: 6, label: 'Last 6h' },
  { value: 24, label: 'Last 24h' },
  { value: 72, label: 'Last 72h' },
  { value: 168, label: 'Last 7d' },
];

export function SecurityCenterClient({
  initialTab,
  initialWindow,
  activity,
  lockouts,
  blocks,
  sessions,
  egress,
  canRevoke,
  currentUserId,
}: {
  initialTab: TabId;
  initialWindow: number;
  activity: LoginActivity | null;
  lockouts: LockoutsResponse | null;
  blocks: ThrottleBlockEntry[] | null;
  sessions: SecuritySessionRow[] | null;
  egress: EgressBlocksResponse | null;
  canRevoke: boolean;
  currentUserId: string;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [tab, setTab] = useState<TabId>(initialTab);
  const [pending, startTransition] = useTransition();

  function navigate(next: TabId) {
    setTab(next);
    const params = new URLSearchParams(sp.toString());
    params.set('tab', next);
    router.replace(`/admin/security?${params.toString()}`);
  }

  function setWindow(next: number) {
    const params = new URLSearchParams(sp.toString());
    if (next === 24) params.delete('window');
    else params.set('window', String(next));
    startTransition(() => router.replace(`/admin/security?${params.toString()}`));
  }

  function refresh() {
    startTransition(() => router.refresh());
  }

  return (
    <section
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 6,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '8px 12px',
          borderBottom: '1px solid var(--line)',
          flexWrap: 'wrap',
        }}
      >
        <div
          role="tablist"
          aria-label="Security center"
          style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}
        >
          {TABS.map((t) => {
            const active = t.id === tab;
            const IconCmp = Icon[t.icon];
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={active}
                onClick={() => navigate(t.id)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '8px 12px',
                  fontSize: 13,
                  fontWeight: 500,
                  color: active ? 'var(--text)' : 'var(--muted)',
                  background: active ? 'var(--panel-2)' : 'transparent',
                  border: '1px solid',
                  borderColor: active ? 'var(--line)' : 'transparent',
                  borderRadius: 6,
                  cursor: 'pointer',
                }}
              >
                <IconCmp size={14} />
                {t.label}
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {tab === 'logins' && (
            <Select
              value={String(initialWindow)}
              onChange={(e) => setWindow(parseInt(e.target.value, 10))}
              style={{ width: 140, height: 28 }}
            >
              {WINDOW_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
          <Btn
            kind="ghost"
            onClick={refresh}
            disabled={pending}
            title="Refresh"
            icon={Icon.refresh}
          >
            Refresh
          </Btn>
        </div>
      </div>
      <div style={{ padding: 12 }}>
        {tab === 'logins' && <LoginsPane activity={activity} />}
        {tab === 'lockouts' && <LockoutsPane lockouts={lockouts} />}
        {tab === 'blocks' && <BlocksPane blocks={blocks} />}
        {tab === 'sessions' && (
          <SessionsPane
            sessions={sessions}
            canRevoke={canRevoke}
            currentUserId={currentUserId}
            onRefresh={refresh}
          />
        )}
        {tab === 'egress' && <EgressPane egress={egress} />}
        {tab === 'diagnostics' && <DiagnosticsPane />}
      </div>
    </section>
  );
}

// ─── Connection diagnostics (WS-024) ───────────────────────────────
//
// Unlike every other pane, this data is NOT server-fetched in
// `page.tsx` and handed down as a prop. It is fetched here, in the
// browser, via `apiFetch` — deliberately. The whole point of the panel
// is to show how *this real request* is attributed as it travels the
// browser → proxy.ts → api-proxy.ts → API path, which a server-side
// `serverApiFetch` from within the Next.js process would not reproduce.
function DiagnosticsPane() {
  const [state, setState] = useState<{
    loading: boolean;
    data: ConnectionDiagnostics | null;
    error: boolean;
  }>({ loading: true, data: null, error: false });

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: false }));
    try {
      const res = await apiFetch<ConnectionDiagnostics>('/security/whoami');
      setState({
        loading: false,
        data: res.ok ? res.data : null,
        error: !res.ok || res.data == null,
      });
    } catch {
      // apiFetch rethrows non-abort network errors (proxy/API outage).
      // Surface the "unavailable" state instead of leaving the pane stuck
      // loading with an unhandled rejection.
      setState({ loading: false, data: null, error: true });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const d = state.data;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
          How Weavestream attributed this request. Used to verify client-IP
          resolution behind your proxy topology.
        </p>
        <Btn
          kind="ghost"
          onClick={() => void load()}
          disabled={state.loading}
          title="Re-run"
          icon={Icon.refresh}
        >
          Re-run
        </Btn>
      </div>

      {state.loading && <Empty>Resolving this connection…</Empty>}
      {!state.loading && !d && (
        <Empty>Connection diagnostics are unavailable right now.</Empty>
      )}

      {d && (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: 12,
            }}
          >
            <DiagRow label="Resolved client IP" value={d.resolvedIp} mono />
            <DiagRow
              label="Forwarding trusted"
              value={
                <Tag tone={d.peerTrusted ? 'ok' : 'warn'} mono={false}>
                  {d.peerTrusted ? 'trusted peer' : 'untrusted peer'}
                </Tag>
              }
            />
            <DiagRow label="Socket peer" value={d.socketPeer} mono />
            <DiagRow
              label="TRUST_PROXY_HOPS"
              value={String(d.trustProxyHops)}
              mono
            />
            <DiagRow
              label="X-Forwarded-For (as received)"
              value={d.forwardedForReceived ?? '—'}
              mono
            />
            <DiagRow
              label="Inbound chain (as you presented it)"
              value={d.inboundForwardedFor || '—'}
              mono
            />
          </div>

          {d.interpretation.length > 0 && (
            <div style={{ display: 'grid', gap: 8 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--muted)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.4,
                }}
              >
                Interpretation
              </div>
              <ul
                style={{
                  margin: 0,
                  paddingLeft: 18,
                  display: 'grid',
                  gap: 6,
                  fontSize: 13,
                  color: 'var(--text)',
                }}
              >
                {d.interpretation.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Stacked label/value row — reads cleanly on narrow screens (the label
// sits above the value instead of relying on horizontal space).
function DiagRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gap: 4,
        padding: '10px 12px',
        background: 'var(--panel-2)',
        border: '1px solid var(--line)',
        borderRadius: 6,
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</div>
      <div
        style={{
          fontSize: 13,
          color: 'var(--text)',
          fontFamily: mono ? 'var(--mono, monospace)' : undefined,
          wordBreak: 'break-all',
        }}
      >
        {value}
      </div>
    </div>
  );
}

// ─── Login activity ────────────────────────────────────────────────

function LoginsPane({ activity }: { activity: LoginActivity | null }) {
  if (!activity) {
    return <Empty>Login activity is unavailable right now.</Empty>;
  }
  if (activity.recent.length === 0) {
    return <Empty>No login attempts in this window.</Empty>;
  }
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <BucketTable
        title="By IP"
        rows={activity.byIp}
        empty="No IP activity in this window."
      />
      <BucketTable
        title="By email"
        rows={activity.byEmail}
        empty="No email activity in this window."
      />
      <Subsection title={`Recent activity (${activity.recent.length})`}>
        <DataTable
          columns={recentColumns}
          rows={activity.recent}
          disableSort
          empty="No recent activity."
          renderMobileCard={(r) => (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <strong>{r.action}</strong>
              <span style={{ fontSize: 12, color: 'var(--dim)' }}>
                {r.attemptedEmail ?? r.actor?.email ?? 'unknown'} — {r.ip ?? 'unknown'}
              </span>
              <span style={{ fontSize: 11, color: 'var(--dim)' }}>
                <FormattedDateTime value={r.createdAt} />
              </span>
            </div>
          )}
        />
      </Subsection>
    </div>
  );
}

const recentColumns: DataColumn<LoginActivity['recent'][number]>[] = [
  {
    id: 'when',
    header: 'When',
    width: 200,
    mono: true,
    render: (r) => (
      <span style={{ color: 'var(--dim)', whiteSpace: 'nowrap' }}>
        <FormattedDateTime value={r.createdAt} />
      </span>
    ),
  },
  {
    id: 'action',
    header: 'Action',
    width: 200,
    render: (r) => (
      <Tag tone={loginTone(r.action)}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
          {r.action}
        </span>
      </Tag>
    ),
  },
  {
    id: 'who',
    header: 'Email',
    width: 220,
    render: (r) => (
      <span style={{ color: 'var(--text-2)' }}>
        {r.attemptedEmail ?? r.actor?.email ?? '—'}
      </span>
    ),
  },
  {
    id: 'ip',
    header: 'IP',
    width: 140,
    mono: true,
    render: (r) => <span style={{ color: 'var(--dim)' }}>{r.ip ?? '—'}</span>,
  },
  {
    id: 'ua',
    header: 'User agent',
    render: (r) => (
      <span
        style={{
          color: 'var(--dim)',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          display: 'inline-block',
          maxWidth: 360,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={r.userAgent ?? undefined}
      >
        {r.userAgent ?? '—'}
      </span>
    ),
  },
];

type BucketWithId = LoginActivity['byIp'][number] & { id: string };

function BucketTable({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: LoginActivity['byIp'];
  empty: string;
}) {
  const withId: BucketWithId[] = useMemo(
    () => rows.map((r) => ({ ...r, id: r.identifier })),
    [rows],
  );
  return (
    <Subsection title={`${title} (${rows.length})`}>
      <DataTable<BucketWithId>
        columns={[
          {
            id: 'identifier',
            header: title.includes('IP') ? 'IP' : 'Email',
            mono: true,
            render: (r) => (
              <span style={{ color: 'var(--text-2)' }}>{r.identifier}</span>
            ),
          },
          {
            id: 'success',
            header: 'Successes',
            width: 110,
            render: (r) => (
              <Tag tone={r.success > 0 ? 'ok' : 'default'}>{r.success}</Tag>
            ),
          },
          {
            id: 'failure',
            header: 'Failures',
            width: 110,
            render: (r) => (
              <Tag tone={r.failure > 0 ? 'danger' : 'default'}>{r.failure}</Tag>
            ),
          },
          {
            id: 'lastSeen',
            header: 'Last seen',
            width: 170,
            mono: true,
            render: (r) => (
              <span style={{ color: 'var(--dim)' }}>
                <FormattedDateTime value={r.lastSeen} />
              </span>
            ),
          },
        ]}
        rows={withId}
        disableSort
        empty={empty}
        renderMobileCard={(r) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <strong>{r.identifier}</strong>
            <span style={{ fontSize: 12 }}>
              {r.success} successes · {r.failure} failures
            </span>
            <span style={{ fontSize: 11, color: 'var(--dim)' }}>
              <FormattedDateTime value={r.lastSeen} />
            </span>
          </div>
        )}
      />
    </Subsection>
  );
}

function loginTone(action: string): TagTone {
  if (action === 'auth.login.success' || action === 'auth.mfa.verify.success') {
    return 'ok';
  }
  if (action === 'auth.mfa.verify.failure') return 'warn';
  return 'danger';
}

// ─── Lockouts ──────────────────────────────────────────────────────

function LockoutsPane({ lockouts }: { lockouts: LockoutsResponse | null }) {
  if (!lockouts) {
    return <Empty>Lockout state is unavailable right now.</Empty>;
  }
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div
        style={{
          fontSize: 12,
          color: 'var(--muted)',
          padding: '0 4px',
        }}
      >
        Threshold: <strong>{lockouts.threshold}</strong> failures within{' '}
        <strong>{lockouts.windowMinutes} minutes</strong>. Counters at or above
        the threshold are locked; lower counters are warming.
      </div>
      <LockoutTable kind="ip" rows={lockouts.ip} threshold={lockouts.threshold} />
      <LockoutTable
        kind="email"
        rows={lockouts.email}
        threshold={lockouts.threshold}
      />
    </div>
  );
}

type LockoutWithId = LockoutsResponse['ip'][number] & { id: string };

function LockoutTable({
  kind,
  rows,
  threshold,
}: {
  kind: 'ip' | 'email';
  rows: LockoutsResponse['ip'];
  threshold: number;
}) {
  const title = kind === 'ip' ? 'By IP' : 'By email';
  const withId: LockoutWithId[] = useMemo(
    () => rows.map((r) => ({ ...r, id: `${kind}:${r.identifier}` })),
    [rows, kind],
  );
  return (
    <Subsection title={`${title} (${rows.length})`}>
      <DataTable<LockoutWithId>
        columns={[
          {
            id: 'identifier',
            header: kind === 'ip' ? 'IP' : 'Email',
            mono: true,
            render: (r) => (
              <span style={{ color: 'var(--text-2)' }}>{r.identifier}</span>
            ),
          },
          {
            id: 'failures',
            header: 'Failures',
            width: 140,
            render: (r) => (
              <Tag tone={r.locked ? 'danger' : 'warn'}>
                {r.failures} / {threshold}
              </Tag>
            ),
          },
          {
            id: 'state',
            header: 'State',
            width: 120,
            render: (r) => (
              <Tag tone={r.locked ? 'danger' : 'default'}>
                {r.locked ? 'Locked' : 'Warming'}
              </Tag>
            ),
          },
          {
            id: 'ttl',
            header: 'Resets in',
            width: 120,
            mono: true,
            render: (r) => (
              <span style={{ color: 'var(--dim)' }}>
                {r.ttlSeconds == null ? '—' : formatTtl(r.ttlSeconds * 1000)}
              </span>
            ),
          },
        ]}
        rows={withId}
        disableSort
        empty={`No ${kind} lockouts.`}
        renderMobileCard={(r) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <strong>{r.identifier}</strong>
            <span>
              <Tag tone={r.locked ? 'danger' : 'warn'}>
                {r.failures} / {threshold} {r.locked ? 'locked' : 'warming'}
              </Tag>
            </span>
          </div>
        )}
      />
    </Subsection>
  );
}

// ─── Throttle blocks ───────────────────────────────────────────────

type BlockWithId = ThrottleBlockEntry & { id: string };

function BlocksPane({ blocks }: { blocks: ThrottleBlockEntry[] | null }) {
  const withId: BlockWithId[] = useMemo(
    () =>
      (blocks ?? []).map((r) => ({ ...r, id: `${r.throttler}:${r.tracker}` })),
    [blocks],
  );
  if (!blocks) {
    return <Empty>Throttle state is unavailable right now.</Empty>;
  }
  if (blocks.length === 0) {
    return (
      <Empty>
        No active rate-limit blocks. Default config applies a soft 60-second
        rolling window; explicit hard blocks are not configured.
      </Empty>
    );
  }
  return (
    <DataTable<BlockWithId>
      columns={[
        {
          id: 'tracker',
          header: 'Tracker',
          mono: true,
          render: (r) => (
            <span style={{ color: 'var(--text-2)' }}>{r.tracker}</span>
          ),
        },
        {
          id: 'throttler',
          header: 'Throttler',
          width: 160,
          render: (r) => <Tag tone="default">{r.throttler}</Tag>,
        },
        {
          id: 'remaining',
          header: 'Remaining',
          width: 140,
          mono: true,
          render: (r) => (
            <span style={{ color: 'var(--dim)' }}>
              {formatTtl(r.remainingMs)}
            </span>
          ),
        },
        {
          id: 'until',
          header: 'Until',
          width: 180,
          mono: true,
          render: (r) => (
            <span style={{ color: 'var(--dim)' }}>
              <FormattedDateTime value={r.blockedUntil} />
            </span>
          ),
        },
      ]}
      rows={withId}
      disableSort
      empty="No active rate-limit blocks."
      renderMobileCard={(r) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <strong>{r.tracker}</strong>
          <span style={{ fontSize: 12 }}>
            {r.throttler} · {formatTtl(r.remainingMs)}
          </span>
        </div>
      )}
    />
  );
}

// ─── Active sessions ──────────────────────────────────────────────

function SessionsPane({
  sessions,
  canRevoke,
  currentUserId,
  onRefresh,
}: {
  sessions: SecuritySessionRow[] | null;
  canRevoke: boolean;
  currentUserId: string;
  onRefresh: () => void;
}) {
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  const columns = useMemo<DataColumn<SecuritySessionRow>[]>(
    () => [
      {
        id: 'user',
        header: 'User',
        render: (r) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <span style={{ color: 'var(--text)' }}>{r.user.name}</span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--dim)',
              }}
            >
              {r.user.email}
            </span>
          </div>
        ),
      },
      {
        id: 'role',
        header: 'Role',
        width: 130,
        render: (r) => <Tag tone="default">{r.user.role.toLowerCase()}</Tag>,
      },
      {
        id: 'mfa',
        header: 'MFA',
        width: 130,
        render: (r) => {
          if (r.mfaPending) return <Tag tone="warn">Pending</Tag>;
          if (r.user.mfaEnrolled) return <Tag tone="ok">Enrolled</Tag>;
          if (r.user.mfaEnabled) return <Tag tone="info">Enabled</Tag>;
          return <Tag tone="default">Off</Tag>;
        },
      },
      {
        id: 'ip',
        header: 'IP',
        width: 140,
        mono: true,
        render: (r) => <span style={{ color: 'var(--dim)' }}>{r.ip || '—'}</span>,
      },
      {
        id: 'ua',
        header: 'User agent',
        render: (r) => (
          <span
            style={{
              color: 'var(--dim)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              display: 'inline-block',
              maxWidth: 320,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={r.userAgent || undefined}
          >
            {r.userAgent || '—'}
          </span>
        ),
      },
      {
        id: 'created',
        header: 'Started',
        width: 170,
        mono: true,
        render: (r) => (
          <span style={{ color: 'var(--dim)' }}>
            <FormattedDateTime value={r.createdAt} />
          </span>
        ),
      },
      {
        id: 'actions',
        header: '',
        width: 100,
        render: (r) =>
          canRevoke ? (
            <Btn
              kind="ghost"
              size="sm"
              disabled={busyId === r.id || r.user.id === currentUserId}
              onClick={async (e) => {
                e.stopPropagation();
                if (
                  !confirm(
                    `Revoke session for ${r.user.name} (${r.user.email})? They will be signed out on their next request.`,
                  )
                )
                  return;
                setBusyId(r.id);
                const res = await apiFetch(`/security/sessions/${r.id}`, {
                  method: 'DELETE',
                });
                setBusyId(null);
                if (res.ok) {
                  toast.push('Session revoked.', 'ok');
                  onRefresh();
                } else {
                  toast.push('Failed to revoke session.', 'danger');
                }
              }}
              title={
                r.user.id === currentUserId
                  ? "You can't revoke your own session here — use the profile page instead."
                  : 'Revoke session'
              }
            >
              {busyId === r.id ? '…' : 'Revoke'}
            </Btn>
          ) : null,
      },
    ],
    [busyId, canRevoke, currentUserId, onRefresh, toast],
  );

  if (!sessions) {
    return <Empty>Session state is unavailable right now.</Empty>;
  }

  return (
    <DataTable
      columns={columns}
      rows={sessions}
      disableSort
      empty="No active sessions."
      renderMobileCard={(r) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <strong>{r.user.name}</strong>
          <span style={{ fontSize: 12, color: 'var(--dim)' }}>
            {r.user.email} · {r.ip || 'unknown'}
          </span>
          <span style={{ fontSize: 11, color: 'var(--dim)' }}>
            <FormattedDateTime value={r.createdAt} />
          </span>
        </div>
      )}
    />
  );
}

// ─── Egress blocks (Phase 6) ──────────────────────────────────────

function EgressPane({ egress }: { egress: EgressBlocksResponse | null }) {
  if (!egress) {
    return <Empty>Egress block history is unavailable right now.</Empty>;
  }
  if (egress.recent.length === 0) {
    return (
      <div style={{ display: 'grid', gap: 12 }}>
        <div
          style={{
            fontSize: 12,
            color: 'var(--muted)',
            padding: '0 4px',
          }}
        >
          The egress guard refuses outbound HTTP to private, loopback, and
          link-local addresses (incl. cloud metadata <code>169.254.169.254</code>).
          Operators can punch holes via{' '}
          <code>EGRESS_ALLOWED_PRIVATE_CIDRS</code>.
        </div>
        <Empty>
          No egress was blocked in the last {egress.windowHours} hours.
        </Empty>
      </div>
    );
  }
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div
        style={{
          fontSize: 12,
          color: 'var(--muted)',
          padding: '0 4px',
        }}
      >
        {egress.total} block{egress.total === 1 ? '' : 's'} in the last{' '}
        {egress.windowHours} hours. Showing the most recent {egress.recent.length}.
      </div>
      <DataTable<EgressBlockRow>
        columns={egressColumns}
        rows={egress.recent}
        disableSort
        empty="No egress blocks."
        renderMobileCard={(r) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <strong>{r.hostname ?? r.url ?? 'unknown'}</strong>
            <span style={{ fontSize: 12, color: 'var(--dim)' }}>
              {r.reason ?? '—'}
            </span>
            <span style={{ fontSize: 11, color: 'var(--dim)' }}>
              <FormattedDateTime value={r.createdAt} />
            </span>
          </div>
        )}
      />
    </div>
  );
}

const egressColumns: DataColumn<EgressBlockRow>[] = [
  {
    id: 'when',
    header: 'When',
    width: 170,
    mono: true,
    render: (r) => (
      <span style={{ color: 'var(--dim)' }}>
        <FormattedDateTime value={r.createdAt} />
      </span>
    ),
  },
  {
    id: 'host',
    header: 'Host',
    width: 220,
    render: (r) => (
      <span
        style={{
          color: 'var(--text-2)',
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          display: 'inline-block',
          maxWidth: 220,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={r.url ?? r.hostname ?? ''}
      >
        {r.hostname ?? r.url ?? '—'}
      </span>
    ),
  },
  {
    id: 'ips',
    header: 'Resolved IPs',
    width: 220,
    mono: true,
    render: (r) => (
      <span style={{ color: 'var(--dim)' }}>
        {r.resolvedIps.length > 0 ? r.resolvedIps.join(', ') : '—'}
      </span>
    ),
  },
  {
    id: 'reason',
    header: 'Reason',
    render: (r) => (
      <Tag tone="danger">
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
          {r.reason ?? 'blocked'}
        </span>
      </Tag>
    ),
  },
  {
    id: 'matched',
    header: 'CIDR',
    width: 140,
    mono: true,
    render: (r) => (
      <span style={{ color: 'var(--dim)' }}>{r.matchedCidr ?? '—'}</span>
    ),
  },
  {
    id: 'src',
    header: 'Source',
    width: 180,
    render: (r) => (
      <span
        style={{
          color: 'var(--dim)',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          display: 'inline-block',
          maxWidth: 180,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={r.userAgent ?? undefined}
      >
        {r.userAgent ?? '—'}
      </span>
    ),
  },
];

// ─── Helpers ──────────────────────────────────────────────────────

function Subsection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--muted)',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: 28,
        textAlign: 'center',
        color: 'var(--muted)',
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

function formatTtl(ms: number): string {
  if (ms <= 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
