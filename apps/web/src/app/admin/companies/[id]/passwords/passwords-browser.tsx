'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import type {
  PasswordFolderRow,
  PasswordSummary,
} from '../../../../../lib/server-api';
import type { PasswordGeneratorDefaults } from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import {
  Btn,
  DataTable,
  type DataColumn,
  Icon,
  MobileCardRow,
  Tag,
} from '../../../../../components/ui';
import { useIsMobile } from '../../../../../lib/hooks/use-is-mobile';
import { PasswordStrengthMeter } from '../../../../../components/passwords/password-strength-meter';
import { CreatePasswordDialog } from '../../../../../components/passwords/create-password-dialog';
import { PasswordRowActions } from '../../../../../components/passwords/password-row-actions';
import { TotpCode } from '../../../../../components/passwords/totp-code';

interface BrowserProps {
  companyId: string;
  rows: PasswordSummary[];
  folders: PasswordFolderRow[];
  canManage: boolean;
  openNew?: boolean;
  prefillAssetId?: string;
  generatorDefaults: PasswordGeneratorDefaults;
}

type DialogState =
  | { kind: 'add'; prefillAssetId?: string }
  | { kind: 'edit'; row: PasswordSummary }
  | null;

/**
 * Phase 10 — admin passwords vault browser.
 *
 * Desktop layout is a two-pane split:
 *   - Left: folder tree (synthetic "All" + "Unfiled" rows on top).
 *   - Right: filterable list of rows in the selected folder.
 *
 * On phones we swap to the same tabbed pattern the articles browser
 * uses (folders | passwords) and render every password as a
 * standardized mobile card — so the data-dense table doesn't get
 * squeezed into unreadable cells.
 */
export function PasswordsBrowser({
  companyId,
  rows,
  folders,
  canManage,
  openNew,
  prefillAssetId,
  generatorDefaults,
}: BrowserProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();
  const [isPending, startTransition] = useTransition();
  const [dialog, setDialog] = useState<DialogState>(
    openNew && canManage ? { kind: 'add', prefillAssetId } : null,
  );
  const [folderId, setFolderId] = useState<string | null | 'ALL'>('ALL');
  const [query, setQuery] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [mobileTab, setMobileTab] = useState<'folders' | 'passwords'>(
    'passwords',
  );

  const includeArchived = searchParams.get('archived') === '1';

  const filtered = useMemo(() => {
    let list = rows;
    if (folderId === null) list = list.filter((r) => !r.folderId);
    else if (folderId !== 'ALL') list = list.filter((r) => r.folderId === folderId);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (r.username ?? '').toLowerCase().includes(q) ||
          (r.url ?? '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [rows, folderId, query]);

  const activeFolderLabel = useMemo(() => {
    if (folderId === 'ALL') return 'All';
    if (folderId === null) return 'Unfiled';
    return folders.find((f) => f.id === folderId)?.name ?? 'Folder';
  }, [folderId, folders]);

  function toggleArchived() {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    if (includeArchived) params.delete('archived');
    else params.set('archived', '1');
    router.push(`?${params.toString()}`);
  }

  function openCreateFolder() {
    setErr(null);
    setNewFolderName('');
    // Seed parent to the currently-selected folder when it's a real
    // row (so "New folder" inside a selected folder nests it naturally).
    setNewFolderParent(
      typeof folderId === 'string' && folderId !== 'ALL' ? folderId : null,
    );
    setCreatingFolder(true);
  }

  async function submitCreateFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    setFolderBusy(true);
    const res = await apiFetch(`/companies/${companyId}/password-folders`, {
      method: 'POST',
      body: JSON.stringify({ name, parentId: newFolderParent }),
    });
    setFolderBusy(false);
    if (!res.ok) {
      setErr(
        (res.problem as { message?: string } | undefined)?.message ??
          'Create folder failed',
      );
      return;
    }
    setCreatingFolder(false);
    setNewFolderName('');
    startTransition(() => router.refresh());
  }

  const toolbar = (
    <div
      style={{
        display: 'flex',
        gap: 10,
        padding: '10px 14px',
        borderBottom: '1px solid var(--line)',
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      <div
        style={{
          flex: 1,
          minWidth: 180,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 28,
          padding: '0 10px',
          background: 'var(--panel-2)',
          border: '1px solid var(--line)',
          borderRadius: 5,
        }}
      >
        <Icon.search size={12} style={{ color: 'var(--muted)' }} />
        <input
          placeholder="Search name, username, or URL…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            fontSize: 12.5,
            color: 'var(--text)',
          }}
        />
      </div>
      <button
        type="button"
        onClick={toggleArchived}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 28,
          padding: '0 10px',
          background: includeArchived ? 'var(--panel-2)' : 'transparent',
          border: '1px solid var(--line-2)',
          borderRadius: 5,
          fontSize: 12,
          color: 'var(--text-2)',
          cursor: 'pointer',
        }}
      >
        <Icon.archive size={12} />
        {includeArchived ? 'Hide archived' : 'Show archived'}
      </button>
      {canManage && (
        <Btn
          kind="primary"
          size="sm"
          onClick={() => setDialog({ kind: 'add', prefillAssetId })}
        >
          <Icon.plus size={14} /> New password
        </Btn>
      )}
    </div>
  );

  const foldersPane = (
    <aside
      style={{
        width: isMobile ? '100%' : 220,
        borderRight: isMobile ? 'none' : '1px solid var(--line)',
        padding: '10px 0',
        flexShrink: 0,
      }}
    >
      <FolderRow
        active={folderId === 'ALL'}
        onClick={() => {
          setFolderId('ALL');
          if (isMobile) setMobileTab('passwords');
        }}
        icon="box"
        label="All"
        count={rows.length}
      />
      <FolderRow
        active={folderId === null}
        onClick={() => {
          setFolderId(null);
          if (isMobile) setMobileTab('passwords');
        }}
        icon="box"
        label="Unfiled"
        count={rows.filter((r) => !r.folderId).length}
      />
      <div
        style={{
          marginTop: 10,
          padding: '0 14px',
          fontSize: 11,
          textTransform: 'uppercase',
          color: 'var(--muted)',
          letterSpacing: 0.4,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
        }}
      >
        <span>Folders</span>
        {canManage && !creatingFolder && (
          <button
            type="button"
            onClick={openCreateFolder}
            title="New folder"
            style={{
              background: 'transparent',
              border: 0,
              padding: 0,
              cursor: 'pointer',
              color: 'var(--accent)',
              fontSize: 11,
              textTransform: 'none',
              letterSpacing: 0,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
            }}
          >
            <Icon.plus size={11} /> New
          </button>
        )}
      </div>
      {canManage && creatingFolder && (
        <div
          style={{
            padding: '8px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            borderTop: '1px solid var(--line)',
            borderBottom: '1px solid var(--line)',
            marginTop: 6,
            background: 'var(--panel-2)',
          }}
        >
          <input
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitCreateFolder();
              if (e.key === 'Escape') setCreatingFolder(false);
            }}
            placeholder="Folder name"
            style={{
              width: '100%',
              padding: '4px 6px',
              border: '1px solid var(--line)',
              borderRadius: 5,
              fontSize: 12,
              background: 'var(--panel)',
              color: 'var(--text)',
            }}
          />
          {folders.length > 0 && (
            <select
              value={newFolderParent ?? ''}
              onChange={(e) => setNewFolderParent(e.target.value || null)}
              style={{
                width: '100%',
                padding: '4px 6px',
                border: '1px solid var(--line)',
                borderRadius: 5,
                fontSize: 12,
                background: 'var(--panel)',
                color: 'var(--text)',
              }}
            >
              <option value="">(top level)</option>
              {folders
                .filter((f) => !f.archivedAt)
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
            </select>
          )}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <Btn size="sm" onClick={() => setCreatingFolder(false)}>
              Cancel
            </Btn>
            <Btn
              size="sm"
              kind="primary"
              disabled={folderBusy || !newFolderName.trim()}
              onClick={() => void submitCreateFolder()}
            >
              Create
            </Btn>
          </div>
        </div>
      )}
      {folders.length === 0 && !creatingFolder && (
        <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--muted)' }}>
          No folders yet.
        </div>
      )}
      {folders
        .filter((f) => f.parentId === null)
        .map((f) => (
          <FolderSubtree
            key={f.id}
            folder={f}
            all={folders}
            rows={rows}
            depth={0}
            active={folderId}
            setActive={(v) => {
              setFolderId(v);
              if (isMobile) setMobileTab('passwords');
            }}
          />
        ))}
    </aside>
  );

  const passwordsPane = (
    <div style={{ flex: 1, minWidth: 0 }}>
      {err && (
        <div
          style={{
            padding: '10px 14px',
            background: 'var(--danger-soft)',
            color: 'var(--danger)',
            fontSize: 12,
          }}
        >
          {err}
        </div>
      )}
      {filtered.length === 0 ? (
        <div
          style={{
            padding: '40px 14px',
            textAlign: 'center',
            color: 'var(--muted)',
          }}
        >
          No credentials match.
        </div>
      ) : (
        <DataTable
          columns={passwordColumns({ companyId })}
          rows={filtered}
          renderMobileCard={(p) => (
            <PasswordMobileBody row={p} companyId={companyId} />
          )}
        />
      )}
    </div>
  );

  return (
    <div>
      {toolbar}
      {isMobile ? (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            role="tablist"
            aria-label="Passwords view"
            style={{
              display: 'flex',
              borderBottom: '1px solid var(--line)',
              background: 'var(--panel)',
            }}
          >
            {(
              [
                { id: 'folders', label: `Folders · ${activeFolderLabel}` },
                { id: 'passwords', label: `Passwords · ${filtered.length}` },
              ] as const
            ).map((t) => {
              const active = mobileTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setMobileTab(t.id)}
                  style={{
                    flex: 1,
                    padding: '10px 12px',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: active
                      ? '2px solid var(--accent)'
                      : '2px solid transparent',
                    color: active ? 'var(--text)' : 'var(--muted)',
                    fontSize: 12.5,
                    fontWeight: active ? 600 : 500,
                    cursor: 'pointer',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
          {mobileTab === 'folders' ? foldersPane : passwordsPane}
        </div>
      ) : (
        <div style={{ display: 'flex', minHeight: 360 }}>
          {foldersPane}
          {passwordsPane}
        </div>
      )}

      {dialog?.kind === 'add' && (
        <CreatePasswordDialog
          companyId={companyId}
          folders={folders}
          folderId={folderId === 'ALL' ? null : folderId}
          assetId={dialog.prefillAssetId}
          generatorDefaults={generatorDefaults}
          onClose={() => setDialog(null)}
          onCreated={() => {
            setDialog(null);
            startTransition(() => router.refresh());
          }}
        />
      )}
      {isPending && <div style={{ display: 'none' }} aria-hidden />}
    </div>
  );
}

function passwordColumns({
  companyId,
}: {
  companyId: string;
}): DataColumn<PasswordSummary>[] {
  return [
    {
      id: 'name',
      header: 'Name',
      width: 240,
      sortValue: (p) => p.name.toLowerCase(),
      render: (p) => (
        <div style={{ opacity: p.archivedAt ? 0.55 : 1 }}>
          <Link
            href={`/admin/companies/${companyId}/passwords/${p.id}`}
            style={{
              color: 'inherit',
              textDecoration: 'none',
              fontWeight: 500,
            }}
          >
            {p.color && (
              <span
                style={{
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: p.color,
                  marginRight: 6,
                }}
              />
            )}
            {p.name}
          </Link>
          <div
            style={{
              display: 'flex',
              gap: 4,
              flexWrap: 'wrap',
              marginTop: 4,
            }}
          >
            {(p.pwnedCount ?? 0) > 0 && (
              <Tag tone="danger" style={{ fontSize: 10 }}>
                pwned ×{p.pwnedCount}
              </Tag>
            )}
            {p.archivedAt && (
              <Tag tone="default" style={{ fontSize: 10 }}>
                archived
              </Tag>
            )}
          </div>
          {p.url && (
            <div
              style={{
                fontSize: 11,
                color: 'var(--muted)',
                marginTop: 2,
              }}
            >
              {p.url}
            </div>
          )}
        </div>
      ),
    },
    {
      id: 'username',
      header: 'Username',
      width: 220,
      mono: true,
      sortValue: (p) => p.username?.toLowerCase() ?? null,
      render: (p) => p.username ?? '—',
    },
    {
      id: 'strength',
      header: 'Strength',
      width: 130,
      sortValue: (p) => p.passwordStrength ?? -1,
      render: (p) => (
        <PasswordStrengthMeter score={p.passwordStrength} width={110} />
      ),
    },
    {
      id: 'otp',
      header: 'OTP',
      width: 170,
      sortValue: (p) => (p.hasTotp ? 1 : 0),
      render: (p) =>
        p.hasTotp && !p.archivedAt ? (
          <TotpCode companyId={companyId} passwordId={p.id} compact />
        ) : (
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>—</span>
        ),
    },
    {
      id: 'actions',
      header: 'Actions',
      width: 150,
      sortable: false,
      render: (p) =>
        !p.archivedAt ? (
          <PasswordRowActions
            companyId={companyId}
            passwordId={p.id}
            username={p.username}
            url={p.url}
            requiresReason={p.requireReasonToView}
          />
        ) : null,
    },
  ];
}

function PasswordMobileBody({
  row,
  companyId,
}: {
  row: PasswordSummary;
  companyId: string;
}) {
  const detailHref = `/admin/companies/${companyId}/passwords/${row.id}`;
  return (
    <div
      style={{
        opacity: row.archivedAt ? 0.7 : 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <Link
        href={detailHref}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          color: 'inherit',
          textDecoration: 'none',
          minWidth: 0,
        }}
      >
        <div
          aria-hidden
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            background: row.color ?? 'var(--panel-2)',
            border: '1px solid var(--line)',
            display: 'grid',
            placeItems: 'center',
            color: 'var(--text)',
            flexShrink: 0,
          }}
        >
          <Icon.lock size={14} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              color: 'var(--text)',
              fontWeight: 600,
              fontSize: 14,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {row.name}
          </div>
          {row.url && (
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {row.url}
            </div>
          )}
        </div>
        <Icon.chevron size={12} style={{ color: 'var(--dim)' }} />
      </Link>

      {((row.pwnedCount ?? 0) > 0 || row.archivedAt) && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
            alignItems: 'center',
          }}
        >
          {(row.pwnedCount ?? 0) > 0 && (
            <Tag tone="danger">pwned ×{row.pwnedCount}</Tag>
          )}
          {row.archivedAt && <Tag tone="default">archived</Tag>}
        </div>
      )}

      {row.username && (
        <MobileCardRow label="Username" mono>
          {row.username}
        </MobileCardRow>
      )}
      <MobileCardRow label="Strength">
        <PasswordStrengthMeter score={row.passwordStrength} />
      </MobileCardRow>
      {row.hasTotp && !row.archivedAt && (
        <MobileCardRow label="OTP">
          <TotpCode companyId={companyId} passwordId={row.id} compact />
        </MobileCardRow>
      )}

      {!row.archivedAt && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            paddingTop: 4,
            borderTop: '1px dashed var(--line)',
          }}
        >
          <PasswordRowActions
            companyId={companyId}
            passwordId={row.id}
            username={row.username}
            url={row.url}
            requiresReason={row.requireReasonToView}
          />
        </div>
      )}
    </div>
  );
}

function FolderSubtree({
  folder,
  all,
  rows,
  depth,
  active,
  setActive,
}: {
  folder: PasswordFolderRow;
  all: PasswordFolderRow[];
  rows: PasswordSummary[];
  depth: number;
  active: string | null | 'ALL';
  setActive: (v: string | null | 'ALL') => void;
}) {
  const children = all.filter((f) => f.parentId === folder.id);
  const count = rows.filter((r) => r.folderId === folder.id).length;
  return (
    <>
      <FolderRow
        active={active === folder.id}
        onClick={() => setActive(folder.id)}
        icon={(folder.icon as never) ?? 'box'}
        label={folder.name}
        color={folder.color ?? undefined}
        count={count}
        depth={depth}
      />
      {children.map((c) => (
        <FolderSubtree
          key={c.id}
          folder={c}
          all={all}
          rows={rows}
          depth={depth + 1}
          active={active}
          setActive={setActive}
        />
      ))}
    </>
  );
}

function FolderRow({
  active,
  onClick,
  icon,
  label,
  count,
  color,
  depth = 0,
}: {
  active: boolean;
  onClick: () => void;
  icon: string;
  label: string;
  count: number;
  color?: string;
  depth?: number;
}) {
  void icon;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: `6px 14px 6px ${14 + depth * 12}px`,
        background: active ? 'var(--panel-2)' : 'transparent',
        color: active ? 'var(--fg)' : 'var(--muted)',
        border: 0,
        cursor: 'pointer',
        fontSize: 13,
        textAlign: 'left',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            width: 10,
            height: 10,
            borderRadius: 3,
            background: color ?? 'var(--line-2)',
          }}
        />
        {label}
      </span>
      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{count}</span>
    </button>
  );
}

