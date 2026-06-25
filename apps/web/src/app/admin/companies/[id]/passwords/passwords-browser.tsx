'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from 'react';
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
import { PasswordFolderSettingsDialog } from './password-folder-settings-dialog';
import {
  buildPasswordFolderOptions,
  formatFolderOptionLabel,
} from '../../../../../lib/password-folder-tree';

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

type PasswordColumnPrefs = {
  showPortalVisibility: boolean;
  showStrength: boolean;
};

const PASSWORD_COLUMN_PREFS_KEY = 'weavestream.passwords.columns.v1';
const DEFAULT_COLUMN_PREFS: PasswordColumnPrefs = {
  showPortalVisibility: false,
  showStrength: true,
};

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
  const [columnPrefs, setColumnPrefs] = useState<PasswordColumnPrefs>(
    DEFAULT_COLUMN_PREFS,
  );
  const [columnPrefsLoaded, setColumnPrefsLoaded] = useState(false);
  const [editingFolder, setEditingFolder] = useState(false);
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>(() => {
    // Seed the tree with the first two levels expanded — matches the
    // articles browser so a fresh page load shows the top of the
    // hierarchy without requiring clicks.
    const seed: Record<string, boolean> = {};
    const byParent = new Map<string | null, PasswordFolderRow[]>();
    for (const f of folders) {
      if (f.archivedAt) continue;
      const list = byParent.get(f.parentId) ?? [];
      list.push(f);
      byParent.set(f.parentId, list);
    }
    const walk = (parentId: string | null, depth: number) => {
      const list = byParent.get(parentId) ?? [];
      for (const f of list) {
        if (depth < 2) seed[f.id] = true;
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return seed;
  });

  const selectedFolder = useMemo(
    () =>
      typeof folderId === 'string' && folderId !== 'ALL'
        ? folders.find((f) => f.id === folderId) ?? null
        : null,
    [folderId, folders],
  );
  const selectedFolderPasswordCount = useMemo(
    () =>
      selectedFolder
        ? rows.filter((r) => r.folderId === selectedFolder.id).length
        : 0,
    [rows, selectedFolder],
  );

  const includeArchived = searchParams.get('archived') === '1';

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PASSWORD_COLUMN_PREFS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PasswordColumnPrefs>;
        setColumnPrefs({
          showPortalVisibility:
            typeof parsed.showPortalVisibility === 'boolean'
              ? parsed.showPortalVisibility
              : DEFAULT_COLUMN_PREFS.showPortalVisibility,
          showStrength:
            typeof parsed.showStrength === 'boolean'
              ? parsed.showStrength
              : DEFAULT_COLUMN_PREFS.showStrength,
        });
      }
    } catch {
      // Ignore malformed or blocked storage and keep the default layout.
    } finally {
      setColumnPrefsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!columnPrefsLoaded) return;
    try {
      window.localStorage.setItem(
        PASSWORD_COLUMN_PREFS_KEY,
        JSON.stringify(columnPrefs),
      );
    } catch {
      // Column preferences are nice-to-have; the table still works without storage.
    }
  }, [columnPrefs, columnPrefsLoaded]);

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

  function closeDialog() {
    setDialog(null);
    if (searchParams.has('new')) {
      const params = new URLSearchParams(Array.from(searchParams.entries()));
      params.delete('new');
      const qs = params.toString();
      router.replace(qs ? `?${qs}` : '?', { scroll: false });
    }
  }

  useEffect(() => {
    if (openNew && canManage) setDialog({ kind: 'add', prefillAssetId });
  }, [openNew, canManage, prefillAssetId]);

  function openCreateFolder(parent: string | null = null) {
    setErr(null);
    setNewFolderName('');
    // Per-folder "+" buttons pass an explicit parent; the header "+"
    // falls back to the selected folder (if any) so adding "inside"
    // the current view nests naturally.
    if (parent !== null) {
      setNewFolderParent(parent);
    } else {
      setNewFolderParent(
        typeof folderId === 'string' && folderId !== 'ALL' ? folderId : null,
      );
    }
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
      <PasswordColumnsMenu value={columnPrefs} onChange={setColumnPrefs} />
      {canManage && selectedFolder && (
        <Btn
          kind="outline"
          size="sm"
          icon={Icon.edit}
          onClick={() => setEditingFolder(true)}
          title={`Edit folder "${selectedFolder.name}"`}
        >
          Edit
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
        icon={<Icon.grid size={12} style={{ color: 'var(--dim)' }} />}
        label="All"
        count={rows.length}
      />
      <FolderRow
        active={folderId === null}
        onClick={() => {
          setFolderId(null);
          if (isMobile) setMobileTab('passwords');
        }}
        icon={<Icon.folder size={12} style={{ color: 'var(--dim)' }} />}
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
            onClick={() => openCreateFolder(null)}
            title="New folder at root"
            className="sd-editor-btn"
            style={{ padding: 0, height: 18, width: 18 }}
          >
            <Icon.plus size={10} />
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
              {buildPasswordFolderOptions(folders).map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {formatFolderOptionLabel(opt)}
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
            canManage={canManage}
            onAddChild={(parentId) => openCreateFolder(parentId)}
            open={openFolders}
            setOpen={setOpenFolders}
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
          columns={passwordColumns({ companyId, columnPrefs })}
          rows={filtered}
          renderMobileCard={(p) => (
            <PasswordMobileBody
              row={p}
              companyId={companyId}
              columnPrefs={columnPrefs}
            />
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
          onCloseAction={closeDialog}
          onCreatedAction={() => {
            closeDialog();
            startTransition(() => router.refresh());
          }}
        />
      )}
      {selectedFolder && (
        <PasswordFolderSettingsDialog
          companyId={companyId}
          folder={selectedFolder}
          allFolders={folders}
          passwordCount={selectedFolderPasswordCount}
          open={editingFolder}
          onClose={() => setEditingFolder(false)}
          onArchived={() => setFolderId('ALL')}
        />
      )}
      {isPending && <div style={{ display: 'none' }} aria-hidden />}
    </div>
  );
}

function passwordColumns({
  companyId,
  columnPrefs,
}: {
  companyId: string;
  columnPrefs: PasswordColumnPrefs;
}): DataColumn<PasswordSummary>[] {
  const columns: DataColumn<PasswordSummary>[] = [
    {
      id: 'name',
      header: 'Name',
      width: 240,
      sortValue: (p) => p.name.toLowerCase(),
      render: (p) => (
        <div style={{ opacity: p.archivedAt ? 0.55 : 1, minWidth: 0 }}>
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
              title={p.url}
              style={{
                fontSize: 11,
                color: 'var(--muted)',
                marginTop: 2,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '100%',
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

  if (columnPrefs.showPortalVisibility) {
    columns.splice(2, 0, {
      id: 'visibility',
      header: 'Visibility',
      width: 140,
      sortValue: (p) => (p.visibleToClients ? 1 : 0),
      render: (p) => <PortalVisibilityTag visible={p.visibleToClients} />,
    });
  }

  if (columnPrefs.showStrength) {
    columns.splice(columnPrefs.showPortalVisibility ? 3 : 2, 0, {
      id: 'strength',
      header: 'Strength',
      width: 130,
      sortValue: (p) => p.passwordStrength ?? -1,
      render: (p) => (
        <PasswordStrengthMeter score={p.passwordStrength} width={110} />
      ),
    });
  }

  return columns;
}

function PasswordMobileBody({
  row,
  companyId,
  columnPrefs,
}: {
  row: PasswordSummary;
  companyId: string;
  columnPrefs: PasswordColumnPrefs;
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
      {columnPrefs.showPortalVisibility && (
        <MobileCardRow label="Visibility">
          <PortalVisibilityTag visible={row.visibleToClients} />
        </MobileCardRow>
      )}
      {columnPrefs.showStrength && (
        <MobileCardRow label="Strength">
          <PasswordStrengthMeter score={row.passwordStrength} />
        </MobileCardRow>
      )}
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

function PortalVisibilityTag({ visible }: { visible: boolean }) {
  return visible ? (
    <Tag tone="accent">client-visible</Tag>
  ) : (
    <Tag tone="outline">internal</Tag>
  );
}

function PasswordColumnsMenu({
  value,
  onChange,
}: {
  value: PasswordColumnPrefs;
  onChange: (next: PasswordColumnPrefs) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const customized =
    value.showPortalVisibility !== DEFAULT_COLUMN_PREFS.showPortalVisibility ||
    value.showStrength !== DEFAULT_COLUMN_PREFS.showStrength;

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function toggle(key: keyof PasswordColumnPrefs) {
    onChange({ ...value, [key]: !value[key] });
  }

  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Show or hide columns"
        aria-label="Show or hide columns"
        aria-expanded={open}
        aria-haspopup="menu"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          background: customized ? 'var(--accent-soft)' : 'transparent',
          border: '1px solid',
          borderColor: customized ? 'var(--accent-line)' : 'var(--line-2)',
          borderRadius: 5,
          color: customized ? 'var(--accent)' : 'var(--text-2)',
          cursor: 'pointer',
        }}
      >
        <Icon.eye size={13} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Password table columns"
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            minWidth: 210,
            background: 'var(--panel)',
            border: '1px solid var(--line-2)',
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            zIndex: 50,
            padding: 6,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <ColumnMenuItem
            checked={value.showPortalVisibility}
            label="Portal visibility"
            onClick={() => toggle('showPortalVisibility')}
          />
          <ColumnMenuItem
            checked={value.showStrength}
            label="Strength"
            onClick={() => toggle('showStrength')}
          />
        </div>
      )}
    </div>
  );
}

function ColumnMenuItem({
  checked,
  label,
  onClick,
}: {
  checked: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '7px 8px',
        background: checked ? 'var(--accent-soft)' : 'transparent',
        color: checked ? 'var(--accent)' : 'var(--text)',
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer',
        fontSize: 12.5,
        textAlign: 'left',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 14,
          height: 14,
          border: `1px solid ${checked ? 'var(--accent)' : 'var(--line-2)'}`,
          borderRadius: 3,
          display: 'grid',
          placeItems: 'center',
          flexShrink: 0,
          color: checked ? 'var(--accent)' : 'transparent',
          background: checked ? 'var(--accent-soft)' : 'var(--panel-2)',
        }}
      >
        <Icon.check size={10} />
      </span>
      <span>{label}</span>
    </button>
  );
}

function FolderSubtree({
  folder,
  all,
  rows,
  depth,
  active,
  setActive,
  canManage,
  onAddChild,
  open,
  setOpen,
}: {
  folder: PasswordFolderRow;
  all: PasswordFolderRow[];
  rows: PasswordSummary[];
  depth: number;
  active: string | null | 'ALL';
  setActive: (v: string | null | 'ALL') => void;
  canManage: boolean;
  onAddChild: (parentId: string) => void;
  open: Record<string, boolean>;
  setOpen: (next: Record<string, boolean>) => void;
}) {
  const children = all.filter((f) => f.parentId === folder.id);
  const hasChildren = children.length > 0;
  const isOpen = !!open[folder.id];
  const count = rows.filter((r) => r.folderId === folder.id).length;
  return (
    <>
      <FolderRow
        active={active === folder.id}
        onClick={() => {
          if (hasChildren) setOpen({ ...open, [folder.id]: !isOpen });
          setActive(folder.id);
        }}
        icon={
          hasChildren ? (
            <Icon.chevronD
              size={10}
              style={{
                transform: isOpen ? 'none' : 'rotate(-90deg)',
                color: folder.color ?? 'var(--dim)',
                transition: 'transform 120ms ease',
              }}
            />
          ) : (
            <Icon.folder
              size={12}
              style={{ color: folder.color ?? 'var(--dim)' }}
            />
          )
        }
        label={folder.name}
        count={count}
        depth={depth}
        right={
          canManage ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onAddChild(folder.id);
              }}
              className="sd-editor-btn"
              style={{ padding: 0, height: 18, width: 18 }}
              title="New subfolder"
            >
              <Icon.plus size={10} />
            </button>
          ) : undefined
        }
      />
      {isOpen &&
        children.map((c) => (
          <FolderSubtree
            key={c.id}
            folder={c}
            all={all}
            rows={rows}
            depth={depth + 1}
            active={active}
            setActive={setActive}
            canManage={canManage}
            onAddChild={onAddChild}
            open={open}
            setOpen={setOpen}
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
  depth = 0,
  right,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  count: number;
  depth?: number;
  right?: ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
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
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          flex: 1,
          minWidth: 0,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 14,
            height: 14,
            display: 'inline-grid',
            placeItems: 'center',
            flexShrink: 0,
          }}
        >
          {icon}
        </span>
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
      </span>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{count}</span>
        {right}
      </span>
    </div>
  );
}
