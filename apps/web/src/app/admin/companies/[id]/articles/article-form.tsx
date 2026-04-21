'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../../../../../lib/api';
import type {
  ArticleDetail,
  FolderNode,
} from '../../../../../lib/server-api';
import { Btn, Icon, Sheet, Tag, useToast } from '../../../../../components/ui';
import { TopBar } from '../../../../../components/shell/top-bar';
import { RichTextEditor } from '../../../../../components/editor/rich-text-editor';
import { LinkedItemsPanel } from '../../../../../components/relations';
import { useTerm } from '../../../../../lib/term-context';
import { companyCrumbs } from '../../../../../lib/company-crumbs';
import { useIsMobile } from '../../../../../lib/hooks/use-is-mobile';

/**
 * Shared create + edit form. A single client component handles both
 * modes; the editor auto-saves a draft every 4s after mutations quiet
 * down. Publishing = calling POST/PATCH with the current JSON document.
 */
type Mode = 'create' | 'edit';

export function ArticleForm({
  companyId,
  companyLabel,
  mode,
  folders,
  article,
  initialFolderId,
}: {
  companyId: string;
  companyLabel: string;
  mode: Mode;
  folders: FolderNode[];
  article?: ArticleDetail;
  initialFolderId?: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const term = useTerm();
  const [title, setTitle] = useState(article?.title ?? '');
  const [folderId, setFolderId] = useState<string | null>(
    article?.folderId ?? initialFolderId ?? null,
  );
  const [visibleToClients, setVisibleToClients] = useState(
    article?.visibleToClients ?? true,
  );
  const [doc, setDoc] = useState<unknown>(
    article?.content ?? { type: 'doc', content: [{ type: 'paragraph' }] },
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(
    article ? new Date(article.updatedAt) : null,
  );
  const [dirty, setDirty] = useState(false);
  // The `<RichTextEditor>` portals its toolbar directly into the scroll
  // container below, as a sibling of the centered body. That gives the
  // toolbar two properties we need:
  //   1. Full-viewport width (it's no longer constrained by the 1000px
  //      centered column), and
  //   2. A `position: sticky` containing block equal to the scroll
  //      container — so the bar stays pinned throughout the scroll.
  // CSS `order` below puts the body visually after the toolbar even
  // though the portal appends the toolbar at the end of the DOM.
  // `useState` instead of `useRef` so the editor re-renders once the
  // container element is captured.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const isMobile = useIsMobile();
  const [linksOpen, setLinksOpen] = useState(false);

  const flatFolders = useMemo(() => flattenFolders(folders), [folders]);

  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (mode !== 'edit') return;
    if (!dirty) return;
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      submit('autosave');
    }, 4000);
    return () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, folderId, visibleToClients, doc, dirty, mode]);

  async function submit(kind: 'publish' | 'autosave') {
    setError(null);
    const t = title.trim();
    if (!t) {
      setError('Title is required.');
      return;
    }
    if (mode === 'create') {
      setSaving(true);
      const res = await apiFetch<{ id: string }>(
        `/companies/${companyId}/articles`,
        {
          method: 'POST',
          body: JSON.stringify({
            title: t,
            folderId: folderId ?? undefined,
            visibleToClients,
            content: doc,
          }),
        },
      );
      setSaving(false);
      if (!res.ok || !res.data) {
        setError(extractErr(res.problem) ?? 'Create failed');
        return;
      }
      toast.push('Article created', 'ok');
      router.push(`/admin/companies/${companyId}/articles/${res.data.id}`);
      router.refresh();
      return;
    }

    if (!article) return;
    if (kind === 'publish') setSaving(true);
    const res = await apiFetch(
      `/companies/${companyId}/articles/${article.id}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          title: t,
          folderId,
          visibleToClients,
          content: doc,
        }),
      },
    );
    if (kind === 'publish') setSaving(false);
    if (!res.ok) {
      setError(extractErr(res.problem) ?? 'Save failed');
      return;
    }
    setLastSavedAt(new Date());
    setDirty(false);
    if (kind === 'publish') {
      toast.push('Article saved', 'ok');
      router.push(`/admin/companies/${companyId}/articles/${article.id}`);
      router.refresh();
    }
  }

  function onDocChange(next: unknown) {
    setDoc(next);
    setDirty(true);
  }

  const autosaveLabel = lastSavedAt
    ? `auto-saved ${timeAgo(lastSavedAt)}`
    : 'draft · unsaved';

  return (
    <>
      <TopBar
        crumbs={companyCrumbs(
          term,
          { id: companyId, name: companyLabel },
          { label: 'Articles', href: `/admin/companies/${companyId}/articles` },
          ...(mode === 'create'
            ? ([{ label: 'New', mono: true }] as const)
            : ([
                {
                  label: article?.title ?? 'Article',
                  href: `/admin/companies/${companyId}/articles/${article?.id}`,
                },
                { label: 'editing', mono: true },
              ] as const)),
        )}
        right={
          <>
            {dirty && <Tag tone="warn">unsaved</Tag>}
            <Btn
              kind="outline"
              disabled={saving}
              onClick={() => {
                if (mode === 'edit' && article) {
                  router.push(
                    `/admin/companies/${companyId}/articles/${article.id}`,
                  );
                } else {
                  router.push(`/admin/companies/${companyId}/articles`);
                }
              }}
            >
              {mode === 'create' ? 'Discard' : 'Cancel'}
            </Btn>
            {mode === 'edit' && article && (
              <Btn
                kind="outline"
                icon={Icon.ext}
                onClick={() => {
                  window.open(
                    `/admin/companies/${companyId}/articles/${article.id}`,
                    '_blank',
                    'noopener,noreferrer',
                  );
                }}
                title="Open the read view in a new tab"
              >
                Preview
              </Btn>
            )}
            <Btn
              kind="primary"
              icon={Icon.check}
              loading={saving}
              onClick={() => submit('publish')}
            >
              {mode === 'create' ? 'Publish' : 'Save'}
            </Btn>
          </>
        }
      />

      {error && (
        <div
          role="alert"
          style={{
            padding: '10px 24px',
            background: 'var(--danger-soft)',
            color: 'var(--danger)',
            borderBottom: '1px solid var(--line)',
            fontSize: 12.5,
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns:
            mode === 'edit' && article && !isMobile
              ? 'minmax(0, 1fr) 320px'
              : 'minmax(0, 1fr)',
        }}
      >
      <div
        ref={setScrollEl}
        style={{
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
        }}
      >
        <div
          style={{
            order: 2,
            maxWidth: 1000,
            margin: '0 auto',
            width: '100%',
          }}
        >
          <div style={{ padding: '30px 40px 20px' }}>
            <input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setDirty(true);
              }}
              placeholder="Article title…"
              style={{
                width: '100%',
                fontSize: 32,
                fontWeight: 600,
                letterSpacing: -0.7,
                background: 'transparent',
                border: 'none',
                padding: 0,
                color: 'var(--text)',
                outline: 'none',
                fontFamily: 'var(--font-display)',
                marginBottom: 14,
              }}
            />
            <div
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                flexWrap: 'wrap',
                marginBottom: 20,
                fontSize: 12,
                color: 'var(--muted)',
              }}
            >
              <MonoLabel>folder</MonoLabel>
              <select
                value={folderId ?? ''}
                onChange={(e) => {
                  setFolderId(e.target.value || null);
                  setDirty(true);
                }}
                style={selectStyle}
              >
                <option value="">— unfiled —</option>
                {flatFolders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {'· '.repeat(f.depth)}
                    {f.name}
                  </option>
                ))}
              </select>

              <MonoLabel>visibility</MonoLabel>
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={visibleToClients}
                  onChange={(e) => {
                    setVisibleToClients(e.target.checked);
                    setDirty(true);
                  }}
                  style={{ accentColor: 'var(--accent)' }}
                />
                visible to clients
              </label>

              <span style={{ flex: 1 }} />
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10.5,
                  color: 'var(--dim)',
                }}
              >
                {autosaveLabel}
              </span>
            </div>
          </div>

          <div style={{ padding: '0 40px 80px' }}>
            <RichTextEditor
              variant="article"
              value={doc}
              onChange={onDocChange}
              companyId={companyId}
              autoFocus={mode === 'create'}
              toolbarPortalTarget={scrollEl}
            />
          </div>
        </div>
      </div>

        {mode === 'edit' && article && !isMobile && (
          <aside
            className="scroll"
            style={{
              borderLeft: '1px solid var(--line)',
              padding: '24px 18px',
              overflow: 'auto',
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
            }}
          >
            <LinkedItemsPanel
              companyId={companyId}
              entityType="article"
              entityId={article.id}
              editable={!article.archivedAt}
            />
          </aside>
        )}
      </div>

      {mode === 'edit' && article && isMobile && (
        <>
          <button
            type="button"
            onClick={() => setLinksOpen(true)}
            aria-label="Open linked items"
            style={{
              position: 'fixed',
              bottom: 16,
              right: 16,
              zIndex: 60,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 42,
              padding: '0 14px',
              borderRadius: 999,
              border: '1px solid var(--line)',
              background: 'var(--accent)',
              color: 'var(--accent-ink)',
              fontSize: 13,
              fontWeight: 600,
              boxShadow: '0 6px 18px rgba(0,0,0,0.2)',
              cursor: 'pointer',
            }}
          >
            <Icon.link size={14} /> Links
          </button>
          <Sheet
            open={linksOpen}
            onClose={() => setLinksOpen(false)}
            side="bottom"
            ariaLabel="Linked items"
            height="min(80vh, 640px)"
          >
            <div
              style={{
                padding: 16,
                overflow: 'auto',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                gap: 20,
              }}
            >
              <LinkedItemsPanel
                companyId={companyId}
                entityType="article"
                entityId={article.id}
                editable={!article.archivedAt}
              />
            </div>
          </Sheet>
        </>
      )}
    </>
  );
}

const selectStyle: React.CSSProperties = {
  background: 'var(--panel-2)',
  border: '1px solid var(--line-2)',
  borderRadius: 4,
  padding: '4px 8px',
  fontSize: 12,
  color: 'var(--text)',
  fontFamily: 'inherit',
};

function MonoLabel({ children }: { children: string }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        color: 'var(--dim)',
        textTransform: 'uppercase',
        letterSpacing: 0.4,
      }}
    >
      {children}
    </span>
  );
}

function flattenFolders(
  folders: FolderNode[],
  depth = 0,
): Array<{ id: string; name: string; depth: number }> {
  const out: Array<{ id: string; name: string; depth: number }> = [];
  for (const f of folders) {
    out.push({ id: f.id, name: f.name, depth });
    if (f.children.length) out.push(...flattenFolders(f.children, depth + 1));
  }
  return out;
}

function extractErr(problem: unknown): string | null {
  const p = problem as { detail?: unknown; title?: string } | undefined;
  if (!p) return null;
  if (typeof p.detail === 'string') return p.detail;
  if (
    p.detail &&
    typeof p.detail === 'object' &&
    'message' in (p.detail as Record<string, unknown>)
  ) {
    return String((p.detail as { message: string }).message);
  }
  return p.title ?? null;
}

function timeAgo(d: Date): string {
  const sec = Math.max(1, Math.round((Date.now() - d.getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return d.toLocaleDateString();
}
