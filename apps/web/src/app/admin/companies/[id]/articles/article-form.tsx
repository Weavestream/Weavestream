'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ArticleEditorMode } from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import type {
  ArticleDetail,
  FolderNode,
} from '../../../../../lib/server-api';
import { Btn, Dialog, Icon, Sheet, Tag, useToast } from '../../../../../components/ui';
import { TopBar } from '../../../../../components/shell/top-bar';
import { RichTextEditor } from '../../../../../components/editor/rich-text-editor';
import { MarkdownEditor } from '../../../../../components/editor/markdown-editor';
import { LinkedItemsPanel } from '../../../../../components/relations';
import { AttachmentsPanel } from '../../../../../components/upload/attachments-panel';
import { useChatPageContext } from '../../../../../components/chat-panel/use-chat-page-context';
import { useTerm } from '../../../../../lib/term-context';
import { companyCrumbs } from '../../../../../lib/company-crumbs';
import { useIsMobile } from '../../../../../lib/hooks/use-is-mobile';
import {
  markdownToTiptapDoc,
  tiptapDocToMarkdown,
} from '../../../../../lib/article-format';

/**
 * Shared create + edit form. A single client component handles both
 * modes; the editor auto-saves a draft every 4s after mutations quiet
 * down. Publishing = calling POST/PATCH with the current body
 * (Tiptap doc or Markdown source) + `editorMode`.
 */
type Mode = 'create' | 'edit';

const emptyTiptap = { type: 'doc', content: [{ type: 'paragraph' }] } as const;

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
  const [editorMode, setEditorMode] = useState<ArticleEditorMode>(
    article?.editorMode ?? 'tiptap',
  );
  const [doc, setDoc] = useState<unknown>(
    article?.editorMode === 'markdown'
      ? emptyTiptap
      : (article?.content ?? emptyTiptap),
  );
  const [markdownSource, setMarkdownSource] = useState(
    article?.markdownSource ?? '',
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(
    article ? new Date(article.updatedAt) : null,
  );
  const [dirty, setDirty] = useState(false);
  // Format switches are deliberate, potentially-lossy operations: the
  // user should review the converted body and click Save explicitly
  // rather than have autosave persist it 4s later. We still flip
  // `dirty` so the "unsaved" tag appears; this flag tells the autosave
  // effect to stand down until the user makes a regular edit (which
  // implies they're satisfied with the conversion) or saves manually.
  const [formatSwitchPending, setFormatSwitchPending] = useState(false);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const isMobile = useIsMobile();
  const [linksOpen, setLinksOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState<ArticleEditorMode | null>(null);

  const flatFolders = useMemo(() => flattenFolders(folders), [folders]);

  // Keep refs to the live editor state so the chat-panel context
  // hook can sample the freshest body at send time without forcing a
  // re-register on every keystroke.
  const docRef = useRef(doc);
  docRef.current = doc;
  const markdownRef = useRef(markdownSource);
  markdownRef.current = markdownSource;
  const editorModeRef = useRef(editorMode);
  editorModeRef.current = editorMode;
  const getEditorMarkdown = useCallback((): string => {
    if (editorModeRef.current === 'markdown') return markdownRef.current ?? '';
    try {
      return tiptapDocToMarkdown(docRef.current);
    } catch {
      return '';
    }
  }, []);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onBeforeAiApply = useCallback(() => {
    // Cancel any debounced autosave so the user-visible state and
    // the AI-applied DB state can't race after the apply lands.
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }
  }, []);
  /**
   * Sync local React state to the body the AI just persisted. The
   * `apply` endpoint always saves articles in Markdown editor mode
   * (regardless of the article's prior mode), so we switch the form
   * into Markdown mode + drop the proposed `markdown` directly. This
   * lets the user see the change without a hard reload; the parent
   * `router.refresh()` then picks up server-derived fields (slug,
   * plaintext, updatedBy, etc.).
   */
  const onAfterAiApply = useCallback(
    (changes: { markdown?: string; title?: string }) => {
      if (typeof changes.title === 'string') setTitle(changes.title);
      if (typeof changes.markdown === 'string') {
        setEditorMode('markdown');
        setMarkdownSource(changes.markdown);
        setFormatSwitchPending(false);
        setError(null);
      }
      setDirty(false);
      setLastSavedAt(new Date());
    },
    [],
  );
  useChatPageContext({
    companyId,
    articleId: article?.id ?? null,
    title: title || article?.title || 'Untitled article',
    getMarkdown: getEditorMarkdown,
    isDirty: dirty,
    onBeforeAiApply,
    onAfterAiApply,
  });
  useEffect(() => {
    if (mode !== 'edit') return;
    if (!dirty) return;
    if (formatSwitchPending) return;
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      submit('autosave');
    }, 4000);
    return () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    title,
    folderId,
    visibleToClients,
    editorMode,
    doc,
    markdownSource,
    dirty,
    formatSwitchPending,
    mode,
  ]);

  function canAutosaveBody(): boolean {
    if (editorMode === 'markdown' && !markdownSource.trim()) return false;
    return true;
  }

  /**
   * Mark the form as dirty for a *regular* edit. Distinct from a format
   * switch (which sets `dirty` directly without clearing the pending
   * flag) — any normal edit clears the pending state so autosave can
   * resume its usual 4 s debounce.
   */
  function markDirty() {
    setDirty(true);
    setFormatSwitchPending(false);
  }

  /**
   * Build the create/patch payload. The two endpoints diverge only on
   * how an unset `folderId` is encoded:
   *   - POST: omit the key (`undefined` → JSON-stripped) so the server
   *     uses its default;
   *   - PATCH: send `null` to explicitly unfile the article.
   * Returns `null` when the user is in Markdown mode with no body —
   * autosave skips and publish surfaces a validation error.
   */
  function buildBody(forMode: Mode) {
    const base = {
      title: title.trim(),
      folderId: forMode === 'create' ? (folderId ?? undefined) : folderId,
      visibleToClients,
    };
    if (editorMode === 'tiptap') {
      return { ...base, editorMode: 'tiptap' as const, content: doc };
    }
    if (!markdownSource.trim()) return null;
    return { ...base, editorMode: 'markdown' as const, markdownSource };
  }

  async function submit(kind: 'publish' | 'autosave') {
    setError(null);
    const t = title.trim();
    if (!t) {
      setError('Title is required.');
      return;
    }
    if (editorMode === 'markdown' && !markdownSource.trim()) {
      if (kind === 'publish') {
        setError('Add some Markdown content before saving.');
      }
      return;
    }
    if (mode === 'create') {
      const body = buildBody('create');
      if (!body) {
        if (kind === 'publish') {
          setError('Add some content before publishing.');
        }
        return;
      }
      setSaving(true);
      const res = await apiFetch<{ id: string }>(
        `/companies/${companyId}/articles`,
        {
          method: 'POST',
          body: JSON.stringify(body),
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
    if (kind === 'autosave' && !canAutosaveBody()) {
      return;
    }
    const payload = buildBody('edit');
    if (!payload) {
      return;
    }
    if (kind === 'publish') setSaving(true);
    const res = await apiFetch(
      `/companies/${companyId}/articles/${article.id}`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload),
      },
    );
    if (kind === 'publish') setSaving(false);
    if (!res.ok) {
      setError(extractErr(res.problem) ?? 'Save failed');
      return;
    }
    setLastSavedAt(new Date());
    setDirty(false);
    setFormatSwitchPending(false);
    if (kind === 'publish') {
      toast.push('Article saved', 'ok');
      router.push(`/admin/companies/${companyId}/articles/${article.id}`);
      router.refresh();
    }
  }

  function onDocChange(next: unknown) {
    setDoc(next);
    markDirty();
  }

  function onMarkdownChange(next: string) {
    setMarkdownSource(next);
    markDirty();
  }

  function startModeSwitch(next: ArticleEditorMode) {
    if (next === editorMode) return;
    if (mode === 'create') {
      applyModeSwitch(next);
      return;
    }
    setPendingMode(next);
    setSwitchOpen(true);
  }

  function applyModeSwitch(next: ArticleEditorMode) {
    if (next === editorMode) return;
    try {
      if (next === 'markdown') {
        setMarkdownSource(tiptapDocToMarkdown(doc));
      } else {
        setDoc(
          markdownToTiptapDoc(
            markdownSource.trim().length > 0 ? markdownSource : '\n',
          ),
        );
      }
    } catch {
      setError(
        next === 'markdown'
          ? 'Could not convert this article to Markdown. Try again or copy the content out manually.'
          : 'Could not convert Markdown to the rich editor. Try again or paste into Tiptap manually.',
      );
      return;
    }
    setEditorMode(next);
    setDirty(true);
    if (mode === 'edit') {
      setFormatSwitchPending(true);
    }
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
          gridTemplateRows: 'minmax(0, 1fr)',
        }}
      >
      <div
        ref={setScrollEl}
        style={{
          overflow: editorMode === 'markdown' ? 'hidden' : 'auto',
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          minHeight: 0,
        }}
      >
        <div
          style={{
            order: 2,
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            flex: editorMode === 'markdown' ? 1 : 'initial',
            minHeight: 0,
          }}
        >
          <div
            style={{
              maxWidth: 1000,
              margin: '0 auto',
              width: '100%',
              padding: '30px 40px 20px',
            }}
          >
            <input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                markDirty();
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
              <MonoLabel>format</MonoLabel>
              <Btn
                type="button"
                kind={editorMode === 'tiptap' ? 'primary' : 'outline'}
                onClick={() => startModeSwitch('tiptap')}
              >
                WYSIWYG
              </Btn>
              <Btn
                type="button"
                kind={editorMode === 'markdown' ? 'primary' : 'outline'}
                onClick={() => startModeSwitch('markdown')}
              >
                Markdown
              </Btn>

              <MonoLabel>folder</MonoLabel>
              <select
                value={folderId ?? ''}
                onChange={(e) => {
                  setFolderId(e.target.value || null);
                  markDirty();
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
                    markDirty();
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

          {editorMode === 'tiptap' ? (
            <div
              style={{
                maxWidth: 1000,
                margin: '0 auto',
                width: '100%',
                padding: '0 40px 80px',
              }}
            >
              <RichTextEditor
                variant="article"
                value={doc}
                onChange={onDocChange}
                companyId={companyId}
                autoFocus={mode === 'create'}
                toolbarPortalTarget={scrollEl}
              />
            </div>
          ) : (
            <div
              style={{
                width: '100%',
                padding: '0 16px 16px',
                flex: 1,
                minHeight: 0,
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <MarkdownEditor
                value={markdownSource}
                onChange={onMarkdownChange}
                autoFocus={mode === 'create'}
                companyId={companyId}
                toolbarPortalTarget={scrollEl}
              />
            </div>
          )}
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
            <AttachmentsPanel
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
              <AttachmentsPanel
                companyId={companyId}
                entityType="article"
                entityId={article.id}
                editable={!article.archivedAt}
              />
            </div>
          </Sheet>
        </>
      )}

      <Dialog
        open={switchOpen}
        onClose={() => {
          setSwitchOpen(false);
          setPendingMode(null);
        }}
        title="Switch editor format?"
        width={440}
        footer={
          <div
            style={{
              display: 'flex',
              gap: 8,
              justifyContent: 'flex-end',
            }}
          >
            <Btn
              kind="outline"
              onClick={() => {
                setSwitchOpen(false);
                setPendingMode(null);
              }}
            >
              Cancel
            </Btn>
            <Btn
              kind="primary"
              onClick={() => {
                if (pendingMode) {
                  applyModeSwitch(pendingMode);
                }
                setSwitchOpen(false);
                setPendingMode(null);
              }}
            >
              Switch
            </Btn>
          </div>
        }
      >
        <p style={{ margin: 0, lineHeight: 1.5, color: 'var(--text)' }}>
          Converting may change formatting. Mentions, custom image layout,
          and complex tables can lose fidelity. You can still undo before
          saving.
        </p>
      </Dialog>
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
