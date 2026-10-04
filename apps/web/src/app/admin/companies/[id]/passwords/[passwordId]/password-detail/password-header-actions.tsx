'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type {
  PasswordDetail,
  PasswordFolderSchema,
  PasswordGeneratorDefaults,
} from '@weavestream/shared';
import { problemMessage } from '@weavestream/shared';
import { apiFetch } from '../../../../../../../lib/api';
import {
  Btn,
  Dialog,
  Icon,
  MenuDivider,
  MenuItem,
  OverflowMenu,
  StarGlyph,
  useStarToggle,
  useToast,
} from '../../../../../../../components/ui';
import { EditPasswordDialog } from './edit-password-dialog';

/**
 * The credential's whole action cluster, rendered into `TopBar`'s
 * `right` slot.
 *
 * One primary control plus an overflow menu, replacing the Star · Edit ·
 * Archive shelf that used to sit in the page header's second row. Star
 * moves into the menu because the global cluster two icons to the right
 * already carries one for *starred items*.
 *
 * Unlike assets and articles, Edit here opens a dialog rather than
 * navigating, so the primary is a `Btn` and not a `LinkBtn`. There is no
 * purge endpoint for a credential, so an archived password's menu holds
 * the star alone — Restore is the whole write surface.
 *
 * Copies `ArticleHeaderActions` in
 * `apps/web/src/app/admin/companies/[id]/articles/[articleId]/article-header-actions.tsx`.
 */
export function PasswordHeaderActions({
  companyId,
  password,
  folders,
  canManage,
  generatorDefaults,
}: {
  companyId: string;
  password: PasswordDetail;
  folders: PasswordFolderSchema[];
  canManage: boolean;
  generatorDefaults: PasswordGeneratorDefaults;
}) {
  const router = useRouter();
  const toast = useToast();
  const [, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const { starred, toggle } = useStarToggle({
    entityType: 'password',
    entityId: password.id,
    initialStarred: password.isStarred,
  });
  // Archive confirms (Phase 4 — passwords were the one record type
  // whose archive fired on a bare click; assets and articles already
  // confirm). Restore stays one-click: it is the undo.
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [archivePending, setArchivePending] = useState(false);

  async function archive() {
    setArchivePending(true);
    try {
      const res = await apiFetch(`/companies/${companyId}/passwords/${password.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        toast.push(
          problemMessage(res.problem) ?? 'Archive failed',
          'danger',
        );
        return;
      }
      setConfirmingArchive(false);
      toast.push('Password archived', 'ok');
      startTransition(() => router.refresh());
    } finally {
      setArchivePending(false);
    }
  }

  async function restore() {
    const res = await apiFetch(`/companies/${companyId}/passwords/${password.id}/restore`, {
      method: 'POST',
    });
    if (!res.ok) {
      toast.push(
        problemMessage(res.problem) ?? 'Restore failed',
        'danger',
      );
      return;
    }
    toast.push('Password restored', 'ok');
    startTransition(() => router.refresh());
  }

  const archived = !!password.archivedAt;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {canManage &&
        (archived ? (
          // Edit is unavailable while archived, so the primary slot
          // carries the action that makes it available again rather
          // than sitting empty. Restore stays one-click — it is the undo.
          <Btn kind="solid" size="md" icon={Icon.check} onClick={() => void restore()}>
            Restore
          </Btn>
        ) : (
          <Btn kind="outline" size="md" icon={Icon.edit} onClick={() => setEditing(true)}>
            Edit
          </Btn>
        ))}

      <OverflowMenu>
        {(close) => (
          <>
            <MenuItem
              glyph={<StarGlyph filled={starred} size={14} />}
              onClick={() => {
                void toggle();
              }}
            >
              {starred ? 'Starred' : 'Star'}
            </MenuItem>
            {canManage && !archived && <MenuDivider />}
            {canManage && !archived && (
              <MenuItem
                icon={Icon.archive}
                onClick={() => {
                  setConfirmingArchive(true);
                  close();
                }}
              >
                Archive
              </MenuItem>
            )}
          </>
        )}
      </OverflowMenu>

      <Dialog
        open={confirmingArchive}
        onClose={() => !archivePending && setConfirmingArchive(false)}
        title="Archive password?"
        footer={
          <>
            <Btn kind="ghost" onClick={() => setConfirmingArchive(false)} disabled={archivePending}>
              Cancel
            </Btn>
            <Btn kind="danger" loading={archivePending} onClick={() => void archive()}>
              Archive
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
          {password.name} will be hidden from the default list. The credential and its links are
          preserved and can be restored at any time.
        </p>
      </Dialog>

      {editing && (
        <EditPasswordDialog
          companyId={companyId}
          password={password}
          folders={folders}
          generatorDefaults={generatorDefaults}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            toast.push('Password updated', 'ok');
            startTransition(() => router.refresh());
          }}
        />
      )}
    </div>
  );
}
