'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ArticleSummary,
  FolderNode,
} from '../../lib/server-api';
import { Icon } from '../ui';

const STORAGE_KEY_PREFIX = 'weavestream.articleSideNav.openFolders';
const UNFILED_KEY = '__unfiled__';

/**
 * Left rail of the admin article read view.
 *
 * Renders a collapsible folder tree with child articles listed inline
 * under each folder (matching Section 5 of the design, not the simpler
 * folder-filter used on the /articles index page). The active article
 * gets an accent left-bar. Clicks on an article navigate to its read
 * page; clicks on a folder row toggle its open state without navigating.
 *
 * Folders without articles in the current snapshot still render so the
 * overall information architecture is visible. An "Unfiled" pseudo-group
 * collects any article whose folderId is null.
 */
export function ArticleSideNav({
  companyId,
  folders,
  articles,
  activeArticleId,
}: {
  companyId: string;
  folders: FolderNode[];
  articles: ArticleSummary[];
  activeArticleId: string;
}) {
  const byFolder = useMemo(() => {
    const map = new Map<string | 'root', ArticleSummary[]>();
    for (const a of articles) {
      const key: string | 'root' = a.folderId ?? 'root';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(a);
    }
    for (const list of map.values()) {
      list.sort((x, y) => x.title.localeCompare(y.title));
    }
    return map;
  }, [articles]);

  // Persist the open/closed state per company in `sessionStorage` so
  // it survives both:
  //   1. The route-segment remount that happens when the user clicks
  //      from one article to another (cross-`page.tsx` navigation
  //      inside the same `[articleId]` slot).
  //   2. A casual page reload of the article view.
  //
  // First-mount defaults: depth-0 folders, every ancestor of the
  // active article, and the synthetic "Unfiled" group (when it has
  // articles) are seeded open. Subsequent toggles overwrite that
  // seed exclusively — we never auto-collapse a folder the user has
  // chosen to open, and we never auto-open a folder they've closed.
  const storageKey = `${STORAGE_KEY_PREFIX}.${companyId}`;

  const ancestorsOfActive = useMemo(() => {
    const set = new Set<string>();
    const activeArticle = articles.find((a) => a.id === activeArticleId);
    if (activeArticle?.folderId) {
      for (const pid of findFolderPath(folders, activeArticle.folderId)) {
        set.add(pid);
      }
    }
    return set;
  }, [folders, articles, activeArticleId]);

  const unfiled = byFolder.get('root') ?? [];

  const buildSeed = useCallback((): Record<string, boolean> => {
    const open: Record<string, boolean> = {};
    const walk = (list: FolderNode[], depth: number) => {
      for (const f of list) {
        open[f.id] = depth === 0 || ancestorsOfActive.has(f.id);
        walk(f.children, depth + 1);
      }
    };
    walk(folders, 0);
    if (unfiled.length > 0) open[UNFILED_KEY] = true;
    return open;
  }, [folders, ancestorsOfActive, unfiled.length]);

  const [openState, setOpenState] = useState<Record<string, boolean>>(buildSeed);

  // Rehydrate from sessionStorage on mount. We can't read storage in
  // the `useState` initializer because the component renders on the
  // server first — touching `sessionStorage` there would crash.
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Layer the persisted user choices on top of the freshly-built
        // seed so newly-created folders default-open and removed
        // folder ids are dropped silently.
        setOpenState((seed) => ({ ...seed, ...(parsed as Record<string, boolean>) }));
      }
    } catch {
      // Corrupt JSON or storage disabled — ignore.
    }
    // Only on mount: subsequent navigations rely on in-memory state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Force-open the ancestor chain of the active article so the active
  // row is always visible after a navigation, without clobbering the
  // user's expand/collapse choices elsewhere in the tree.
  useEffect(() => {
    if (ancestorsOfActive.size === 0) return;
    setOpenState((s) => {
      let changed = false;
      const next = { ...s };
      for (const id of ancestorsOfActive) {
        if (!next[id]) {
          next[id] = true;
          changed = true;
        }
      }
      return changed ? next : s;
    });
  }, [ancestorsOfActive]);

  // Persist after every change. The write is cheap (one JSON.stringify
  // of a flat object) so we don't bother debouncing.
  useEffect(() => {
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify(openState));
    } catch {
      // ignore
    }
  }, [storageKey, openState]);

  const isOpen = (id: string) => !!openState[id];
  const toggle = (id: string) =>
    setOpenState((s) => ({ ...s, [id]: !s[id] }));

  return (
    <aside
      className="scroll"
      style={{
        // `flex: 1` lets the aside fill the column-flex wrapper its
        // parent renders it into (see article read pages). Without it
        // the aside would collapse to content height and the right
        // border would stop short of the bottom of the viewport.
        flex: 1,
        borderRight: '1px solid var(--line)',
        background: 'var(--surface)',
        // Vertical overflow only. The aside has `flex: 1` so it can
        // shrink below its natural content width; long article titles
        // should truncate (handled by `ArticleLink`'s ellipsis rules)
        // rather than introduce a horizontal scrollbar.
        overflowX: 'hidden',
        overflowY: 'auto',
        padding: '14px 6px',
        minWidth: 0,
        minHeight: 0,
      }}
    >
      {folders.map((f) => (
        <FolderBranch
          key={f.id}
          node={f}
          depth={0}
          isOpen={isOpen}
          toggle={toggle}
          byFolder={byFolder}
          companyId={companyId}
          activeArticleId={activeArticleId}
        />
      ))}

      {unfiled.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <FolderHeader
            label="Unfiled"
            open={isOpen(UNFILED_KEY)}
            onToggle={() => toggle(UNFILED_KEY)}
            depth={0}
            icon={<Icon.folder size={11} style={{ color: 'var(--dim)' }} />}
          />
          {isOpen(UNFILED_KEY) &&
            unfiled.map((a) => (
              <ArticleLink
                key={a.id}
                article={a}
                companyId={companyId}
                depth={0}
                active={a.id === activeArticleId}
              />
            ))}
        </div>
      )}
    </aside>
  );
}

function FolderBranch({
  node,
  depth,
  isOpen,
  toggle,
  byFolder,
  companyId,
  activeArticleId,
}: {
  node: FolderNode;
  depth: number;
  isOpen: (id: string) => boolean;
  toggle: (id: string) => void;
  byFolder: Map<string | 'root', ArticleSummary[]>;
  companyId: string;
  activeArticleId: string;
}) {
  const open = isOpen(node.id);
  const articlesHere = byFolder.get(node.id) ?? [];

  return (
    <div style={{ marginBottom: depth === 0 ? 6 : 0 }}>
      <FolderHeader
        label={node.name}
        open={open}
        onToggle={() => toggle(node.id)}
        depth={depth}
      />
      {open && (
        <>
          {articlesHere.map((a) => (
            <ArticleLink
              key={a.id}
              article={a}
              companyId={companyId}
              depth={depth}
              active={a.id === activeArticleId}
            />
          ))}
          {node.children.map((child) => (
            <FolderBranch
              key={child.id}
              node={child}
              depth={depth + 1}
              isOpen={isOpen}
              toggle={toggle}
              byFolder={byFolder}
              companyId={companyId}
              activeArticleId={activeArticleId}
            />
          ))}
        </>
      )}
    </div>
  );
}

function FolderHeader({
  label,
  open,
  onToggle,
  depth,
  icon,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  depth: number;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 8px',
        marginLeft: depth * 10,
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        fontSize: depth === 0 ? 11 : 12,
        color: 'var(--muted)',
        fontFamily: depth === 0 ? 'var(--font-mono)' : 'inherit',
        textTransform: depth === 0 ? 'uppercase' : 'none',
        letterSpacing: depth === 0 ? 0.3 : 0,
        textAlign: 'left',
      }}
    >
      {icon ?? (
        <Icon.chevronD
          size={10}
          style={{
            transform: open ? 'none' : 'rotate(-90deg)',
            transition: 'transform 120ms ease',
            color: 'var(--dim)',
          }}
        />
      )}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
    </button>
  );
}

function ArticleLink({
  article,
  companyId,
  depth,
  active,
}: {
  article: ArticleSummary;
  companyId: string;
  depth: number;
  active: boolean;
}) {
  return (
    <Link
      href={`/admin/companies/${companyId}/articles/${article.id}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 10px 5px 22px',
        marginLeft: depth * 10,
        fontSize: 12.5,
        color: active ? 'var(--text)' : 'var(--text-2)',
        background: active ? 'var(--panel-2)' : 'transparent',
        borderRadius: 4,
        position: 'relative',
        textDecoration: 'none',
      }}
    >
      {active && (
        <span
          style={{
            position: 'absolute',
            left: 10,
            top: 7,
            bottom: 7,
            width: 2,
            background: 'var(--accent)',
            borderRadius: 2,
          }}
        />
      )}
      <Icon.doc size={11} style={{ color: 'var(--dim)', flexShrink: 0 }} />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {article.title}
      </span>
    </Link>
  );
}

function findFolderPath(
  tree: FolderNode[],
  targetId: string,
  trail: string[] = [],
): string[] {
  for (const f of tree) {
    const nextTrail = [...trail, f.id];
    if (f.id === targetId) return nextTrail;
    const childHit = findFolderPath(f.children, targetId, nextTrail);
    if (childHit.length) return childHit;
  }
  return [];
}
