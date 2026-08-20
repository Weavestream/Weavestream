'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
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
  RAIL_WIDTH,
  RailDisclosure,
  RailDivider,
  RailEditButton,
  RailRow,
  RailSection,
  RailTagRow,
  Tag,
} from '../../../../../components/ui';
import { useIsMobile } from '../../../../../lib/hooks/use-is-mobile';
import { useRailCollapse } from '../../../../../lib/hooks/use-rail-collapse';
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
  /**
   * The account's "Show item counts in the sidebar" preference, which
   * governs the totals beside folders and tags in the rail. Off by
   * default: the tree is a place, and the list one click away is the
   * truth. It also spares us an own-versus-subtree answer to get wrong.
   */
  showCounts: boolean;
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
 * Remembers a deliberate open/close of the folder rail. Its own key
 * rather than a field on the column blob above: that one is versioned
 * around the column set, and bumping it to add a rail flag would drop
 * every user's column choices for a cosmetic feature.
 */
const RAIL_PREF_KEY = 'weavestream.passwords.rail.v1';

/** How many tags the rail lists before the rest go behind "+N more". */
const TAG_PREVIEW_COUNT = 5;

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
  showCounts,
}: BrowserProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();
  const { collapsed: railCollapsed, setCollapsed: setRailCollapsed } =
    useRailCollapse(RAIL_PREF_KEY);
  const [isPending, startTransition] = useTransition();
  const [dialog, setDialog] = useState<DialogState>(
    openNew && canManage ? { kind: 'add', prefillAssetId } : null,
  );
  const [folderId, setFolderId] = useState<string | null | 'ALL'>('ALL');
  const [query, setQuery] = useState('');
  const [pickedTags, setPickedTags] = useState<string[]>([]);
  const [tagsExpanded, setTagsExpanded] = useState(false);
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

  /**
   * Everything the selected folder holds, before the search box and the
   * tag ticks narrow it further. This is the scope the tag list counts
   * against, so those numbers stay put while you type or tick rather
   * than reshuffling under the pointer.
   */
  const folderScope = useMemo(() => {
    if (folderId === null) return rows.filter((r) => !r.folderId);
    if (folderId === 'ALL') return rows;
    return rows.filter((r) => r.folderId === folderId);
  }, [rows, folderId]);

  /**
   * The rail's tag list, counted off the passwords in scope.
   *
   * Deliberately NOT `GET /tags`: that is the organisation-wide
   * vocabulary the tag input autocompletes against, and it carries every
   * tag that only ever touched an asset or an article. Listing those
   * here would offer filters that return nothing. Every row already
   * carries `tags`, so this costs no request either.
   *
   * Ticked tags sort to the front — including any that the current
   * folder has none of, which appear at zero rather than disappearing
   * and leaving an invisible filter behind.
   */
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tag of pickedTags) counts.set(tag, 0);
    for (const row of folderScope) {
      for (const tag of row.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    const picked = new Set(pickedTags);
    return Array.from(counts, ([name, count]) => ({ name, count })).sort(
      (a, b) => {
        const byPicked = Number(picked.has(b.name)) - Number(picked.has(a.name));
        if (byPicked !== 0) return byPicked;
        if (b.count !== a.count) return b.count - a.count;
        return a.name.localeCompare(b.name);
      },
    );
  }, [folderScope, pickedTags]);

  const visibleTags = useMemo(
    () => (tagsExpanded ? tagCounts : tagCounts.slice(0, TAG_PREVIEW_COUNT)),
    [tagCounts, tagsExpanded],
  );

  const filtered = useMemo(() => {
    let list = folderScope;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (r.username ?? '').toLowerCase().includes(q) ||
          (r.url ?? '').toLowerCase().includes(q) ||
          r.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }
    if (pickedTags.length > 0) {
      // Ticking two tags widens the result rather than narrowing it to
      // rows carrying both — "admin or m365" is what a list of ticks
      // reads as, and an AND of two tags is almost always empty.
      const picked = new Set(pickedTags);
      list = list.filter((r) => r.tags.some((t) => picked.has(t)));
    }
    return list;
  }, [folderScope, query, pickedTags]);

  function toggleTag(name: string) {
    setPickedTags((current) =>
      current.includes(name)
        ? current.filter((t) => t !== name)
        : [...current, name],
    );
  }

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
        borderBottom: '1px solid var(--line)',
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 10,
          padding: '10px 14px',
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        {!isMobile && (
          <button
            type="button"
            onClick={() => setRailCollapsed(!railCollapsed)}
            title={railCollapsed ? 'Show folders' : 'Hide folders'}
            aria-label={railCollapsed ? 'Show folders' : 'Hide folders'}
            aria-expanded={!railCollapsed}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              flexShrink: 0,
              background: railCollapsed ? 'var(--panel-2)' : 'transparent',
              border: '1px solid',
              borderColor: railCollapsed ? 'var(--line-3)' : 'var(--line-2)',
              borderRadius: 5,
              color: railCollapsed ? 'var(--text)' : 'var(--text-2)',
              cursor: 'pointer',
            }}
          >
            <Icon.panelRight size={13} />
          </button>
        )}
        {/* Folded away, the rail can no longer say what you are looking
            at — so the toolbar says it instead. */}
        {railCollapsed && folderId !== 'ALL' && (
          <button
            type="button"
            onClick={() => setRailCollapsed(false)}
            title="Show folders"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              height: 28,
              padding: '0 8px',
              flexShrink: 0,
              background: 'var(--panel-2)',
              border: '1px solid var(--line-2)',
              borderRadius: 5,
              fontSize: 12,
              color: 'var(--text-2)',
              cursor: 'pointer',
            }}
          >
            <Icon.folder size={11} style={{ color: 'var(--dim)' }} />
            {activeFolderLabel}
          </button>
        )}
        {/* Folded away, the rail's pencil goes with it — so the one
            control follows the folder's name into the toolbar and sits
            against the chip, rather than back at the far edge. */}
        {railCollapsed && canManage && selectedFolder && (
          <button
            type="button"
            onClick={() => setEditingFolder(true)}
            title={`Edit "${selectedFolder.name}"`}
            aria-label={`Edit folder ${selectedFolder.name}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              flexShrink: 0,
              background: 'transparent',
              border: '1px solid var(--line-2)',
              borderRadius: 5,
              color: 'var(--text-2)',
              cursor: 'pointer',
            }}
          >
            <Icon.edit size={12} />
          </button>
        )}
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
            placeholder="Search name, username, URL, or tag…"
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
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              title="Clear search"
              aria-label="Clear search"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--dim)',
                cursor: 'pointer',
                padding: 0,
                display: 'grid',
                placeItems: 'center',
              }}
            >
              <Icon.x size={10} />
            </button>
          )}
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
      </div>
      {pickedTags.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
            alignItems: 'center',
            padding: '0 14px 10px',
          }}
        >
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            Filtered by
          </span>
          {pickedTags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => toggleTag(tag)}
              title={`Remove "${tag}"`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                height: 20,
                padding: '0 4px 0 7px',
                background: 'var(--panel-2)',
                border: '1px solid var(--line-2)',
                borderRadius: 3,
                fontSize: 11,
                color: 'var(--text-2)',
                cursor: 'pointer',
              }}
            >
              {tag}
              <Icon.x size={9} style={{ color: 'var(--muted)' }} />
            </button>
          ))}
          {pickedTags.length > 1 && (
            <button
              type="button"
              onClick={() => setPickedTags([])}
              style={{
                background: 'transparent',
                border: 'none',
                fontSize: 11,
                color: 'var(--muted)',
                cursor: 'pointer',
                padding: '0 4px',
              }}
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );

  const foldersPane = (
    <aside
      style={{
        width: isMobile ? '100%' : RAIL_WIDTH,
        borderRight: isMobile ? 'none' : '1px solid var(--line)',
        padding: 8,
        // A deep folder tree scrolls in its own pane rather than setting
        // the height of its container and pushing the credential list's
        // scroll region off the bottom of a panel that clips overflow.
        overflowY: 'auto',
        // This pane is a column child on mobile (under the tab bar) and
        // a row child on desktop (the 220px rail). On mobile it has to
        // give up height to the bounded container and scroll what is
        // left; on desktop it must never give up width — hence the
        // axis-dependent flex rather than a single `flexShrink: 0`,
        // which on mobile is what left the lower folders unreachable.
        ...(isMobile ? { flex: 1, minHeight: 0 } : { flexShrink: 0 }),
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <RailRow
          active={folderId === 'ALL'}
          onClick={() => {
            setFolderId('ALL');
            if (isMobile) setMobileTab('passwords');
          }}
          icon={<Icon.grid size={12} />}
          label="All"
          count={rows.length}
          showCount={showCounts}
        />
        <RailRow
          active={folderId === null}
          onClick={() => {
            setFolderId(null);
            if (isMobile) setMobileTab('passwords');
          }}
          icon={<Icon.folder size={12} />}
          label="Unfiled"
          count={rows.filter((r) => !r.folderId).length}
          showCount={showCounts}
        />
      </div>

      <RailDivider />

      <RailSection
        label="Folders"
        action={
          canManage && !creatingFolder ? (
            // One plus for the whole tree. The per-row buttons are gone
            // and nothing went with them: `openCreateFolder(null)`
            // already defaults the parent to whatever is selected, and
            // the form's parent dropdown overrides that in one click.
            <button
              type="button"
              onClick={() => openCreateFolder(null)}
              title="New folder — nests under the selected folder"
              aria-label="New folder"
              className="sd-editor-btn"
              style={{ padding: 0, height: 18, width: 18, minWidth: 18 }}
            >
              <Icon.plus size={10} />
            </button>
          ) : undefined
        }
      />

      {canManage && creatingFolder && (
        <div
          style={{
            padding: 8,
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
              aria-label="Parent folder"
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
              Create folder
            </Btn>
          </div>
        </div>
      )}

      {folders.length === 0 && !creatingFolder && (
        <div style={{ padding: '6px 8px', fontSize: 12, color: 'var(--muted)' }}>
          No folders yet.
        </div>
      )}

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          marginTop: 2,
        }}
      >
        {folders
          .filter((f) => f.parentId === null)
          .map((f) => (
            <FolderSubtree
              key={f.id}
              folder={f}
              all={folders}
              rows={rows}
              active={folderId}
              setActive={(v) => {
                setFolderId(v);
                if (isMobile) setMobileTab('passwords');
              }}
              showCount={showCounts}
              canEdit={canManage}
              onEdit={() => setEditingFolder(true)}
              open={openFolders}
              setOpen={setOpenFolders}
            />
          ))}
      </div>

      {tagCounts.length > 0 && (
        <>
          <RailDivider />
          <RailSection label="Tags" />
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 1,
              marginTop: 2,
              // Expanded, a company with a long tag vocabulary scrolls
              // here rather than growing the rail past the fold.
              ...(tagsExpanded
                ? { maxHeight: 220, overflowY: 'auto' }
                : null),
            }}
          >
            {visibleTags.map((t) => (
              <RailTagRow
                key={t.name}
                name={t.name}
                count={t.count}
                showCount={showCounts}
                checked={pickedTags.includes(t.name)}
                onToggle={() => toggleTag(t.name)}
              />
            ))}
          </div>
          {tagCounts.length > TAG_PREVIEW_COUNT && (
            <button
              type="button"
              onClick={() => setTagsExpanded((v) => !v)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                height: 24,
                padding: '0 8px',
                marginTop: 1,
                background: 'transparent',
                border: 'none',
                borderRadius: 5,
                color: 'var(--muted)',
                fontSize: 11.5,
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              <span style={{ width: 12, flexShrink: 0 }} />
              {tagsExpanded
                ? 'Show fewer'
                : `${tagCounts.length - TAG_PREVIEW_COUNT} more…`}
            </button>
          )}
        </>
      )}
    </aside>
  );

  const passwordsPane = (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
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
          {pickedTags.length > 0
            ? `No credentials match, with ${pickedTags.length === 1 ? 'that tag' : 'those tags'} applied.`
            : 'No credentials match.'}
        </div>
      ) : (
        <DataTable
          fillHeight
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
    // `flex: 1; min-height: 0` so the DataTable's own fillHeight scroll
    // region claims the leftover viewport instead of the whole page
    // scrolling under it — the chain is PageBody -> Panel fillHeight ->
    // here -> the two-pane row -> DataTable fillHeight.
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
      }}
    >
      {toolbar}
      {isMobile ? (
        // `flex: 1; min-height: 0` for the same reason the desktop row
        // has it: the panel is height-constrained and clips its
        // overflow, so a content-height container here would push the
        // active pane's scroll region past the bottom edge and leave
        // the lower half of a long list with no way to reach it.
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            minHeight: 0,
          }}
        >
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
        // Was `min-height: 360` and free to grow; now it takes exactly
        // the height the toolbar leaves, and each pane scrolls inside it.
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {!railCollapsed && foldersPane}
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
        <div
          style={{
            opacity: p.archivedAt ? 0.55 : 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            // A row with no URL centres its name rather than shrinking.
            // The floor is the measured height of the two-line case
            // (18.8 + 2 gap + 16.5), so every row lands on the same
            // height whether or not the credential has a URL — this
            // cell is the tallest in the row, so it sets the rhythm.
            justifyContent: 'center',
            gap: 2,
            minHeight: 38,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              minWidth: 0,
            }}
          >
            {p.color && (
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: p.color,
                  flexShrink: 0,
                }}
              />
            )}
            <Link
              href={`/admin/companies/${companyId}/passwords/${p.id}`}
              style={{
                color: 'inherit',
                textDecoration: 'none',
                fontWeight: 500,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {p.name}
            </Link>
            {p.archivedAt && (
              <Tag tone="default" style={{ fontSize: 10, flexShrink: 0 }}>
                archived
              </Tag>
            )}
          </div>
          {p.url && (
            // Host only: the scheme and path are noise at this width, and
            // the full value stays one hover away.
            <div
              title={p.url}
              style={{
                marginLeft: p.color ? 14 : 0,
                fontSize: 11,
                color: 'var(--muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '100%',
              }}
            >
              {displayHost(p.url)}
            </div>
          )}
        </div>
      ),
    },
    {
      id: 'username',
      header: 'Username',
      width: 200,
      mono: true,
      sortValue: (p) => p.username?.toLowerCase() ?? null,
      render: (p) =>
        p.username ?? <span style={{ color: 'var(--faint)' }}>—</span>,
    },
    {
      id: 'otp',
      header: 'OTP',
      width: 150,
      sortValue: (p) => (p.hasTotp ? 1 : 0),
      render: (p) =>
        p.hasTotp && !p.archivedAt ? (
          <TotpCode companyId={companyId} passwordId={p.id} compact />
        ) : (
          <span style={{ color: 'var(--faint)', fontSize: 12 }}>—</span>
        ),
    },
    {
      id: 'actions',
      header: 'Actions',
      width: 116,
      align: 'right',
      sortable: false,
      render: (p) =>
        !p.archivedAt ? (
          <PasswordRowActions
            companyId={companyId}
            passwordId={p.id}
            username={p.username}
            url={p.url}
            requiresReason={p.requireReasonToView}
            recessive
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
      // "Health", not "Strength": the cell now carries the breach count
      // beside the score, and the two are one judgement about a
      // credential rather than two separate measurements.
      header: 'Health',
      width: 150,
      // Sorting still keys off the score alone. A breached-but-strong
      // password and a weak one are not on a single axis, and inventing
      // a composite here would make the column's order unexplainable.
      sortValue: (p) => p.passwordStrength ?? -1,
      render: (p) => (
        <PasswordStrengthMeter
          score={p.passwordStrength}
          width={110}
          trailing={<PwnedChip count={p.pwnedCount} />}
        />
      ),
    });
  }

  return columns;
}

/**
 * Strips the scheme, `www.`, and any path from a stored URL so the list
 * shows the host and nothing else. Anything that does not parse is
 * returned untouched — plenty of vault entries hold a bare hostname or
 * an IP, and mangling those would be worse than leaving them alone.
 */
function displayHost(raw: string): string {
  try {
    const parsed = new URL(raw);
    return parsed.host.replace(/^www\./, '');
  } catch {
    return raw;
  }
}

/**
 * Breach count beside the strength verdict. Compacted to two
 * significant figures — the exact number runs to eight digits, is wider
 * than the name it sits under, and nobody decides anything differently
 * at 1,579,235 than at "1.6M". The full figure stays in the tooltip.
 */
function PwnedChip({ count }: { count: number | null }) {
  if (!count || count <= 0) return null;
  return (
    // The tooltip lives on a wrapper rather than on `Tag`: the shared
    // component takes no `title`, and widening its API for one abbreviated
    // label is not the trade to make.
    <span
      title={`Seen in ${groupThousands(count)} known breaches`}
      style={{ display: 'inline-flex' }}
    >
      <Tag
        tone="danger"
        style={{
          fontSize: 10,
          height: 15,
          gap: 3,
          paddingLeft: 4,
          paddingRight: 4,
        }}
      >
        <Icon.warn size={9} />
        {compactCount(count)}
      </Tag>
    </span>
  );
}

/**
 * Thousands separators without `toLocaleString`. Hand-rolled because the
 * intl version varies with the runtime's ICU data, which is a hydration
 * mismatch waiting to happen — the same reason the lint rule bans it for
 * dates. Groups are the only formatting this needs.
 */
function groupThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function compactCount(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? Math.round(m) : m.toFixed(1)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
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

      {row.archivedAt && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
            alignItems: 'center',
          }}
        >
          <Tag tone="default">archived</Tag>
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
        <MobileCardRow label="Health">
          <PasswordStrengthMeter
            score={row.passwordStrength}
            trailing={<PwnedChip count={row.pwnedCount} />}
          />
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
            label="Health"
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
  active,
  setActive,
  showCount,
  canEdit,
  onEdit,
  open,
  setOpen,
}: {
  folder: PasswordFolderRow;
  all: PasswordFolderRow[];
  rows: PasswordSummary[];
  active: string | null | 'ALL';
  setActive: (v: string | null | 'ALL') => void;
  showCount: boolean;
  canEdit: boolean;
  onEdit: () => void;
  open: Record<string, boolean>;
  setOpen: (next: Record<string, boolean>) => void;
}) {
  const children = all.filter((f) => f.parentId === folder.id);
  const hasChildren = children.length > 0;
  const isOpen = !!open[folder.id];
  const isActive = active === folder.id;
  const count = rows.filter((r) => r.folderId === folder.id).length;
  return (
    <>
      <RailRow
        active={isActive}
        onClick={() => setActive(folder.id)}
        action={
          isActive && canEdit ? (
            <RailEditButton label={folder.name} onClick={onEdit} />
          ) : undefined
        }
        disclosure={
          hasChildren ? (
            <RailDisclosure
              open={isOpen}
              label={folder.name}
              onToggle={() => setOpen({ ...open, [folder.id]: !isOpen })}
            />
          ) : undefined
        }
        icon={
          <Icon.folder
            size={12}
            style={folder.color ? { color: folder.color } : undefined}
          />
        }
        label={folder.name}
        count={count}
        showCount={showCount}
      />
      {isOpen && hasChildren && (
        <div
          style={{
            // The guide line sits under the parent's chevron, so a deep
            // tree stays readable without indenting the labels off the
            // 220px rail.
            marginLeft: 13,
            paddingLeft: 8,
            borderLeft: '1px solid var(--line)',
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
          }}
        >
          {children.map((c) => (
            <FolderSubtree
              key={c.id}
              folder={c}
              all={all}
              rows={rows}
              active={active}
              setActive={setActive}
              showCount={showCount}
              canEdit={canEdit}
              onEdit={onEdit}
              open={open}
              setOpen={setOpen}
            />
          ))}
        </div>
      )}
    </>
  );
}
