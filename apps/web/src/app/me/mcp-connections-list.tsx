'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { McpConnectionSummary } from '@weavestream/shared';
import { apiFetch } from '../../lib/api';
import { FormattedRelative } from '../../lib/timezone-context';
import {
  Btn,
  DataTable,
  Dialog,
  ErrorBanner,
  MobileCardRow,
  useToast,
  type DataColumn,
} from '../../components/ui';
import { ApiKeyAccessTags } from './api-keys-list';

/**
 * Remote AI connections (ChatGPT, Claude) the user approved. Each one acts as
 * the user, read-only unless they allowed changes, until it is revoked here,
 * by an administrator, or by a password change or "sign out everywhere".
 * New connections start in the AI app, not here.
 */
export function McpConnectionsList({
  connections,
  loadFailed = false,
  enabled = true,
}: {
  connections: McpConnectionSummary[];
  /** The server-side list fetch failed; say so rather than show an empty list. */
  loadFailed?: boolean;
  /** The instance-wide switch; off refuses every connection until it is back on. */
  enabled?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [revoking, setRevoking] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<McpConnectionSummary | null>(null);

  async function revoke(c: McpConnectionSummary) {
    setRevoking(c.id);
    try {
      const res = await apiFetch(`/me/mcp-connections/${c.id}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.push('Could not revoke the connection.', 'danger');
        return;
      }
      toast.push(`Revoked the ${c.clientName} connection.`, 'ok');
      router.refresh();
    } catch {
      toast.push('Could not revoke the connection.', 'danger');
    } finally {
      setRevoking(null);
    }
  }

  const revokeButton = (c: McpConnectionSummary) => (
    <Btn
      kind="outline"
      size="sm"
      loading={revoking === c.id}
      aria-label={`Revoke ${c.clientName} connection`}
      onClick={() => setConfirming(c)}
    >
      Revoke
    </Btn>
  );

  const columns: DataColumn<McpConnectionSummary>[] = [
    {
      id: 'app',
      header: 'App',
      sortValue: (c) => c.clientName.toLowerCase(),
      render: (c) => <AppCell c={c} />,
    },
    {
      id: 'access',
      header: 'Access',
      width: 150,
      sortValue: (c) => (c.allowWrite ? 1 : 0),
      render: (c) => <ApiKeyAccessTags k={{ allowWrite: c.allowWrite, allowPasswordReveal: false }} />,
    },
    {
      id: 'connected',
      header: 'Connected',
      mono: true,
      width: 140,
      sortValue: (c) => new Date(c.createdAt),
      render: (c) => (
        <span style={{ color: 'var(--dim)' }}>
          <FormattedRelative value={c.createdAt} />
        </span>
      ),
    },
    {
      id: 'lastUsed',
      header: 'Last used',
      mono: true,
      width: 140,
      sortValue: (c) => (c.lastUsedAt ? new Date(c.lastUsedAt) : null),
      render: (c) => (
        <span style={{ color: 'var(--dim)' }}>
          {c.lastUsedAt ? <FormattedRelative value={c.lastUsedAt} /> : 'never'}
        </span>
      ),
    },
    { id: 'actions', header: '', width: 110, render: revokeButton },
  ];

  return (
    <div>
      <div style={{ padding: 10, borderBottom: '1px solid var(--line)' }}>
        <span style={{ fontSize: 12.5, color: 'var(--muted)', display: 'block', maxWidth: 620 }}>
          AI apps you connected to Weavestream, such as ChatGPT or Claude. A connection acts as
          you, with your permissions, and is read-only unless you allowed changes. It can never
          see passwords or delete anything. To connect an app, add Weavestream in the app itself.
          Changing your password or signing out other sessions revokes every connection.
        </span>
      </div>

      {!enabled && (
        <div style={{ padding: 10 }}>
          <ErrorBanner
            tone="warn"
            title="Remote AI connections are turned off for this workspace."
            detail="Existing connections are refused and no new one can be made. An administrator can turn them on in Admin → Settings → API & MCP."
          />
        </div>
      )}

      {loadFailed ? (
        <div style={{ padding: 10 }}>
          <ErrorBanner title="Could not load your AI connections." detail="Reload the page to try again.">
            <Btn kind="outline" size="sm" onClick={() => router.refresh()}>
              Retry
            </Btn>
          </ErrorBanner>
        </div>
      ) : (
        <DataTable
          columns={columns}
          rows={connections}
          empty="No AI connections."
          renderMobileCard={(c) => (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <AppCell c={c} />
              <ApiKeyAccessTags k={{ allowWrite: c.allowWrite, allowPasswordReveal: false }} />
              <MobileCardRow label="Connected" mono>
                <FormattedRelative value={c.createdAt} />
              </MobileCardRow>
              <MobileCardRow label="Last used" mono>
                {c.lastUsedAt ? <FormattedRelative value={c.lastUsedAt} /> : 'never'}
              </MobileCardRow>
              {revokeButton(c)}
            </div>
          )}
        />
      )}

      <Dialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title="Revoke AI connection"
        width={440}
        footer={
          <>
            <Btn kind="outline" onClick={() => setConfirming(null)}>
              Cancel
            </Btn>
            <Btn
              kind="danger"
              onClick={() => {
                const c = confirming;
                setConfirming(null);
                if (c) void revoke(c);
              }}
            >
              Revoke
            </Btn>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
          Revoke the <strong>{confirming?.clientName}</strong> connection? The app loses access
          immediately. To use it again, connect it again from the app.
        </p>
      </Dialog>
    </div>
  );
}

/** Name as stated by the app, with the verified host under it. */
export function AppCell({ c }: { c: Pick<McpConnectionSummary, 'clientName' | 'clientHost'> }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ color: 'var(--text)', fontWeight: 500 }}>{c.clientName}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--dim)' }}>
        {c.clientHost}
      </span>
    </div>
  );
}
