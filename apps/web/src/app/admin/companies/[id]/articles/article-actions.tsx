'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '../../../../../lib/api';
import { Btn, Dialog, Icon, useToast } from '../../../../../components/ui';

/**
 * Shared archive / restore / purge controls for a single article. Used in
 * three layouts:
 *   - `topbar`  : full-label buttons on the article read and edit headers.
 *   - `row`     : compact icon-only buttons appended to a list row.
 *
 * Mirrors the asset-actions pattern in
 * `apps/web/src/app/admin/companies/[id]/assets/[assetId]/asset-actions.tsx`.
 * The Purge endpoint requires the article to be archived first — the UI
 * gates that here so the destructive button only appears on archived rows
 * and only fires after a type-the-title confirmation.
 */
type ArticleLite = {
  id: string;
  companyId: string;
  title: string;
  archivedAt: string | null;
};

export function ArticleActions({
  article,
  layout,
  onAfter,
  dirty,
}: {
  article: ArticleLite;
  layout: 'topbar' | 'row';
  onAfter?: (event: 'archived' | 'restored' | 'purged') => void;
  /**
   * When the parent owns unsaved editor state (the Edit page), pass `true`
   * so the Archive confirm explains the changes will be discarded. Restore
   * and Purge don't need this signal.
   */
  dirty?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [purging, setPurging] = useState(false);
  const [pending, setPending] = useState(false);
  const [purgeText, setPurgeText] = useState('');

  const archived = !!article.archivedAt;

  async function toggleArchive() {
    setPending(true);
    const path = archived
      ? `/companies/${article.companyId}/articles/${article.id}/restore`
      : `/companies/${article.companyId}/articles/${article.id}`;
    const res = await apiFetch(path, { method: archived ? 'POST' : 'DELETE' });
    setPending(false);
    if (!res.ok) {
      toast.push(
        archived ? 'Could not restore article.' : 'Could not archive article.',
        'danger',
      );
      return;
    }
    toast.push(archived ? 'Article restored.' : 'Article archived.', 'ok');
    setConfirming(false);
    onAfter?.(archived ? 'restored' : 'archived');
    router.refresh();
  }

  async function permanentlyDelete() {
    setPending(true);
    const res = await apiFetch(
      `/companies/${article.companyId}/articles/${article.id}/purge`,
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
    toast.push('Article permanently deleted.', 'ok');
    setPurging(false);
    onAfter?.('purged');
    router.push(`/admin/companies/${article.companyId}/articles`);
    router.refresh();
  }

  const purgeConfirmReady = purgeText.trim() === article.title.trim();

  const isRow = layout === 'row';
  const btnSize = isRow ? 'sm' : 'md';

  return (
    <>
      <Btn
        kind={archived ? 'solid' : 'outline'}
        size={btnSize}
        icon={archived ? Icon.check : Icon.archive}
        iconOnly={isRow}
        onClick={(e) => {
          e.stopPropagation();
          setConfirming(true);
        }}
        title={archived ? 'Restore article' : 'Archive article'}
      >
        {isRow ? undefined : archived ? 'Restore' : 'Archive'}
      </Btn>
      {archived && (
        <Btn
          kind="danger"
          size={btnSize}
          icon={Icon.trash}
          iconOnly={isRow}
          onClick={(e) => {
            e.stopPropagation();
            setPurgeText('');
            setPurging(true);
          }}
          title="Permanently delete archived article"
        >
          {isRow ? undefined : 'Delete forever'}
        </Btn>
      )}
      <Dialog
        open={confirming}
        onClose={() => !pending && setConfirming(false)}
        title={archived ? 'Restore article?' : 'Archive article?'}
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
              kind={archived ? 'primary' : 'danger'}
              loading={pending}
              onClick={toggleArchive}
            >
              {archived ? 'Restore' : 'Archive'}
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
          {archived
            ? `${article.title} will reappear in the article list and become editable again.`
            : `${article.title} will be hidden from the default list. Content, attachments, and linked items are preserved and can be restored at any time.`}
        </p>
        {!archived && dirty && (
          <p
            style={{
              margin: '10px 0 0',
              fontSize: 12,
              color: 'var(--warn)',
              lineHeight: 1.5,
            }}
          >
            You have unsaved changes — archiving will discard them.
          </p>
        )}
      </Dialog>
      <Dialog
        open={purging}
        onClose={() => !pending && setPurging(false)}
        title="Permanently delete article?"
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p
            style={{
              margin: 0,
              fontSize: 13,
              color: 'var(--text-2)',
              lineHeight: 1.5,
            }}
          >
            <strong>{article.title}</strong> and all of its linked items will be
            removed. Embedded images are tombstoned with the article. This
            cannot be undone.
          </p>
          <label
            style={{
              fontSize: 11.5,
              fontFamily: 'var(--font-mono)',
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: 0.6,
            }}
          >
            Type the article title to confirm
            <input
              autoFocus
              value={purgeText}
              onChange={(e) => setPurgeText(e.target.value)}
              placeholder={article.title}
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
