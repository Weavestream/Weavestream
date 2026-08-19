'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  CloudflareIpEntryDto,
  CloudflareIpListDto,
  CloudflarePushResponse,
  IntegrationDto,
} from '@weavestream/shared';
import { apiFetch } from '../../../../../../../lib/api';
import {
  Btn,
  DataTable,
  Icon,
  useToast,
  type DataColumn,
} from '../../../../../../../components/ui';
import { DriftBanner } from '../../../../../../../components/integrations/drift-banner';
import { EntryFormDialog } from '../entry-form-dialog';
import { weekCappedRelative as relative } from '../../../../../../../lib/relative-time';

type DialogState =
  | { kind: 'closed' }
  | { kind: 'add' }
  | { kind: 'edit'; entry: CloudflareIpEntryDto };

/**
 * Per-list editor. Hosts the drift banner + entries table + add/edit/
 * remove dialogs. Every mutation passes the current `entriesVersion`
 * so concurrent edits from another tab return 409 instead of silently
 * clobbering each other; we re-fetch and toast on conflict.
 */
export function ListDetailView({
  integration,
  initialList,
}: {
  integration: IntegrationDto;
  initialList: CloudflareIpListDto;
}) {
  const router = useRouter();
  const toast = useToast();
  const [list, setList] = useState<CloudflareIpListDto>(initialList);
  const [dialog, setDialog] = useState<DialogState>({ kind: 'closed' });
  const [submitting, setSubmitting] = useState(false);
  const [overwriting, setOverwriting] = useState(false);
  const [driftChecking, setDriftChecking] = useState(false);
  const [unregistering, setUnregistering] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const baseUrl = `/admin/integrations/${integration.id}/cloudflare/lists/${list.id}`;

  type RowEntry = CloudflareIpEntryDto & { id: string };
  const rows: RowEntry[] = useMemo(
    () => list.entries.map((e) => ({ ...e, id: e.ip })),
    [list.entries],
  );

  const columns = useMemo<DataColumn<RowEntry>[]>(
    () => [
      {
        id: 'ip',
        header: 'IP / CIDR',
        sortValue: (r) => r.ip.toLowerCase(),
        render: (r) => (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              color: 'var(--text)',
              whiteSpace: 'nowrap',
            }}
          >
            {r.ip}
          </span>
        ),
      },
      {
        id: 'description',
        header: 'Description',
        sortValue: (r) => r.description.toLowerCase(),
        render: (r) =>
          r.description ? (
            <span style={{ color: 'var(--text-2)' }}>{r.description}</span>
          ) : (
            <span style={{ color: 'var(--dim)' }}>—</span>
          ),
      },
      {
        id: 'actions',
        header: '',
        width: 130,
        align: 'right',
        render: (r) => (
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <Btn
              kind="ghost"
              size="sm"
              icon={Icon.edit}
              onClick={(e) => {
                e.stopPropagation();
                setDialogError(null);
                setDialog({ kind: 'edit', entry: r });
              }}
            >
              Edit
            </Btn>
            <Btn
              kind="ghost"
              size="sm"
              icon={Icon.trash}
              onClick={(e) => {
                e.stopPropagation();
                void removeEntry(r);
              }}
              style={{ color: 'var(--danger)' }}
            >
              Remove
            </Btn>
          </div>
        ),
      },
    ],
    [],
  );

  function applyPushResponse(payload: CloudflarePushResponse): void {
    setList(payload.list);
    toast.push('Cloudflare updated.', 'ok');
  }

  async function handleConflict(): Promise<void> {
    toast.push('List was changed elsewhere — reloading.', 'warn');
    const fresh = await apiFetch<CloudflareIpListDto>(baseUrl);
    if (fresh.ok && fresh.data) setList(fresh.data);
  }

  async function addEntry(input: { ip: string; description: string }): Promise<void> {
    setSubmitting(true);
    setDialogError(null);
    const res = await apiFetch<CloudflarePushResponse>(`${baseUrl}/entries`, {
      method: 'POST',
      body: JSON.stringify({ ...input, entriesVersion: list.entriesVersion }),
    });
    setSubmitting(false);
    if (res.status === 409) {
      setDialog({ kind: 'closed' });
      await handleConflict();
      return;
    }
    if (!res.ok || !res.data) {
      const problem = res.problem as { detail?: string; title?: string } | undefined;
      setDialogError(problem?.detail ?? problem?.title ?? 'Could not add entry.');
      return;
    }
    setDialog({ kind: 'closed' });
    applyPushResponse(res.data);
  }

  async function updateEntry(
    entry: CloudflareIpEntryDto,
    input: { ip: string; description: string },
  ): Promise<void> {
    setSubmitting(true);
    setDialogError(null);
    const res = await apiFetch<CloudflarePushResponse>(
      `${baseUrl}/entries/${encodeURIComponent(entry.ip)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ ...input, entriesVersion: list.entriesVersion }),
      },
    );
    setSubmitting(false);
    if (res.status === 409) {
      setDialog({ kind: 'closed' });
      await handleConflict();
      return;
    }
    if (!res.ok || !res.data) {
      const problem = res.problem as { detail?: string; title?: string } | undefined;
      setDialogError(problem?.detail ?? problem?.title ?? 'Could not save entry.');
      return;
    }
    setDialog({ kind: 'closed' });
    applyPushResponse(res.data);
  }

  async function removeEntry(entry: CloudflareIpEntryDto): Promise<void> {
    if (!window.confirm(`Remove "${entry.ip}" from "${list.name}"?`)) return;
    const res = await apiFetch<CloudflarePushResponse>(
      `${baseUrl}/entries/${encodeURIComponent(entry.ip)}`,
      {
        method: 'DELETE',
        body: JSON.stringify({ entriesVersion: list.entriesVersion }),
      },
    );
    if (res.status === 409) {
      await handleConflict();
      return;
    }
    if (!res.ok || !res.data) {
      const problem = res.problem as { detail?: string; title?: string } | undefined;
      toast.push(problem?.detail ?? problem?.title ?? 'Could not remove entry.', 'danger');
      return;
    }
    applyPushResponse(res.data);
  }

  async function overwriteCloudflare(): Promise<void> {
    if (
      !window.confirm(
        `Overwrite Cloudflare list "${list.name}" with Weavestream's ${list.entries.length} ${list.entries.length === 1 ? 'entry' : 'entries'}? Any entries that exist only in Cloudflare will be removed.`,
      )
    ) {
      return;
    }
    setOverwriting(true);
    const res = await apiFetch<CloudflarePushResponse>(
      `${baseUrl}/overwrite-cloudflare`,
      {
        method: 'POST',
        body: JSON.stringify({ entriesVersion: list.entriesVersion }),
      },
    );
    setOverwriting(false);
    if (res.status === 409) {
      await handleConflict();
      return;
    }
    if (!res.ok || !res.data) {
      const problem = res.problem as { detail?: string; title?: string } | undefined;
      toast.push(problem?.detail ?? problem?.title ?? 'Could not push to Cloudflare.', 'danger');
      return;
    }
    applyPushResponse(res.data);
  }

  async function checkDrift(): Promise<void> {
    setDriftChecking(true);
    const res = await apiFetch<CloudflareIpListDto>(`${baseUrl}/drift-check`, {
      method: 'POST',
    });
    setDriftChecking(false);
    if (!res.ok || !res.data) {
      const problem = res.problem as { detail?: string; title?: string } | undefined;
      toast.push(problem?.detail ?? problem?.title ?? 'Drift check failed.', 'danger');
      return;
    }
    setList(res.data);
    if (res.data.driftStatus === 'in_sync') {
      toast.push('In sync with Cloudflare.', 'ok');
    } else if (res.data.driftStatus === 'drift_detected') {
      toast.push('Drift detected — see banner above.', 'warn');
    }
  }

  async function unregister(): Promise<void> {
    if (
      !window.confirm(
        `Stop managing "${list.name}" from Weavestream? Cloudflare's current list contents stay as-is.`,
      )
    ) {
      return;
    }
    setUnregistering(true);
    const res = await apiFetch<null>(baseUrl, { method: 'DELETE' });
    setUnregistering(false);
    if (!res.ok && res.status !== 204) {
      const problem = res.problem as { detail?: string; title?: string } | undefined;
      toast.push(problem?.detail ?? problem?.title ?? 'Could not unregister list.', 'danger');
      return;
    }
    toast.push('List unregistered.', 'ok');
    router.push(`/admin/integrations/${integration.id}?tab=lists`);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 18 }}>
      <DriftBanner list={list} onOverwrite={overwriteCloudflare} overwriting={overwriting} />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          fontSize: 12,
          color: 'var(--muted)',
        }}
      >
        <span>
          External list ID:{' '}
          <span
            style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-2)' }}
          >
            {list.externalListId}
          </span>
        </span>
        <span>·</span>
        <span>
          Last drift check:{' '}
          {list.lastDriftCheckAt ? relative(list.lastDriftCheckAt) : 'never'}
        </span>
        <span>·</span>
        <span>
          Last push: {list.lastPushedAt ? relative(list.lastPushedAt) : 'never'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Btn
          kind="primary"
          size="sm"
          icon={Icon.plus}
          onClick={() => {
            setDialogError(null);
            setDialog({ kind: 'add' });
          }}
        >
          Add entry
        </Btn>
        <Btn
          kind="outline"
          size="sm"
          icon={Icon.refresh}
          onClick={checkDrift}
          loading={driftChecking}
        >
          Check drift now
        </Btn>
        <Btn
          kind="ghost"
          size="sm"
          icon={Icon.trash}
          onClick={unregister}
          loading={unregistering}
          style={{ color: 'var(--danger)', marginLeft: 'auto' }}
        >
          Unregister list
        </Btn>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        empty="No entries yet — add one above."
        stickyColumns={0}
      />

      <EntryFormDialog
        open={dialog.kind !== 'closed'}
        initial={dialog.kind === 'edit' ? dialog.entry : null}
        onClose={() => setDialog({ kind: 'closed' })}
        submitting={submitting}
        error={dialogError}
        onSubmit={async (input) => {
          if (dialog.kind === 'edit') await updateEntry(dialog.entry, input);
          else if (dialog.kind === 'add') await addEntry(input);
        }}
      />
    </div>
  );
}
