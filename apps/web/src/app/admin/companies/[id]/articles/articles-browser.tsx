'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import type {
  ArticleSummary,
  FolderNode,
} from '../../../../../lib/server-api';
import { apiFetch } from '../../../../../lib/api';
import { Btn, Icon, Tag, useToast } from '../../../../../components/ui';
import { useIsMobile } from '../../../../../lib/hooks/use-is-mobile';

/**
 * Two-column article browser:
 *   - Left: collapsible folder tree. Clicking a folder filters the list.
 *     `+` at the root or on a folder opens the inline create form.
 *   - Right: article list with a search box and an `archived` toggle.
 *
 * Server provides the current slice; client handles nav/filter changes
 * by pushing to `?q=…&folderId=…`.
 */
export function ArticlesBrowser({
  companyId,
  folders,
  articles,
  q,
  folderId,
  includeArchived,
  canManage,
}: {
  companyId: string;
  folders: FolderNode[];
  articles: ArticleSummary[];
  q: string;
  folderId: string;
  includeArchived: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const isMobile = useIsMobile();
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
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') sp.delete(k);
      else sp.set(k, v);
    }
    router.push(`/admin/companies/${companyId}/articles?${sp.toString()}`);
  }

  const activeFolderId = folderId || 'all';

  const foldersPane = (
    <aside
      style={{
        borderRight: isMobile ? 'none' : '1px solid var(--line)',
        background: 'var(--surface)',
        padding: '12px 6px',
        minHeight: isMobile ? 0 : 400,
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
        companyId={companyId}
        canManage={canManage}
      />
    </aside>
  );

  const articlesPane = (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 14px',
            borderBottom: '1px solid var(--line)',
            background: 'var(--panel)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flex: 1,
              maxWidth: 360,
              background: 'var(--panel-2)',
              border: '1px solid var(--line)',
              borderRadius: 5,
              height: 28,
              padding: '0 9px',
            }}
          >
            <Icon.search size={11} style={{ color: 'var(--dim)' }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') nav({ q: query || null });
              }}
              placeholder="Filter by title…"
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                fontSize: 12,
                color: 'var(--text)',
              }}
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  nav({ q: null });
                }}
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
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11.5,
              color: 'var(--muted)',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) =>
                nav({ archived: e.target.checked ? '1' : null })
              }
              style={{ accentColor: 'var(--accent)' }}
            />
            Show archived
          </label>
        </div>

        {articles.length === 0 ? (
          <div
            style={{
              padding: 40,
              textAlign: 'center',
              color: 'var(--muted)',
              fontSize: 12.5,
            }}
          >
            {q
              ? `No articles match "${q}".`
              : 'No articles in this view yet.'}
          </div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {articles.map((a, i) => (
              <li
                key={a.id}
                style={{
                  padding: '10px 14px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  borderBottom:
                    i === articles.length - 1
                      ? 'none'
                      : '1px solid var(--line)',
                }}
              >
                <Icon.doc size={13} style={{ color: 'var(--dim)' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Link
                    href={`/admin/companies/${companyId}/articles/${a.id}`}
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: 'inherit',
                      display: 'block',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {a.title}
                  </Link>
                  {a.excerpt && (
                    <div
                      style={{
                        fontSize: 11.5,
                        color: 'var(--muted)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        marginTop: 2,
                      }}
                    >
                      {a.excerpt}
                    </div>
                  )}
                </div>
                {!a.visibleToClients && <Tag tone="outline">internal</Tag>}
                {a.archivedAt && <Tag tone="warn">archived</Tag>}
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10.5,
                    color: 'var(--dim)',
                  }}
                >
                  {new Date(a.updatedAt).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
    </div>
  );

  if (isMobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
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
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr' }}>
      {foldersPane}
      {articlesPane}
    </div>
  );
}

function FolderTreeNav({
  folders,
  open,
  setOpen,
  activeId,
  onSelect,
  companyId,
  canManage,
}: {
  folders: FolderNode[];
  open: Record<string, boolean>;
  setOpen: (next: Record<string, boolean>) => void;
  activeId: string;
  onSelect: (id: string) => void;
  companyId: string;
  canManage: boolean;
}) {
  const [creating, setCreating] = useState<string | 'root' | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <FolderRow
        icon={<Icon.grid size={11} style={{ color: 'var(--dim)' }} />}
        label="All articles"
        active={activeId === 'all'}
        onClick={() => onSelect('')}
      />
      <FolderRow
        icon={<Icon.folder size={11} style={{ color: 'var(--dim)' }} />}
        label="Unfiled"
        active={activeId === 'root'}
        onClick={() => onSelect('root')}
        right={
          canManage && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setCreating('root');
              }}
              className="sd-editor-btn"
              style={{ padding: 0, height: 18, width: 18 }}
              title="New folder at root"
            >
              <Icon.plus size={10} />
            </button>
          )
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
          marginTop: 8,
          paddingTop: 8,
          borderTop: '1px solid var(--line)',
        }}
      >
        <FolderSubtree
          nodes={folders}
          depth={0}
          open={open}
          setOpen={setOpen}
          activeId={activeId}
          onSelect={onSelect}
          creating={creating}
          setCreating={setCreating}
          companyId={companyId}
          canManage={canManage}
        />
      </div>
    </div>
  );
}

function FolderSubtree({
  nodes,
  depth,
  open,
  setOpen,
  activeId,
  onSelect,
  creating,
  setCreating,
  companyId,
  canManage,
}: {
  nodes: FolderNode[];
  depth: number;
  open: Record<string, boolean>;
  setOpen: (next: Record<string, boolean>) => void;
  activeId: string;
  onSelect: (id: string) => void;
  creating: string | 'root' | null;
  setCreating: (v: string | 'root' | null) => void;
  companyId: string;
  canManage: boolean;
}) {
  return (
    <>
      {nodes.map((f) => {
        const isOpen = !!open[f.id];
        const hasChildren = f.children.length > 0;
        return (
          <div key={f.id} style={{ marginLeft: depth * 10 }}>
            <FolderRow
              icon={
                hasChildren ? (
                  <Icon.chevronD
                    size={10}
                    style={{
                      transform: isOpen ? 'none' : 'rotate(-90deg)',
                      color: 'var(--dim)',
                    }}
                  />
                ) : (
                  <Icon.folder size={11} style={{ color: 'var(--dim)' }} />
                )
              }
              label={f.name}
              active={activeId === f.id}
              onClick={() => {
                if (hasChildren) setOpen({ ...open, [f.id]: !isOpen });
                onSelect(f.id);
              }}
              right={
                canManage && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setCreating(f.id);
                    }}
                    className="sd-editor-btn"
                    style={{ padding: 0, height: 18, width: 18 }}
                    title="New subfolder"
                  >
                    <Icon.plus size={10} />
                  </button>
                )
              }
            />

            {creating === f.id && (
              <div style={{ paddingLeft: (depth + 1) * 10 }}>
                <NewFolderInline
                  companyId={companyId}
                  parentId={f.id}
                  onDone={() => setCreating(null)}
                />
              </div>
            )}

            {isOpen && hasChildren && (
              <FolderSubtree
                nodes={f.children}
                depth={depth + 1}
                open={open}
                setOpen={setOpen}
                activeId={activeId}
                onSelect={onSelect}
                creating={creating}
                setCreating={setCreating}
                companyId={companyId}
                canManage={canManage}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function FolderRow({
  icon,
  label,
  active,
  onClick,
  right,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  right?: React.ReactNode;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 8px',
        fontSize: 12,
        color: active ? 'var(--text)' : 'var(--text-2)',
        background: active ? 'var(--panel-2)' : 'transparent',
        borderRadius: 4,
        cursor: 'pointer',
        position: 'relative',
      }}
    >
      {active && (
        <span
          style={{
            position: 'absolute',
            left: 2,
            top: 6,
            bottom: 6,
            width: 2,
            background: 'var(--accent)',
            borderRadius: 2,
          }}
        />
      )}
      <span style={{ width: 12, display: 'grid', placeItems: 'center' }}>
        {icon}
      </span>
      <span
        style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      {right}
    </div>
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
