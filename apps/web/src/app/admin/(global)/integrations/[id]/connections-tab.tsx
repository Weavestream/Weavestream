'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type {
  DriverOAuthDescriptor,
  IntegrationConnection,
  IntegrationConnections,
  IntegrationOAuthStartResponse,
  IntegrationSetupCheck,
  SetupGuideStep,
} from '@weavestream/shared';
import { INTEGRATION_OAUTH_PROVIDER_LABELS, problemMessage } from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import { FormattedDate } from '../../../../../lib/timezone-context';
import { Btn, DataTable, Icon, MobileCardRow, Tag, useToast, type DataColumn } from '../../../../../components/ui';
import { SetupGuide } from '../../../../../components/integrations/setup-guide';

/**
 * Fixed text for the `reason` the API callback may add to `?oauth=failed`.
 * Anything else falls back to the generic failure toast.
 */
export const OAUTH_FAILURE_REASONS: Record<string, string> = {
  tenant_unverified: 'Weavestream could not verify the tenant the provider returned, so nothing was saved. Connect again.',
  app_not_configured: 'The app of this integration is not set up yet. Set it up on the App tab first.',
  already_connected: 'That client tenant is already connected. Use Reconnect on its row instead.',
  wrong_tenant:
    'You signed in to a different tenant than the one this connection belongs to, so nothing was changed. Reconnect with an admin of that tenant, or use Connect a client for a new one.',
  connection_missing: 'That connection was removed while you were signing in. Connect the client again.',
};

type Status = { label: string; tone: 'ok' | 'warn' | 'danger' };

function statusOf(row: IntegrationConnection): Status {
  return row.status === 'ok' ? { label: 'ok', tone: 'ok' } : { label: 'needs reconnect', tone: 'danger' };
}

/**
 * Connections tab of an OAuth integration: one row per client tenant.
 * Connect sends the browser to the provider (Google sign-in); the API callback brings it back here with a generic
 * `?oauth=connected|failed` flag, which becomes a toast and is then
 * stripped from the URL. Reconnect is bound to its row's tenant.
 */
export function ConnectionsTab({
  integrationId,
  oauth,
  setupGuide,
}: {
  integrationId: string;
  oauth: DriverOAuthDescriptor;
  setupGuide?: SetupGuideStep[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const toast = useToast();
  const [data, setData] = useState<IntegrationConnections | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [check, setCheck] = useState<IntegrationSetupCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const label = INTEGRATION_OAUTH_PROVIDER_LABELS[oauth.provider];

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<IntegrationConnections>(`/admin/integrations/${integrationId}/connections`);
      if (res.ok && res.data) {
        setData(res.data);
        setLoadFailed(false);
        return;
      }
    } catch {
      // apiFetch rethrows network failures: show the load-failed state below.
    }
    setLoadFailed(true);
  }, [integrationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const flag = sp.get('oauth');
  const reason = sp.get('reason');
  useEffect(() => {
    if (flag !== 'connected' && flag !== 'failed') return;
    toast.push(
      flag === 'connected'
        ? `Connected with ${label}.`
        : (reason && Object.hasOwn(OAUTH_FAILURE_REASONS, reason) ? OAUTH_FAILURE_REASONS[reason] : undefined) ??
            `Could not connect with ${label}. Try again, or check the App tab.`,
      flag === 'connected' ? 'ok' : 'danger',
    );
    const params = new URLSearchParams(sp.toString());
    params.delete('oauth');
    params.delete('reason');
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
    // Fire once per flag value; toast/router identities are irrelevant here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flag]);

  /** New client tenant (no id) or Reconnect of one connection. */
  async function connect(connectionId?: string) {
    setBusy(connectionId ?? 'new');
    try {
      const res = await apiFetch<IntegrationOAuthStartResponse>(`/admin/integrations/${integrationId}/connections/start`, {
        method: 'POST',
        body: JSON.stringify(connectionId ? { connectionId } : {}),
      });
      if (!res.ok || !res.data) {
        setBusy(null);
        if (!res.stepUpCancelled) {
          toast.push(problemMessage(res.problem) ?? `Could not start the ${label} sign-in.`, 'danger');
        }
        return;
      }
      // Same-tab navigation to the provider (busy stays set); `open` rather than `location` so it is testable.
      window.open(res.data.authorizeUrl, '_self');
    } catch {
      // apiFetch rethrows network failures; the buttons must not stay disabled.
      setBusy(null);
      toast.push(`Could not start the ${label} sign-in.`, 'danger');
    }
  }

  async function disconnect(row: IntegrationConnection) {
    const name = row.displayName ?? row.externalOrgId;
    const consequence = 'Weavestream revokes its access to this tenant and forgets it.';
    if (!window.confirm(`Disconnect ${name}?\n\n${consequence} Syncs of this tenant stop until you connect it again.`)) {
      return;
    }
    setBusy(row.id);
    try {
      const res = await apiFetch<null>(`/admin/integrations/${integrationId}/connections/${row.id}/disconnect`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (!res.ok && res.status !== 204) {
        if (!res.stepUpCancelled) toast.push(problemMessage(res.problem) ?? 'Could not disconnect.', 'danger');
        return;
      }
    } catch {
      // apiFetch rethrows network failures; the buttons must not stay disabled.
      toast.push('Could not disconnect.', 'danger');
      return;
    } finally {
      setBusy(null);
    }
    toast.push(`Disconnected ${name}.`, 'ok');
    if (selectedId === row.id) setSelectedId(null);
    await load();
    router.refresh();
  }

  async function runCheck(connectionId: string) {
    setChecking(true);
    try {
      const res = await apiFetch<IntegrationSetupCheck>(
        `/admin/integrations/${integrationId}/check?connectionId=${encodeURIComponent(connectionId)}`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      if (!res.ok || !res.data) {
        toast.push(problemMessage(res.problem) ?? 'Could not run the setup check.', 'danger');
        return;
      }
      setCheck(res.data);
    } catch {
      // apiFetch rethrows network failures; the button must not stay stuck loading.
      toast.push('Could not run the setup check.', 'danger');
    } finally {
      setChecking(false);
    }
  }

  function select(row: IntegrationConnection) {
    setSelectedId(row.id === selectedId ? null : row.id);
    setCheck(null);
  }

  const actions = (row: IntegrationConnection) => (
    // Row clicks open the details; the buttons must not.
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} onClick={(e) => e.stopPropagation()}>
      <Btn
        kind={row.status === 'ok' ? 'outline' : 'primary'}
        size="sm"
        icon={Icon.refresh}
        onClick={() => void connect(row.id)}
        loading={busy === row.id}
        disabled={!data?.appConfigured || busy !== null}
        aria-label={`Reconnect ${row.displayName ?? row.externalOrgId}`}
      >
        Reconnect
      </Btn>
      <Btn
        kind="ghost"
        size="sm"
        icon={Icon.x}
        onClick={() => void disconnect(row)}
        disabled={busy !== null}
        aria-label={`Disconnect ${row.displayName ?? row.externalOrgId}`}
      >
        Disconnect
      </Btn>
    </div>
  );

  const columns: DataColumn<IntegrationConnection>[] = [
    {
      id: 'tenant',
      header: 'Client tenant',
      width: 260,
      sortValue: (r) => r.displayName ?? r.externalOrgId,
      render: (r) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <strong style={{ fontSize: 13, color: 'var(--text)' }}>{r.displayName ?? r.externalOrgId}</strong>
          <span style={monoStyle}>{r.externalOrgId}</span>
        </div>
      ),
    },
    {
      id: 'connectedAs',
      header: 'Connected as',
      width: 200,
      sortValue: (r) => r.connectedAs,
      render: (r) => r.connectedAs ?? 'Not recorded',
    },
    {
      id: 'connectedAt',
      header: 'Connected',
      width: 150,
      sortValue: (r) => new Date(r.connectedAt),
      render: (r) => <FormattedDate value={r.connectedAt} />,
    },
    {
      id: 'lastSync',
      header: 'Last sync',
      width: 150,
      sortValue: (r) => (r.lastSyncAt ? new Date(r.lastSyncAt) : null),
      render: (r) => (r.lastSyncAt ? <FormattedDate value={r.lastSyncAt} /> : 'Never'),
    },
    {
      id: 'status',
      header: 'Status',
      width: 140,
      sortValue: (r) => statusOf(r).label,
      render: (r) => {
        const s = statusOf(r);
        return <Tag tone={s.tone}>{s.label}</Tag>;
      },
    },
    { id: 'actions', header: '', width: 220, sortable: false, render: actions },
  ];

  const selected = data?.connections.find((c) => c.id === selectedId) ?? null;

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <header style={headerRowStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <h3 style={headerStyle}>Connections</h3>
          <p style={mutedStyle}>
            One row per client tenant. Map each tenant to a company on the Organizations tab.{' '}
            Sign in with an administrator account of the customer to connect.
          </p>
        </div>
        <Btn
          kind="primary"
          size="sm"
          icon={Icon.plus}
          onClick={() => void connect()}
          loading={busy === 'new'}
          disabled={!data?.appConfigured || busy !== null}
        >
          Connect a client
        </Btn>
      </header>

      {loadFailed ? (
        <Tag tone="danger">Could not load the connections. Reload to try again.</Tag>
      ) : !data ? (
        <p style={mutedStyle}>Loading connections…</p>
      ) : (
        <>
          {!data.appConfigured && (
            <p style={mutedStyle}>
              The {label} app of this integration is not set up yet.{' '}
              <Link href={`/admin/integrations/${integrationId}?tab=app`} style={linkStyle}>
                Set it up on the App tab
              </Link>
              .
            </p>
          )}
          <DataTable
            columns={columns}
            rows={data.connections}
            onRowClick={select}
            defaultSort={{ columnId: 'tenant' }}
            empty={`No client tenants yet. Press Connect a client to add the first one.`}
            renderMobileCard={(r) => {
              const s = statusOf(r);
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <strong style={{ fontSize: 13 }}>{r.displayName ?? r.externalOrgId}</strong>
                  <MobileCardRow label="Tenant" mono>{r.externalOrgId}</MobileCardRow>
                  <MobileCardRow label="Connected as">{r.connectedAs ?? 'Not recorded'}</MobileCardRow>
                  <MobileCardRow label="Connected"><FormattedDate value={r.connectedAt} /></MobileCardRow>
                  <MobileCardRow label="Last sync">{r.lastSyncAt ? <FormattedDate value={r.lastSyncAt} /> : 'Never'}</MobileCardRow>
                  <MobileCardRow label="Status"><Tag tone={s.tone}>{s.label}</Tag></MobileCardRow>
                  <div style={{ paddingTop: 6 }}>{actions(r)}</div>
                </div>
              );
            }}
          />
          {selected && (
            <section aria-label={`Details of ${selected.displayName ?? selected.externalOrgId}`} style={detailStyle}>
              <h4 style={{ ...headerStyle, fontSize: 13 }}>{selected.displayName ?? selected.externalOrgId}</h4>
              {setupGuide && setupGuide.length > 0 && (
                <SetupGuide
                  steps={setupGuide}
                  redirectUri={data.redirectUri}
                  scopeGroups={[{ scopes: oauth.scopes }]}
                  check={check}
                  onCheck={() => void runCheck(selected.id)}
                  checking={checking}
                  checkDisabledReason={null}
                  defaultOpen={false}
                />
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}

const headerStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-display)',
  fontSize: 14,
  fontWeight: 600,
  letterSpacing: -0.2,
  color: 'var(--text)',
};

const headerRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
  flexWrap: 'wrap',
};

const mutedStyle: React.CSSProperties = { margin: 0, fontSize: 12.5, color: 'var(--muted)' };

const monoStyle: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--dim)', overflowWrap: 'anywhere' };

const detailStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 14,
  border: '1px solid var(--line)',
  borderRadius: 8,
};

const linkStyle: React.CSSProperties = {
  color: 'var(--accent)',
  fontWeight: 600,
  textDecoration: 'none',
};
