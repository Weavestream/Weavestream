'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ADMIN_MCP_CONNECTION_PAGE_SIZES,
  type AdminMcpConnectionPage,
  type AdminMcpConnectionRow,
} from '@weavestream/shared';
import { apiFetch } from '../../../../lib/api';
import { FormattedDateTime } from '../../../../lib/timezone-context';
import { Btn, DataTable, Pagination, useToast, type DataColumn } from '../../../../components/ui';
import { ApiKeyAccessTags } from '../../../me/api-keys-list';
import { AppCell } from '../../../me/mcp-connections-list';

/**
 * Every live remote AI connection on the instance, with its owner. An admin
 * holding `user.manage` can revoke any of them (step-up), the same bar as an
 * API key. Connections act as their owner without appearing in the session
 * list, so this is the only place an admin can see them.
 */
export function AiConnectionsPane({
  connections,
  enabled,
  canRevoke,
  onRefresh,
}: {
  connections: AdminMcpConnectionPage | null;
  enabled: boolean;
  canRevoke: boolean;
  onRefresh: () => void;
}) {
  const toast = useToast();
  const router = useRouter();
  const sp = useSearchParams();
  const [busyId, setBusyId] = useState<string | null>(null);

  // Keeps the tab, window and every other param; page 1 drops `connPage`.
  const pageHref = useCallback(
    (page: number, pageSize: number) => {
      const q = new URLSearchParams(sp.toString());
      q.set('tab', 'ai-connections');
      if (page <= 1) q.delete('connPage');
      else q.set('connPage', String(page));
      q.set('connPageSize', String(pageSize));
      return `/admin/security?${q.toString()}`;
    },
    [sp],
  );

  const revoke = useCallback(
    async (c: AdminMcpConnectionRow) => {
      if (
        !confirm(
          `Revoke the ${c.clientName} connection of ${c.user.name} (${c.user.email})? The app loses access immediately.`,
        )
      )
        return;
      setBusyId(c.id);
      let res: Awaited<ReturnType<typeof apiFetch>>;
      try {
        res = await apiFetch(`/security/mcp-connections/${c.id}`, { method: 'DELETE' });
      } catch {
        toast.push('Weavestream could not be reached. The connection was not revoked; try again.', 'danger');
        return;
      } finally {
        setBusyId(null);
      }
      if (res.ok) {
        toast.push('AI connection revoked.', 'ok');
        onRefresh();
      } else if (!res.stepUpCancelled) {
        toast.push('Failed to revoke the AI connection.', 'danger');
      }
    },
    [onRefresh, toast],
  );

  const columns = useMemo<DataColumn<AdminMcpConnectionRow>[]>(
    () => [
      {
        id: 'owner',
        header: 'Owner',
        render: (c) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <span style={{ color: 'var(--text)' }}>{c.user.name}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--dim)' }}>
              {c.user.email}
            </span>
          </div>
        ),
      },
      { id: 'app', header: 'App', render: (c) => <AppCell c={c} /> },
      {
        id: 'access',
        header: 'Access',
        width: 150,
        render: (c) => <ApiKeyAccessTags k={{ allowWrite: c.allowWrite, allowPasswordReveal: false }} />,
      },
      {
        id: 'connected',
        header: 'Connected',
        width: 170,
        mono: true,
        render: (c) => (
          <span style={{ color: 'var(--dim)' }}>
            <FormattedDateTime value={c.createdAt} />
          </span>
        ),
      },
      {
        id: 'lastUsed',
        header: 'Last used',
        width: 170,
        mono: true,
        render: (c) => (
          <span style={{ color: 'var(--dim)' }}>
            {c.lastUsedAt ? <FormattedDateTime value={c.lastUsedAt} /> : 'never'}
          </span>
        ),
      },
      {
        id: 'actions',
        header: '',
        width: 100,
        render: (c) =>
          canRevoke ? (
            <Btn
              kind="ghost"
              size="sm"
              disabled={busyId === c.id}
              onClick={(e) => {
                e.stopPropagation();
                void revoke(c);
              }}
              title="Revoke AI connection"
            >
              {busyId === c.id ? '…' : 'Revoke'}
            </Btn>
          ) : null,
      },
    ],
    [busyId, canRevoke, revoke],
  );

  if (!connections) {
    return (
      <div style={{ padding: 24, textAlign: 'center', fontSize: 13, color: 'var(--muted)' }}>
        AI connection state is unavailable right now.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {!enabled && (
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          Remote AI connections are turned off in Settings → API &amp; MCP, so every connection
          below is refused until they are turned back on.
        </div>
      )}
      <DataTable
        columns={columns}
        rows={connections.items}
        disableSort
        empty="No AI connections."
        renderMobileCard={(c) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <AppCell c={c} />
            <span style={{ fontSize: 12, color: 'var(--dim)' }}>
              {c.user.name} · {c.user.email}
            </span>
            <ApiKeyAccessTags k={{ allowWrite: c.allowWrite, allowPasswordReveal: false }} />
            <span style={{ fontSize: 11, color: 'var(--dim)' }}>
              Last used {c.lastUsedAt ? <FormattedDateTime value={c.lastUsedAt} /> : 'never'}
            </span>
            {canRevoke && (
              <Btn kind="outline" size="sm" disabled={busyId === c.id} onClick={() => void revoke(c)}>
                {busyId === c.id ? '…' : 'Revoke'}
              </Btn>
            )}
          </div>
        )}
      />
      <Pagination
        page={connections.page}
        pageSize={connections.pageSize}
        total={connections.total}
        buildHref={pageHref}
        onPageSizeChange={(next) => router.replace(pageHref(1, next))}
        pageSizeOptions={[...ADMIN_MCP_CONNECTION_PAGE_SIZES]}
      />
    </div>
  );
}
