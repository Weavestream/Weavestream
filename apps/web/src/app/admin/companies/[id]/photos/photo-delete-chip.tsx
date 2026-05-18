'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Btn, Dialog, Icon, useToast } from '../../../../../components/ui';
import { apiFetch } from '../../../../../lib/api';
import type { UploadSummary } from '../../../../../lib/server-api';

/**
 * Photos-page delete chip. Renders an inline trash button on tiles
 * that the server has classified as `orphan` or `archived`. The
 * confirm dialog spells out the link state so operators understand
 * what they're tombstoning, and the API endpoint re-checks the state
 * server-side so a stale UI cannot remove a live or history-only
 * image.
 *
 * The chip is a client island so the rest of the photos page can
 * stay server-rendered.
 */
export function PhotoDeleteChip({
  photo,
  state,
}: {
  photo: UploadSummary;
  state: 'orphan' | 'archived';
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const toast = useToast();

  const stateCopy =
    state === 'orphan'
      ? 'orphaned (not referenced by any article)'
      : 'only reachable through an archived article';

  const handleConfirm = async () => {
    setBusy(true);
    const res = await apiFetch(
      `/companies/${photo.companyId}/photos/${photo.id}`,
      { method: 'DELETE' },
    );
    setBusy(false);
    if (!res.ok) {
      const problem = res.problem as { message?: string } | undefined;
      toast.push(problem?.message ?? 'Could not delete photo.', 'danger');
      return;
    }
    setOpen(false);
    toast.push('Photo deleted.', 'default');
    startTransition(() => router.refresh());
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Delete this ${state} image`}
        aria-label={`Delete this ${state} image`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 6px',
          borderRadius: 4,
          fontSize: 10.5,
          fontFamily: 'var(--font-mono)',
          lineHeight: 1,
          whiteSpace: 'nowrap',
          color: 'var(--danger)',
          background: 'var(--danger-soft)',
          border: '1px solid transparent',
          cursor: 'pointer',
        }}
      >
        <Icon.trash size={10} />
        <span>Delete</span>
      </button>
      <Dialog
        open={open}
        onClose={() => (!busy ? setOpen(false) : undefined)}
        title="Delete photo?"
        footer={
          <Footer
            busy={busy || pending}
            onCancel={() => setOpen(false)}
            onConfirm={handleConfirm}
          />
        }
      >
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text)' }}>
          Permanently remove{' '}
          <strong style={{ wordBreak: 'break-all' }}>{photo.filename}</strong>?
        </p>
        <p
          style={{
            margin: '10px 0 0',
            fontSize: 12,
            color: 'var(--muted)',
            lineHeight: 1.5,
          }}
        >
          This image is {stateCopy}. The upload row will be soft-deleted —
          the file bytes stay on disk until the storage reaper runs.
        </p>
      </Dialog>
    </>
  );
}

function Footer({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactNode {
  return (
    <>
      <Btn kind="ghost" onClick={onCancel} disabled={busy}>
        Cancel
      </Btn>
      <Btn kind="danger" onClick={onConfirm} disabled={busy}>
        {busy ? 'Deleting…' : 'Delete'}
      </Btn>
    </>
  );
}
