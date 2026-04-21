'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '../../../../../../lib/api';
import {
  Btn,
  Dialog,
  Icon,
  useToast,
} from '../../../../../../components/ui';
import type { AssetSummary } from '../../../../../../lib/server-api';

export function AssetActions({ asset }: { asset: AssetSummary }) {
  const router = useRouter();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  async function toggleArchive() {
    setPending(true);
    const path = asset.archivedAt
      ? `/companies/${asset.companyId}/assets/${asset.id}/restore`
      : `/companies/${asset.companyId}/assets/${asset.id}`;
    const res = await apiFetch(path, {
      method: asset.archivedAt ? 'POST' : 'DELETE',
    });
    setPending(false);
    if (!res.ok) {
      toast.push('Operation failed.', 'danger');
      return;
    }
    toast.push(asset.archivedAt ? 'Asset restored.' : 'Asset archived.', 'ok');
    setConfirming(false);
    router.refresh();
  }

  return (
    <>
      {!asset.archivedAt && (
        <Btn
          kind="outline"
          size="md"
          icon={Icon.edit}
          onClick={() =>
            router.push(
              `/admin/companies/${asset.companyId}/assets/${asset.id}/edit`,
            )
          }
        >
          Edit
        </Btn>
      )}
      <Btn
        kind={asset.archivedAt ? 'solid' : 'outline'}
        size="md"
        icon={asset.archivedAt ? Icon.check : Icon.archive}
        onClick={() => setConfirming(true)}
      >
        {asset.archivedAt ? 'Restore' : 'Archive'}
      </Btn>
      <Dialog
        open={confirming}
        onClose={() => !pending && setConfirming(false)}
        title={asset.archivedAt ? 'Restore asset?' : 'Archive asset?'}
        footer={
          <>
            <Btn
              kind="ghost"
              onClick={() => setConfirming(false)}
              disabled={pending}
            >
              Cancel
            </Btn>
            <Btn
              kind={asset.archivedAt ? 'primary' : 'danger'}
              loading={pending}
              onClick={toggleArchive}
            >
              {asset.archivedAt ? 'Restore' : 'Archive'}
            </Btn>
          </>
        }
      >
        <p
          style={{
            margin: 0,
            fontSize: 13,
            color: 'var(--text-2)',
            lineHeight: 1.5,
          }}
        >
          {asset.archivedAt
            ? `${asset.name} will reappear in the asset list and become editable again.`
            : `${asset.name} will be hidden from the default list view. Field values and Relation links are preserved and can be restored at any time.`}
        </p>
      </Dialog>
    </>
  );
}
