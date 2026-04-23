'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '../../../../lib/api';
import { Btn, Dialog, useToast } from '../../../../components/ui';
import type { LayoutSummary, LayoutStats } from '../../../../lib/server-api';

/**
 * Archive / restore confirmation modal used from both the builder and
 * the layouts list. Archive is a soft-delete (`archivedAt` stamp) —
 * the asset FK is `onDelete: Restrict` so existing asset references
 * stay intact; the layout simply disappears from pickers and sidebars
 * until an operator restores it.
 */
export function LayoutArchiveDialog({
  layout,
  stats,
  open,
  onClose,
  onDone,
}: {
  layout: LayoutSummary;
  /** Optional — when provided, the archive copy cites real usage counts. */
  stats?: LayoutStats | null;
  open: boolean;
  onClose: () => void;
  onDone?: (next: LayoutSummary) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const archiving = !layout.archivedAt;

  async function submit() {
    setError(null);
    setPending(true);
    const path = archiving
      ? `/layouts/${layout.id}`
      : `/layouts/${layout.id}/restore`;
    const res = await apiFetch<LayoutSummary>(path, {
      method: archiving ? 'DELETE' : 'POST',
    });
    setPending(false);
    if (!res.ok) {
      const problem = res.problem as
        | { detail?: string; title?: string; message?: string }
        | undefined;
      setError(
        problem?.detail ??
          problem?.message ??
          problem?.title ??
          (archiving ? 'Could not archive layout.' : 'Could not restore layout.'),
      );
      return;
    }
    toast.push(archiving ? 'Layout archived' : 'Layout restored', 'ok');
    if (res.data) onDone?.(res.data);
    onClose();
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!pending) onClose();
      }}
      title={archiving ? 'Archive layout?' : 'Restore layout?'}
      footer={
        <>
          <Btn kind="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Btn>
          <Btn
            kind={archiving ? 'danger' : 'primary'}
            onClick={submit}
            loading={pending}
          >
            {archiving ? 'Archive' : 'Restore'}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <p
          style={{
            margin: 0,
            fontSize: 13,
            color: 'var(--text-2)',
            lineHeight: 1.5,
          }}
        >
          {archiving ? (
            <>
              <strong style={{ color: 'var(--text)' }}>{layout.name}</strong>{' '}
              will be hidden from the sidebar and from new-asset pickers.
              Existing assets keep their data and stay viewable.
            </>
          ) : (
            <>
              <strong style={{ color: 'var(--text)' }}>{layout.name}</strong>{' '}
              will reappear in the sidebar and new-asset pickers.
            </>
          )}
        </p>

        {archiving && stats && (stats.assetCount > 0 || stats.fieldCount > 0) && (
          <div
            style={{
              fontSize: 12,
              color: 'var(--muted)',
              background: 'var(--panel-2)',
              border: '1px solid var(--line-2)',
              borderRadius: 5,
              padding: '8px 10px',
              lineHeight: 1.45,
            }}
          >
            Currently used by{' '}
            <strong style={{ color: 'var(--text)' }}>
              {stats.assetCount} asset
              {stats.assetCount === 1 ? '' : 's'}
            </strong>{' '}
            across{' '}
            <strong style={{ color: 'var(--text)' }}>
              {stats.companyCount}{' '}
              {stats.companyCount === 1 ? 'company' : 'companies'}
            </strong>
            . These assets remain intact; archiving only hides the layout
            from active catalogs.
          </div>
        )}

        {error && (
          <div
            role="alert"
            style={{
              fontSize: 12,
              color: 'var(--danger)',
              background: 'color-mix(in oklch, var(--danger) 10%, transparent)',
              border: '1px solid color-mix(in oklch, var(--danger) 35%, transparent)',
              borderRadius: 5,
              padding: '8px 10px',
              lineHeight: 1.45,
            }}
          >
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
