'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import type {
  ArticleSummary,
  FolderNode,
} from '../../../../../lib/server-api';
import { apiFetch } from '../../../../../lib/api';
import { FormattedDate } from '../../../../../lib/timezone-context';
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
  Tag,
  useToast,
} from '../../../../../components/ui';
import { useIsMobile } from '../../../../../lib/hooks/use-is-mobile';
import { useRailCollapse } from '../../../../../lib/hooks/use-rail-collapse';
import { FolderSettingsDialog } from './folder-settings-dialog';
import { ArticleActions } from './article-actions';
import { articleCounts, scopeArticles } from './article-scope';

type ArticleCounts = ReturnType<typeof articleCounts>;

/** Remembers a deliberate open/close of this rail; see `useRailCollapse`. */
const ARTICLES_RAIL_PREF_KEY = 'weavestream.articles.rail.v1';

/**
 * Two-column article browser:
 *   - Left: collapsible folder tree. Clicking a folder filters the list.
 *     `+` at the root or on a folder opens the inline create form.
 *   - Right: article list with a search box and an `archived` toggle.
 *
 * Server provides the whole company scope for the current `archived`
 * setting. Folder clicks push `?folderId=…` so a view stays linkable,
 * but the narrowing itself — folder, then title — happens here, over the
 * rows already in hand. The rail counts the same array, so a number
 * never describes a scope the list does not show.
 */
export function ArticlesBrowser({
  companyId,
  folders,
  articles,
  q,
  folderId,
  includeArchived,
  canManage,
  showCounts,
}: {
  companyId: string;
  folders: FolderNode[];
  articles: ArticleSummary[];
  /** Seeds the search box from a shared link. Not a server filter. */
  q: string;
  folderId: string;
  includeArchived: boolean;
  canManage: boolean;
  /**
   * The account's "Show item counts in the sidebar" preference, same
   * switch the passwords rail reads. Off by default.
   */
  showCounts: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const isMobile = useIsMobile();
  const { collapsed: railCollapsed, setCollapsed: setRailCollapsed } =
    useRailCollapse(ARTICLES_RAIL_PREF_KEY);
  const [mobileTab, setMobileTab] = useState<'folders' | 'articles'>('articles');
  const [query, setQuery] = useState(q);
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>(
    () => {
      const seed: Record<string, boolean> = {};
      const walk = (list: FolderNode[], depth: number) => {
        for (const f of list) {
          if (depth < 2) seed[f.id] = true;
          walk(f.children, depth + 1);
        }
      };
      walk(folders, 0);
      return seed;
    },
  );

  function nav(next: Record<string, string | null>) {
    const sp = new URLSearchParams(params.toString());
    // `q` is client state now. It only ever arrives as a seed, so
    // carrying it into the next URL would resurrect, on the next reload,
    // a search the user has already typed past.
    sp.delete('q');
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') sp.delete(k);
      else sp.set(k, v);
    }
    router.push(`/admin/companies/${companyId}/articles?${sp.toString()}`);
  }

  const activeFolderId = folderId || 'all';

  /** Everything the selected rail row holds, before the search box. */
  const folderScope = useMemo(
    () => scopeArticles(articles, folders, activeFolderId),
    [articles, folders, activeFolderId],
  );

  /** Every number the rail shows, off the array the list renders. */
  const counts = useMemo(
    () => articleCounts(articles, folders),
    [articles, folders],
  );

  /**
   * Same match the server's `q` ran — title `contains`, case-insensitive
   * — so moving it here changes when it runs, not what it finds.
   */
  const needle = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      needle
        ? folderScope.filter((a) => a.title.toLowerCase().includes(needle))
        : folderScope,
    [folderScope, needle],
  );
  const [editingFolder, setEditingFolder] = useState(false);
  const selectedFolder = useMemo(
    () =>
      activeFolderId !== 'all' && activeFolderId !== 'root'
        ? findFolder(folders, activeFolderId)
        : null,
    [folders, activeFolderId],
  );

  const foldersPane = (
    <aside
      style={{
        width: isMobile ? '100%' : RAIL_WIDTH,
        borderRight: isMobile ? 'none' : '1px solid var(--line)',
        padding: 8,
        // A deep tree scrolls in its own pane rather than setting the
        // height of its container and pushing the list's scroll region
        // off the bottom of a panel that clips overflow.
        overflowY: 'auto',
        ...(isMobile ? { flex: 1, minHeight: 0 } : { flexShrink: 0 }),
      }}
    >
      <FolderTreeNav
        folders={folders}
        open={openFolders}
        setOpen={setOpenFolders}
        activeId={activeFolderId}
        onSelect={(id) => {
          nav({ folderId: id });
          if (isMobile) setMobileTab('articles');
        }}
        counts={counts}
        companyId={companyId}
        canManage={canManage}
        showCounts={showCounts}
        onEditFolder={() => setEditingFolder(true)}
      />
    </aside>
  );

  const toolbar = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        borderBottom: '1px solid var(--line)',
        background: 'var(--panel)',
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
      {railCollapsed && selectedFolder && (
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
          {selectedFolder.name}
        </button>
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flex: 1,
          minWidth: 180,
          background: 'var(--panel-2)',
          border: '1px solid var(--line)',
          borderRadius: 5,
          height: 28,
          padding: '0 10px',
        }}
      >
        <Icon.search size={12} style={{ color: 'var(--muted)' }} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search titles…"
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
        onClick={() => nav({ archived: includeArchived ? null : '1' })}
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
    </div>
  );

  const articlesPane = (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      {filtered.length === 0 ? (
        <div
          style={{
            padding: '40px 14px',
            textAlign: 'center',
            color: 'var(--muted)',
            fontSize: 12.5,
          }}
        >
          {needle
            ? `No articles match "${query.trim()}".`
            : 'No articles in this view yet.'}
        </div>
      ) : (
        <DataTable
          fillHeight
          // Fixed layout, and no pinned column: Title declares no width,
          // so it takes whatever is left after the two tight columns on
          // the right — at every window size, rather than at the one a
          // pixel value would have been correct for.
          layout="fixed"
          stickyColumns={0}
          columns={articleColumns({ companyId, canManage })}
          rows={filtered}
          renderMobileCard={(a) => (
            <ArticleMobileBody row={a} companyId={companyId} canManage={canManage} />
          )}
        />
      )}
    </div>
  );

  const folderDialog = selectedFolder && (
    <FolderSettingsDialog
      companyId={companyId}
      folder={selectedFolder}
      allFolders={folders}
      open={editingFolder}
      onClose={() => setEditingFolder(false)}
      onArchived={() => nav({ folderId: null })}
    />
  );

  if (isMobile) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minHeight: 0,
        }}
      >
        {toolbar}
        <div
          role="tablist"
          aria-label="Articles view"
          style={{
            display: 'flex',
            borderBottom: '1px solid var(--line)',
            background: 'var(--panel)',
          }}
        >
          {(['folders', 'articles'] as const).map((t) => {
            const active = mobileTab === t;
            return (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setMobileTab(t)}
                style={{
                  flex: 1,
                  padding: '10px 12px',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: active
                    ? '2px solid var(--accent)'
                    : '2px solid transparent',
                  color: active ? 'var(--text)' : 'var(--muted)',
                  fontSize: 13,
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
        {mobileTab === 'folders' ? foldersPane : articlesPane}
        {folderDialog}
      </div>
    );
  }

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
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {!railCollapsed && foldersPane}
        {articlesPane}
      </div>
      {folderDialog}
    </div>
  );
}

function articleColumns({
  companyId,
  canManage,
}: {
  companyId: string;
  canManage: boolean;
}): DataColumn<ArticleSummary>[] {
  const columns: DataColumn<ArticleSummary>[] = [
    {
      id: 'title',
      // No width on purpose: under `layout="fixed"` the columns that
      // declare none share the remainder, and this is the only one.
      header: 'Title',
      sortValue: (a) => a.title.toLowerCase(),
      render: (a) => (
        <div
          style={{
            opacity: a.archivedAt ? 0.55 : 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            // An article with no excerpt centres its title rather than
            // shrinking, so row height holds whatever the data carries.
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
            <Icon.doc size={12} style={{ color: 'var(--dim)', flexShrink: 0 }} />
            <Link
              href={`/admin/companies/${companyId}/articles/${a.id}`}
              style={{
                color: 'inherit',
                textDecoration: 'none',
                fontWeight: 500,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {a.title}
            </Link>
            {!a.visibleToClients && (
              <Tag tone="outline" style={{ fontSize: 10, flexShrink: 0 }}>
                internal
              </Tag>
            )}
            {a.archivedAt && (
              <Tag tone="default" style={{ fontSize: 10, flexShrink: 0 }}>
                archived
              </Tag>
            )}
          </div>
          {a.excerpt && (
            <div
              title={a.excerpt}
              style={{
                marginLeft: 18,
                fontSize: 11,
                color: 'var(--muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '100%',
              }}
            >
              {a.excerpt}
            </div>
          )}
        </div>
      ),
    },
    {
      id: 'updated',
      header: 'Updated',
      width: 110,
      sortValue: (a) => a.updatedAt,
      render: (a) => (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
          <FormattedDate value={a.updatedAt} />
        </span>
      ),
    },
  ];

  if (canManage) {
    columns.push({
      id: 'actions',
      header: 'Actions',
      width: 96,
      align: 'right',
      sortable: false,
      render: (a) => (
        <ArticleActions
          article={{
            id: a.id,
            companyId,
            title: a.title,
            archivedAt: a.archivedAt,
          }}
          recessive
        />
      ),
    });
  }

  return columns;
}

function ArticleMobileBody({
  row,
  companyId,
  canManage,
}: {
  row: ArticleSummary;
  companyId: string;
  canManage: boolean;
}) {
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
        href={`/admin/companies/${companyId}/articles/${row.id}`}
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
            background: 'var(--panel-2)',
            border: '1px solid var(--line)',
            display: 'grid',
            placeItems: 'center',
            color: 'var(--dim)',
            flexShrink: 0,
          }}
        >
          <Icon.doc size={14} />
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
            {row.title}
          </div>
          {row.excerpt && (
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {row.excerpt}
            </div>
          )}
        </div>
        <Icon.chevron size={12} style={{ color: 'var(--dim)' }} />
      </Link>

      {(!row.visibleToClients || row.archivedAt) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {!row.visibleToClients && <Tag tone="outline">internal</Tag>}
          {row.archivedAt && <Tag tone="default">archived</Tag>}
        </div>
      )}

      <MobileCardRow label="Updated">
        <FormattedDate value={row.updatedAt} />
      </MobileCardRow>

      {canManage && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            paddingTop: 4,
            borderTop: '1px dashed var(--line)',
          }}
        >
          <ArticleActions
            article={{
              id: row.id,
              companyId,
              title: row.title,
              archivedAt: row.archivedAt,
            }}
          />
        </div>
      )}
    </div>
  );
}

function findFolder(tree: FolderNode[], id: string): FolderNode | null {
  for (const node of tree) {
    if (node.id === id) return node;
    const hit = findFolder(node.children, id);
    if (hit) return hit;
  }
  return null;
}

function FolderTreeNav({
  folders,
  open,
  setOpen,
  activeId,
  onSelect,
  counts,
  companyId,
  canManage,
  showCounts,
  onEditFolder,
}: {
  folders: FolderNode[];
  open: Record<string, boolean>;
  setOpen: (next: Record<string, boolean>) => void;
  activeId: string;
  onSelect: (id: string) => void;
  counts: ArticleCounts;
  companyId: string;
  canManage: boolean;
  showCounts: boolean;
  onEditFolder: () => void;
}) {
  const [creating, setCreating] = useState<string | 'root' | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <RailRow
          icon={<Icon.grid size={12} />}
          label="All articles"
          active={activeId === 'all'}
          onClick={() => onSelect('')}
          count={counts.all}
          showCount={showCounts}
        />
        <RailRow
          icon={<Icon.folder size={12} />}
          label="Unfiled"
          active={activeId === 'root'}
          onClick={() => onSelect('root')}
          count={counts.unfiled}
          showCount={showCounts}
        />
      </div>

      <RailDivider />

      <RailSection
        label="Folders"
        action={
          canManage && creating === null ? (
            // One plus for the whole tree, as in the passwords rail. The
            // inline form it opens takes the parent from the selection,
            // so per-row buttons bought nothing but noise.
            <button
              type="button"
              onClick={() =>
                setCreating(
                  activeId && activeId !== 'all' && activeId !== 'root'
                    ? activeId
                    : 'root',
                )
              }
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

      {creating === 'root' && (
        <NewFolderInline
          companyId={companyId}
          parentId={null}
          onDone={() => setCreating(null)}
        />
      )}

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          marginTop: 2,
        }}
      >
        <FolderSubtree
          nodes={folders}
          open={open}
          setOpen={setOpen}
          activeId={activeId}
          onSelect={onSelect}
          creating={creating}
          setCreating={setCreating}
          counts={counts}
          companyId={companyId}
          canManage={canManage}
          showCounts={showCounts}
          onEditFolder={onEditFolder}
        />
      </div>
    </div>
  );
}

function FolderSubtree({
  nodes,
  open,
  setOpen,
  activeId,
  onSelect,
  creating,
  setCreating,
  counts,
  companyId,
  canManage,
  showCounts,
  onEditFolder,
}: {
  nodes: FolderNode[];
  open: Record<string, boolean>;
  setOpen: (next: Record<string, boolean>) => void;
  activeId: string;
  onSelect: (id: string) => void;
  creating: string | 'root' | null;
  setCreating: (v: string | 'root' | null) => void;
  counts: ArticleCounts;
  companyId: string;
  canManage: boolean;
  showCounts: boolean;
  onEditFolder: () => void;
}) {
  return (
    <>
      {nodes.map((f) => {
        const isOpen = !!open[f.id];
        const hasChildren = f.children.length > 0;
        const isActive = activeId === f.id;
        return (
          <div key={f.id}>
            <RailRow
              icon={<Icon.folder size={12} />}
              label={f.name}
              active={isActive}
              onClick={() => onSelect(f.id)}
              count={counts.byFolder.get(f.id) ?? 0}
              showCount={showCounts}
              disclosure={
                hasChildren ? (
                  <RailDisclosure
                    open={isOpen}
                    label={f.name}
                    onToggle={() => setOpen({ ...open, [f.id]: !isOpen })}
                  />
                ) : undefined
              }
              action={
                isActive && canManage ? (
                  <RailEditButton label={f.name} onClick={onEditFolder} />
                ) : undefined
              }
            />

            {creating === f.id && (
              <NewFolderInline
                companyId={companyId}
                parentId={f.id}
                onDone={() => setCreating(null)}
              />
            )}

            {isOpen && hasChildren && (
              <div
                style={{
                  // Guide line under the parent's chevron, so a deep tree
                  // stays readable without indenting labels off the rail.
                  marginLeft: 13,
                  paddingLeft: 8,
                  borderLeft: '1px solid var(--line)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 1,
                }}
              >
                <FolderSubtree
                  nodes={f.children}
                  open={open}
                  setOpen={setOpen}
                  activeId={activeId}
                  onSelect={onSelect}
                  creating={creating}
                  setCreating={setCreating}
                  counts={counts}
                  companyId={companyId}
                  canManage={canManage}
                  showCounts={showCounts}
                  onEditFolder={onEditFolder}
                />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function NewFolderInline({
  companyId,
  parentId,
  onDone,
}: {
  companyId: string;
  parentId: string | null;
  onDone: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      onDone();
      return;
    }
    setBusy(true);
    // On a 409 `SlugTaken` the server tells us which slug collided, so
    // instead of forcing the user to manually rename the folder we
    // transparently append ` 2`, ` 3`, … until we land on a free slot.
    // This matches the rename-on-duplicate behaviour users expect from
    // Finder / Google Drive, and keeps the flow single-click. We cap
    // the retry depth so a genuinely broken server doesn't spin us
    // forever.
    const MAX_ATTEMPTS = 20;
    let attempt = 1;
    let attemptedName = trimmed;
    let finalRes: Awaited<ReturnType<typeof apiFetch<{ id: string }>>> | null =
      null;
    while (attempt <= MAX_ATTEMPTS) {
      const res = await apiFetch<{ id: string }>(
        `/companies/${companyId}/folders`,
        {
          method: 'POST',
          body: JSON.stringify({ name: attemptedName, parentId }),
        },
      );
      finalRes = res;
      if (res.ok) break;
      if (res.status === 409 && isSlugTaken(res.problem)) {
        attempt += 1;
        attemptedName = `${trimmed} ${attempt}`;
        continue;
      }
      break;
    }
    setBusy(false);
    if (!finalRes || !finalRes.ok) {
      toast.push(
        problemMessage(finalRes?.problem) ?? 'Could not create folder',
        'danger',
      );
      return;
    }
    toast.push(
      attemptedName === trimmed
        ? 'Folder created'
        : `Folder created as “${attemptedName}”`,
      'ok',
    );
    onDone();
    router.refresh();
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 6px',
      }}
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') onDone();
        }}
        disabled={busy}
        placeholder="New folder"
        style={{
          flex: 1,
          fontSize: 12,
          padding: '3px 6px',
          border: '1px solid var(--accent-line)',
          borderRadius: 3,
          background: 'var(--panel)',
          color: 'var(--text)',
          outline: 'none',
        }}
      />
      <Btn size="sm" kind="ghost" onClick={submit} disabled={busy}>
        <Icon.check size={10} />
      </Btn>
      <Btn size="sm" kind="ghost" onClick={onDone} disabled={busy}>
        <Icon.x size={10} />
      </Btn>
    </div>
  );
}

/**
 * Read the RFC 7807 `error` discriminator from whatever `apiFetch` handed
 * us back in the `problem` slot. We deliberately keep this defensive —
 * `problem` is typed as `unknown` because the server shape isn't
 * guaranteed on every status code.
 */
function isSlugTaken(problem: unknown): boolean {
  if (!problem || typeof problem !== 'object') return false;
  const error = (problem as { error?: unknown }).error;
  return error === 'SlugTaken';
}

function problemMessage(problem: unknown): string | null {
  if (!problem || typeof problem !== 'object') return null;
  const msg = (problem as { message?: unknown }).message;
  return typeof msg === 'string' && msg.length > 0 ? msg : null;
}
