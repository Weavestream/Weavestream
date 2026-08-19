'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { folderNameSchema } from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import { Btn, Dialog, Field, Input, Select, useToast } from '../../../../../components/ui';
import type { FolderNode } from '../../../../../lib/server-api';
import { extractProblemMessagePreferMessage as problemMessage } from '../../../../../lib/api-errors';

type Cascade = 'unassign' | 'archive';
type Tab = 'rename' | 'move' | 'archive';

export function FolderSettingsDialog({
  companyId,
  folder,
  allFolders,
  open,
  onClose,
  onArchived,
}: {
  companyId: string;
  folder: FolderNode;
  allFolders: FolderNode[];
  open: boolean;
  onClose: () => void;
  onArchived?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();

  const [tab, setTab] = useState<Tab>('rename');
  const [name, setName] = useState(folder.name);
  const [parentId, setParentId] = useState<string | null>(folder.parentId);
  const [cascade, setCascade] = useState<Cascade | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Re-seed local state every time the dialog opens or the source folder
  // changes, so a cancelled edit never leaks into the next open.
  useEffect(() => {
    if (!open) return;
    setTab('rename');
    setName(folder.name);
    setParentId(folder.parentId);
    setCascade(null);
    setError(null);
  }, [open, folder.id, folder.name, folder.parentId]);

  const hasSubfolders = folder.children.length > 0;
  const articleCount = folder.articleCount;
  const moveOptions = useMemo(
    () => buildMoveOptions(allFolders, folder.id),
    [allFolders, folder.id],
  );

  const nameDirty = name !== folder.name;
  const parentDirty = parentId !== folder.parentId;
  const cascadeReady =
    !hasSubfolders && (articleCount === 0 || cascade !== null);

  async function submitRename() {
    setError(null);
    const trimmed = name.trim();
    const parsed = folderNameSchema.safeParse(trimmed);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid name.');
      return;
    }
    setPending(true);
    const res = await apiFetch(
      `/companies/${companyId}/folders/${folder.id}`,
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
      `/companies/${companyId}/folders/${folder.id}`,
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
    if (articleCount > 0 && !cascade) return;
    setPending(true);
    const body: { articles?: Cascade } = {};
    if (articleCount > 0 && cascade) body.articles = cascade;
    const res = await apiFetch(
      `/companies/${companyId}/folders/${folder.id}`,
      {
        method: 'DELETE',
        body: JSON.stringify(body),
      },
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
      title="Folder settings"
      width={460}
      footer={footerFor(tab, {
        pending,
        canRename: nameDirty,
        canMove: parentDirty,
        canArchive: cascadeReady,
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
          htmlFor="folder-rename"
          error={error ?? undefined}
        >
          <Input
            id="folder-rename"
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
          htmlFor="folder-parent"
          help="Self and any descendants are excluded."
          error={error ?? undefined}
        >
          <Select
            id="folder-parent"
            value={parentId ?? ''}
            disabled={pending}
            onChange={(e) => setParentId(e.target.value || null)}
          >
            <option value="">(root)</option>
            {moveOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {' '.repeat(opt.depth * 2)}
                {opt.depth > 0 ? '↳ ' : ''}
                {opt.name}
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
            Archiving hides the folder. It can be restored later — nothing is
            permanently deleted.
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
              This folder has {folder.children.length} subfolder
              {folder.children.length === 1 ? '' : 's'}. Archive or move
              {folder.children.length === 1 ? ' it' : ' them'} first.
            </div>
          ) : articleCount > 0 ? (
            <Field
              label={`This folder contains ${articleCount} article${articleCount === 1 ? '' : 's'}`}
              error={error ?? undefined}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <CascadeOption
                  checked={cascade === 'unassign'}
                  onChange={() => setCascade('unassign')}
                  label="Move articles to Unfiled"
                  hint="Articles are kept and moved to the company's Unfiled list."
                  disabled={pending}
                />
                <CascadeOption
                  checked={cascade === 'archive'}
                  onChange={() => setCascade('archive')}
                  label="Archive articles"
                  hint="Articles are archived along with the folder. Toggle “Show archived” to find them."
                  disabled={pending}
                />
              </div>
            </Field>
          ) : (
            error && (
              <div role="alert" style={{ fontSize: 11.5, color: 'var(--danger)' }}>
                {error}
              </div>
            )
          )}
        </div>
      )}
    </Dialog>
  );
}

function CascadeOption({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  hint: string;
  disabled: boolean;
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '8px 10px',
        border: `1px solid ${checked ? 'var(--accent-line)' : 'var(--line)'}`,
        background: checked ? 'var(--panel-2)' : 'transparent',
        borderRadius: 5,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <input
        type="radio"
        name="folder-archive-cascade"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        style={{ accentColor: 'var(--accent)', marginTop: 2 }}
      />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 12.5, color: 'var(--text)' }}>{label}</span>
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{hint}</span>
      </span>
    </label>
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

/**
 * Flatten the tree into a depth-tagged list, omitting the folder being
 * edited and any of its descendants — a folder cannot become its own
 * parent or grandchild. Server-side `assertNoCycle` is the safety net.
 */
function buildMoveOptions(
  tree: FolderNode[],
  excludeId: string,
): { id: string; name: string; depth: number }[] {
  const out: { id: string; name: string; depth: number }[] = [];
  const walk = (nodes: FolderNode[], depth: number, skip: boolean) => {
    for (const n of nodes) {
      const dropSubtree = skip || n.id === excludeId;
      if (!dropSubtree) {
        out.push({ id: n.id, name: n.name, depth });
      }
      walk(n.children, depth + 1, dropSubtree);
    }
  };
  walk(tree, 0, false);
  return out;
}
