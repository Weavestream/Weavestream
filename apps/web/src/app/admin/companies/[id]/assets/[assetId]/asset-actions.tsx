'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '../../../../../../lib/api';
import {
  Btn,
  Dialog,
  Icon,
  StarButton,
  useToast,
} from '../../../../../../components/ui';
import type { AssetSummary } from '../../../../../../lib/server-api';

export function AssetActions({ asset }: { asset: AssetSummary }) {
  const router = useRouter();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [purging, setPurging] = useState(false);
  const [pending, setPending] = useState(false);
  const [purgeText, setPurgeText] = useState('');

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

  async function permanentlyDelete() {
    setPending(true);
    const res = await apiFetch(
      `/companies/${asset.companyId}/assets/${asset.id}/purge`,
      { method: 'POST' },
    );
    setPending(false);
    if (!res.ok) {
      const problem = res.problem as { detail?: string; title?: string } | null;
      toast.push(
        problem?.detail ?? problem?.title ?? 'Permanent delete failed.',
        'danger',
      );
      return;
    }
    toast.push('Asset permanently deleted.', 'ok');
    setPurging(false);
    router.push(
      `/admin/companies/${asset.companyId}/assets?layout=${asset.assetLayoutId}`,
    );
    router.refresh();
  }

  const purgeConfirmReady = purgeText.trim() === asset.name.trim();

  return (
    <>
      <StarButton
        entityType="asset"
        entityId={asset.id}
        initialStarred={asset.isStarred}
        showLabel
        iconSize={14}
      />
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
      {asset.archivedAt && (
        <Btn
          kind="danger"
          size="md"
          icon={Icon.trash}
          onClick={() => {
            setPurgeText('');
            setPurging(true);
          }}
        >
          Delete forever
        </Btn>
      )}
      <Btn
        kind="primary"
        size="md"
        icon={Icon.plus}
        onClick={() =>
          router.push(
            `/admin/companies/${asset.companyId}/assets/new?layout=${asset.assetLayoutId}`,
          )
        }
      >
        New
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
      <Dialog
        open={purging}
        onClose={() => !pending && setPurging(false)}
        title="Permanently delete asset?"
        footer={
          <>
            <Btn
              kind="ghost"
              onClick={() => setPurging(false)}
              disabled={pending}
            >
              Cancel
            </Btn>
            <Btn
              kind="danger"
              loading={pending}
              disabled={!purgeConfirmReady}
              onClick={permanentlyDelete}
            >
              Delete forever
            </Btn>
          </>
        }
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: 13,
              color: 'var(--text-2)',
              lineHeight: 1.5,
            }}
          >
            <strong>{asset.name}</strong> and all of its field values, sync
            records, and relation links will be removed. Any embedded
            credentials are unlinked but preserved.
          </p>
          {asset.externalSource && (
            <p
              style={{
                margin: 0,
                fontSize: 12.5,
                color: 'var(--warn)',
                lineHeight: 1.5,
              }}
            >
              The next <strong>{asset.externalSource}</strong>  sync may
              re-create this asset if the upstream record still exists. Adjust
              the integration&apos;s match-keys first if you don&apos;t want
              that.
            </p>
          )}
          <label
            style={{
              fontSize: 11.5,
              fontFamily: 'var(--font-mono)',
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: 0.6,
            }}
          >
            Type the asset name to confirm
            <input
              autoFocus
              value={purgeText}
              onChange={(e) => setPurgeText(e.target.value)}
              placeholder={asset.name}
              style={{
                marginTop: 6,
                width: '100%',
                padding: '8px 10px',
                fontSize: 13,
                fontFamily: 'var(--font-mono)',
                background: 'var(--panel-2)',
                border: '1px solid var(--line-2)',
                borderRadius: 6,
                color: 'var(--text)',
              }}
            />
          </label>
        </div>
      </Dialog>
    </>
  );
}
