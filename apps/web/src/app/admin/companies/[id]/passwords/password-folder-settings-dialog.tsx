'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { passwordFolderNameSchema } from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import {
  Btn,
  Dialog,
  Field,
  Input,
  Select,
  useToast,
} from '../../../../../components/ui';
import type { PasswordFolderRow } from '../../../../../lib/server-api';
import {
  buildPasswordFolderOptions,
  formatFolderOptionLabel,
} from '../../../../../lib/password-folder-tree';
import { extractProblemMessagePreferMessage as problemMessage } from '../../../../../lib/api-errors';

type Tab = 'rename' | 'move' | 'archive';

/**
 * Mirrors the articles `FolderSettingsDialog` but operates on the flat
 * `PasswordFolderRow[]` shape the passwords browser already uses, and
 * talks to `/companies/:companyId/password-folders/:id`.
 *
 * Password folder archive on the API always nulls `password.folderId`
 * (moves credentials to Unfiled) and blocks when active sub-folders
 * exist — so there's no cascade strategy to pick from like articles.
 */
export function PasswordFolderSettingsDialog({
  companyId,
  folder,
  allFolders,
  passwordCount,
  open,
  onClose,
  onArchived,
}: {
  companyId: string;
  folder: PasswordFolderRow;
  allFolders: PasswordFolderRow[];
  passwordCount: number;
  open: boolean;
  onClose: () => void;
  onArchived?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();

  const [tab, setTab] = useState<Tab>('rename');
  const [name, setName] = useState(folder.name);
  const [parentId, setParentId] = useState<string | null>(folder.parentId);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTab('rename');
    setName(folder.name);
    setParentId(folder.parentId);
    setError(null);
  }, [open, folder.id, folder.name, folder.parentId]);

  const hasSubfolders = useMemo(
    () =>
      allFolders.some((f) => f.parentId === folder.id && !f.archivedAt),
    [allFolders, folder.id],
  );
  const subfolderCount = useMemo(
    () =>
      allFolders.filter((f) => f.parentId === folder.id && !f.archivedAt)
        .length,
    [allFolders, folder.id],
  );
  const moveOptions = useMemo(
    () => buildPasswordFolderOptions(allFolders, folder.id),
    [allFolders, folder.id],
  );

  const nameDirty = name !== folder.name;
  const parentDirty = parentId !== folder.parentId;

  async function submitRename() {
    setError(null);
    const trimmed = name.trim();
    const parsed = passwordFolderNameSchema.safeParse(trimmed);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid name.');
      return;
    }
    setPending(true);
    const res = await apiFetch(
      `/companies/${companyId}/password-folders/${folder.id}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ name: trimmed }),
      },
    );
    setPending(false);
    if (!res.ok) {
      setError(problemMessage(res.problem) ?? 'Could not rename folder.');
      return;
    }
    toast.push('Folder renamed', 'ok');
    onClose();
    router.refresh();
  }

  async function submitMove() {
    setError(null);
    setPending(true);
    const res = await apiFetch(
      `/companies/${companyId}/password-folders/${folder.id}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ parentId }),
      },
    );
    setPending(false);
    if (!res.ok) {
      setError(problemMessage(res.problem) ?? 'Could not move folder.');
      return;
    }
    toast.push('Folder moved', 'ok');
    onClose();
    router.refresh();
  }

  async function submitArchive() {
    setError(null);
    if (hasSubfolders) return;
    setPending(true);
    const res = await apiFetch(
      `/companies/${companyId}/password-folders/${folder.id}`,
      { method: 'DELETE' },
    );
    setPending(false);
    if (!res.ok) {
      setError(problemMessage(res.problem) ?? 'Could not archive folder.');
      return;
    }
    toast.push('Folder archived', 'ok');
    onClose();
    onArchived?.();
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!pending) onClose();
      }}
      // A string rather than a composed node so the dialog keeps its
      // accessible name (`aria-label` falls back to undefined for a
      // ReactNode title). The `h2` wraps, so a long folder name is safe.
      title={`Folder settings · ${folder.name}`}
      width={460}
      footer={footerFor(tab, {
        pending,
        canRename: nameDirty,
        canMove: parentDirty,
        canArchive: !hasSubfolders,
        onCancel: onClose,
        onRename: submitRename,
        onMove: submitMove,
        onArchive: submitArchive,
      })}
    >
      <div
        role="tablist"
        aria-label="Folder settings"
        style={{
          display: 'flex',
          gap: 4,
          borderBottom: '1px solid var(--line)',
          marginBottom: 14,
        }}
      >
        {(['rename', 'move', 'archive'] as const).map((t) => {
          const active = tab === t;
          return (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                setTab(t);
                setError(null);
              }}
              style={{
                padding: '8px 12px',
                background: 'transparent',
                border: 'none',
                borderBottom: active
                  ? '2px solid var(--accent)'
                  : '2px solid transparent',
                color: active ? 'var(--text)' : 'var(--muted)',
                fontSize: 12.5,
                fontWeight: active ? 600 : 500,
                cursor: 'pointer',
                textTransform: 'capitalize',
              }}
            >
              {t}
            </button>
          );
        })}
      </div>

      {tab === 'rename' && (
        <Field
          label="Folder name"
          htmlFor="password-folder-rename"
          error={error ?? undefined}
        >
          <Input
            id="password-folder-rename"
            autoFocus
            value={name}
            disabled={pending}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && nameDirty) submitRename();
            }}
            maxLength={120}
          />
        </Field>
      )}

      {tab === 'move' && (
        <Field
          label="Parent folder"
          htmlFor="password-folder-parent"
          help="Self and any descendants are excluded."
          error={error ?? undefined}
        >
          <Select
            id="password-folder-parent"
            value={parentId ?? ''}
            disabled={pending}
            onChange={(e) => setParentId(e.target.value || null)}
          >
            <option value="">(top level)</option>
            {moveOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {formatFolderOptionLabel(opt)}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {tab === 'archive' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p
            style={{
              margin: 0,
              fontSize: 12.5,
              color: 'var(--muted)',
              lineHeight: 1.5,
            }}
          >
            Archiving{' '}
            <strong style={{ color: 'var(--text)', fontWeight: 600 }}>
              {folder.name}
            </strong>{' '}
            moves its credentials to Unfiled. The folder itself can be restored
            later — nothing is permanently deleted.
          </p>

          {hasSubfolders ? (
            <div
              style={{
                padding: '10px 12px',
                background: 'var(--panel-2)',
                border: '1px solid var(--line)',
                borderRadius: 5,
                fontSize: 12.5,
                color: 'var(--muted)',
              }}
            >
              This folder has {subfolderCount} subfolder
              {subfolderCount === 1 ? '' : 's'}. Archive or move
              {subfolderCount === 1 ? ' it' : ' them'} first.
            </div>
          ) : passwordCount > 0 ? (
            <div
              style={{
                padding: '10px 12px',
                background: 'var(--panel-2)',
                border: '1px solid var(--line)',
                borderRadius: 5,
                fontSize: 12.5,
                color: 'var(--muted)',
              }}
            >
              {passwordCount} credential{passwordCount === 1 ? '' : 's'} in this
              folder will be moved to Unfiled.
            </div>
          ) : null}

          {error && (
            <div role="alert" style={{ fontSize: 11.5, color: 'var(--danger)' }}>
              {error}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

function footerFor(
  tab: Tab,
  ctx: {
    pending: boolean;
    canRename: boolean;
    canMove: boolean;
    canArchive: boolean;
    onCancel: () => void;
    onRename: () => void;
    onMove: () => void;
    onArchive: () => void;
  },
) {
  const cancel = (
    <Btn kind="ghost" onClick={ctx.onCancel} disabled={ctx.pending}>
      Cancel
    </Btn>
  );
  if (tab === 'rename') {
    return (
      <>
        {cancel}
        <Btn
          kind="primary"
          onClick={ctx.onRename}
          loading={ctx.pending}
          disabled={!ctx.canRename || ctx.pending}
        >
          Rename
        </Btn>
      </>
    );
  }
  if (tab === 'move') {
    return (
      <>
        {cancel}
        <Btn
          kind="primary"
          onClick={ctx.onMove}
          loading={ctx.pending}
          disabled={!ctx.canMove || ctx.pending}
        >
          Move
        </Btn>
      </>
    );
  }
  return (
    <>
      {cancel}
      <Btn
        kind="danger"
        onClick={ctx.onArchive}
        loading={ctx.pending}
        disabled={!ctx.canArchive || ctx.pending}
      >
        Archive folder
      </Btn>
    </>
  );
}
