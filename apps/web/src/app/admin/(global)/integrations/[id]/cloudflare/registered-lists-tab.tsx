'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  CloudflareExternalListDto,
  CloudflareIpListDto,
  IntegrationDto,
} from '@weavestream/shared';
import { apiFetch } from '../../../../../../lib/api';
import {
  Btn,
  DataTable,
  Dialog,
  Icon,
  Tag,
  useToast,
  type DataColumn,
} from '../../../../../../components/ui';

/**
 * Lists tab for a Cloudflare integration. Mirrors the asset-import
 * Organizations tab but works against `CloudflareIpList` rows: each row
 * is a Cloudflare list Weavestream is now managing. Clicking a row
 * drops into the per-list detail page where the operator edits entries.
 */
export function RegisteredListsTab({
  integration,
  initialLists,
}: {
  integration: IntegrationDto;
  initialLists: CloudflareIpListDto[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [lists, setLists] = useState<CloudflareIpListDto[]>(initialLists);
  const [registerOpen, setRegisterOpen] = useState(false);

  const columns = useMemo<DataColumn<CloudflareIpListDto>[]>(
    () => [
      {
        id: 'name',
        header: 'List',
        sortValue: (r) => r.name.toLowerCase(),
        render: (r) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ color: 'var(--text)', fontWeight: 500 }}>
              {r.name}
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--dim)',
              }}
            >
              {r.externalListId}
            </span>
          </div>
        ),
      },
      {
        id: 'entries',
        header: 'Entries',
        width: 90,
        sortValue: (r) => r.entries.length,
        render: (r) => (
          <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-2)' }}>
            {r.entries.length}
          </span>
        ),
      },
      {
        id: 'drift',
        header: 'Drift',
        width: 130,
        sortValue: (r) => r.driftStatus,
        render: (r) => <DriftStatusTag status={r.driftStatus} />,
      },
      {
        id: 'lastDrift',
        header: 'Last drift check',
        width: 150,
        sortValue: (r) => (r.lastDriftCheckAt ? new Date(r.lastDriftCheckAt) : null),
        render: (r) =>
          r.lastDriftCheckAt ? (
            <span style={{ color: 'var(--text-2)', fontSize: 12.5 }}>
              {relative(r.lastDriftCheckAt)}
            </span>
          ) : (
            <span style={{ color: 'var(--dim)' }}>never</span>
          ),
      },
      {
        id: 'lastPush',
        header: 'Last push',
        width: 150,
        sortValue: (r) => (r.lastPushedAt ? new Date(r.lastPushedAt) : null),
        render: (r) =>
          r.lastPushedAt ? (
            <span style={{ color: 'var(--text-2)', fontSize: 12.5 }}>
              {relative(r.lastPushedAt)}
            </span>
          ) : (
            <span style={{ color: 'var(--dim)' }}>never</span>
          ),
      },
    ],
    [],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)', maxWidth: 640 }}>
          Pick which Cloudflare IP lists Weavestream manages. Once registered,
          edits made here are pushed to Cloudflare; the periodic drift sweep
          auto-heals any out-of-band edits made directly in the Cloudflare
          dashboard by re-pushing Weavestream's view.
        </p>
        <Btn
          kind="primary"
          size="sm"
          icon={Icon.plus}
          onClick={() => setRegisterOpen(true)}
          disabled={!integration.hasSecret}
          title={!integration.hasSecret ? 'Add credentials first' : undefined}
        >
          Register list
        </Btn>
      </div>

      <DataTable
        columns={columns}
        rows={lists}
        rowHref={(r) => `/admin/integrations/${integration.id}/cloudflare/${r.id}`}
        empty="No Cloudflare lists registered yet."
      />

      <RegisterListDialog
        open={registerOpen}
        integration={integration}
        onClose={() => setRegisterOpen(false)}
        onRegistered={(row) => {
          setLists((prev) => [...prev, row].sort((a, b) => a.name.localeCompare(b.name)));
          setRegisterOpen(false);
          toast.push(`Registered "${row.name}".`, 'ok');
          router.refresh();
        }}
      />
    </div>
  );
}

function RegisterListDialog({
  open,
  integration,
  onClose,
  onRegistered,
}: {
  open: boolean;
  integration: IntegrationDto;
  onClose: () => void;
  onRegistered: (row: CloudflareIpListDto) => void;
}) {
  const toast = useToast();
  const [external, setExternal] = useState<CloudflareExternalListDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  async function loadExternal(): Promise<void> {
    setLoading(true);
    const res = await apiFetch<{ lists: CloudflareExternalListDto[] }>(
      `/admin/integrations/${integration.id}/cloudflare/external-lists`,
    );
    setLoading(false);
    if (!res.ok || !res.data) {
      const problem = res.problem as { detail?: string; title?: string } | undefined;
      toast.push(
        problem?.detail ?? problem?.title ?? 'Could not list Cloudflare lists.',
        'danger',
      );
      onClose();
      return;
    }
    setExternal(res.data.lists);
  }

  // Lazy-load when the dialog first opens.
  if (open && external === null && !loading) void loadExternal();

  async function register(externalListId: string): Promise<void> {
    setPending(externalListId);
    const res = await apiFetch<CloudflareIpListDto>(
      `/admin/integrations/${integration.id}/cloudflare/lists`,
      { method: 'POST', body: JSON.stringify({ externalListId }) },
    );
    setPending(null);
    if (!res.ok || !res.data) {
      const problem = res.problem as { detail?: string; title?: string } | undefined;
      toast.push(problem?.detail ?? problem?.title ?? 'Could not register list.', 'danger');
      return;
    }
    onRegistered(res.data);
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        onClose();
        setExternal(null);
      }}
      title="Register Cloudflare list"
      width={520}
      footer={
        <Btn
          kind="ghost"
          onClick={() => {
            onClose();
            setExternal(null);
          }}
        >
          Close
        </Btn>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>
          Pick a list from your Cloudflare account. Existing items are imported
          on first registration; future edits flow Weavestream → Cloudflare.
        </p>
        {loading && <span style={{ color: 'var(--muted)' }}>Loading…</span>}
        {!loading && external && external.length === 0 && (
          <span style={{ color: 'var(--muted)' }}>
            No IP lists found in this Cloudflare account.
          </span>
        )}
        {!loading &&
          external &&
          external.map((l) => {
            const isIp = l.kind === 'ip';
            return (
              <div
                key={l.externalListId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 12px',
                  border: '1px solid var(--line)',
                  borderRadius: 6,
                  opacity: isIp ? 1 : 0.55,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      flexWrap: 'wrap',
                    }}
                  >
                    <span style={{ color: 'var(--text)', fontWeight: 500 }}>
                      {l.name}
                    </span>
                    <Tag tone={isIp ? 'accent' : 'default'}>
                      {l.kind || 'unknown'}
                    </Tag>
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      color: 'var(--dim)',
                    }}
                  >
                    {l.externalListId} · {l.numItems}{' '}
                    {l.numItems === 1 ? 'item' : 'items'}
                  </div>
                </div>
                {!isIp ? (
                  <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                    only IP lists supported
                  </span>
                ) : l.alreadyRegistered ? (
                  <Tag tone="ok">
                    registered
                  </Tag>
                ) : (
                  <Btn
                    kind="primary"
                    size="sm"
                    loading={pending === l.externalListId}
                    onClick={() => register(l.externalListId)}
                  >
                    Register
                  </Btn>
                )}
              </div>
            );
          })}
      </div>
    </Dialog>
  );
}

function DriftStatusTag({
  status,
}: {
  status: 'in_sync' | 'drift_detected' | 'unknown' | 'error';
}) {
  if (status === 'in_sync') {
    return (
      <Tag tone="ok">
        in sync
      </Tag>
    );
  }
  if (status === 'drift_detected') {
    return (
      <Tag tone="warn">
        drift
      </Tag>
    );
  }
  if (status === 'error') {
    return (
      <Tag tone="danger">
        error
      </Tag>
    );
  }
  return (
    <Tag tone="default">
      unknown
    </Tag>
  );
}

function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const day = 86_400_000;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < day) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return `${Math.floor(diff / (7 * day))}w ago`;
}
