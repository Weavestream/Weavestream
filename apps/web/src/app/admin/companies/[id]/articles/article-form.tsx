'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatDate,
  formatDateTime,
  // The SHARED DOM-free walker — used ONLY to project the live editor
  // body for the AI chat, so what the model sees matches the patch
  // preview and server apply byte-for-byte (F1). The client turndown
  // converter below stays for the user-facing editor mode switch.
  tiptapDocToMarkdown as tiptapDocToSharedMarkdown,
  type ArticleEditorMode,
} from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import { useTimezone } from '../../../../../lib/timezone-context';
import type { ArticleDetail, FolderNode } from '../../../../../lib/server-api';
import { Btn, Dialog, Icon, Panel, Sheet, Tag, useToast } from '../../../../../components/ui';
import { TopBar } from '../../../../../components/shell/top-bar';
import { RichTextEditor } from '../../../../../components/editor/rich-text-editor';
import {
  MarkdownEditor,
  type MarkdownViewMode,
} from '../../../../../components/editor/markdown-editor';
import { LinkedItemsPanel } from '../../../../../components/relations';
import { AttachmentsPanel } from '../../../../../components/upload/attachments-panel';
import { useChatPageContext } from '../../../../../components/chat-panel/use-chat-page-context';
import { useTerm } from '../../../../../lib/term-context';
import { companyCrumbs } from '../../../../../lib/company-crumbs';
import { useIsMobile } from '../../../../../lib/hooks/use-is-mobile';
import { markdownToTiptapDoc, tiptapDocToMarkdown } from '../../../../../lib/article-format';
import { ArticleActions } from './article-actions';

/**
 * Shared create + edit form. A single client component handles both
 * modes. Autosave is OFF by default and gated by the workspace-wide
 * `SystemSetting.articleAutosaveEnabled` toggle (see
 * /admin/settings → Article editor). When enabled, edits coalesce
 * into a single rolling draft `ArticleVersion` row on the server via
 * `PATCH /articles/:id { draft: true }`; clicking Save promotes that
 * draft to a published version, Cancel discards it and reverts the
 * article row to the last published version.
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
  autosaveEnabled,
  defaultEditorMode,
}: {
  companyId: string;
  companyLabel: string;
  mode: Mode;
  folders: FolderNode[];
  article?: ArticleDetail;
  initialFolderId?: string | null;
  /**
   * Resolved server-side from `SystemSetting.articleAutosaveEnabled`.
   * Drives the 4 s debounce timer below; when `false`, no PATCH ever
   * fires automatically and the operator must click Save explicitly.
   */
  autosaveEnabled: boolean;
  /**
   * Resolved server-side from `SystemSetting.articleDefaultEditorMode`.
   * Only seeds the initial format toggle in Create mode — edit mode
   * always honours the article's own `editorMode`. Operators can flip
   * between WYSIWYG and Markdown after the form mounts; this is just
   * the workspace-wide starting point.
   */
  defaultEditorMode: ArticleEditorMode;
}) {
  const router = useRouter();
  const toast = useToast();
  const term = useTerm();
  const [title, setTitle] = useState(article?.title ?? '');
  const [folderId, setFolderId] = useState<string | null>(
    article?.folderId ?? initialFolderId ?? null,
  );
  const [visibleToClients, setVisibleToClients] = useState(article?.visibleToClients ?? true);
  const [editorMode, setEditorMode] = useState<ArticleEditorMode>(
    article?.editorMode ?? defaultEditorMode,
  );
  const [markdownView, setMarkdownView] = useState<MarkdownViewMode>('edit');
  const [doc, setDoc] = useState<unknown>(
    article?.editorMode === 'markdown' ? emptyTiptap : (article?.content ?? emptyTiptap),
  );
  const [markdownSource, setMarkdownSource] = useState(article?.markdownSource ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(
    article ? new Date(article.updatedAt) : null,
  );
  const tz = useTimezone();
  // The "saved X ago" label is relative to the client clock, which the
  // SSR render can't know. Render an absolute timestamp until mount, then
  // upgrade to the relative label so hydration stays deterministic.
  const [savedLabelMounted, setSavedLabelMounted] = useState(false);
  useEffect(() => setSavedLabelMounted(true), []);
  const [dirty, setDirty] = useState(false);
  // Tracks whether the server is currently holding an in-progress
  // autosave draft for this article. Seeded from the detail load and
  // flipped by autosave success / publish / discard. Drives the
  // Cancel dialog (must call the discard endpoint when true) and the
  // "Discard draft" affordance in the topbar.
  const [hasServerDraft, setHasServerDraft] = useState<boolean>(article?.hasDraft ?? false);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  const [discarding, setDiscarding] = useState(false);
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
      // SHARED converter (not the client turndown one): the AI chat reads
      // this, and its patch old_text must match the shared-walker base the
      // preview and server apply run against (F1).
      return tiptapDocToSharedMarkdown(docRef.current);
    } catch {
      return '';
    }
  }, []);
  // The saved revision the editor's body is based on (WS-030). Seeded
  // from the detail load and refreshed from every successful PATCH —
  // autosaves bump the server-side revision, so tracking the response
  // keeps the chat snapshot's basis claim honest while typing. Reset
  // to null (unknowable) after an AI apply; the assistant then reads
  // the article before proposing again.
  const revisionRef = useRef<number | null>(article?.revision ?? null);
  const getRevision = useCallback((): number | null => revisionRef.current, []);
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
  const onAfterAiApply = useCallback((changes: { markdown?: string; title?: string }) => {
    if (typeof changes.title === 'string') setTitle(changes.title);
    if (typeof changes.markdown === 'string') {
      setEditorMode('markdown');
      setMarkdownSource(changes.markdown);
      setFormatSwitchPending(false);
      setError(null);
    }
    setDirty(false);
    // The AI apply endpoint saves explicitly (never `draft: true`),
    // which promotes/clears any in-progress autosave draft on the
    // server. Mirror that here so the editor's "draft" tag doesn't
    // linger after an apply.
    setHasServerDraft(false);
    setLastSavedAt(new Date());
    // The apply bumped the server-side revision and this form didn't
    // see the response — the basis is unknowable until the page data
    // refreshes, so stop claiming one.
    revisionRef.current = null;
  }, []);
  useChatPageContext({
    companyId,
    articleId: article?.id ?? null,
    title: title || article?.title || 'Untitled article',
    getMarkdown: getEditorMarkdown,
    getRevision,
    isDirty: dirty,
    onBeforeAiApply,
    onAfterAiApply,
  });
  useEffect(() => {
    // Autosave is gated by the workspace-wide system setting. When
    // disabled (the default), no PATCH ever fires automatically — the
    // operator must click Save to persist anything. This also covers
    // the Create mode case because `mode !== 'edit'` returns early.
    if (mode !== 'edit') return;
    if (!autosaveEnabled) return;
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
    autosaveEnabled,
  ]);

  // Browsers nudge the user with a generic "unsaved changes" prompt
  // when they navigate away (close tab, hit Back) while we're holding
  // a dirty form OR a server-side draft that they haven't explicitly
  // committed or discarded. The exact message text is controlled by
  // the browser and can't be customised, but the prompt itself is
  // what matters — it's the only thing standing between the operator
  // and an autosaved-but-unreviewed body becoming the live article.
  useEffect(() => {
    if (mode !== 'edit') return;
    if (!dirty && !hasServerDraft) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty, hasServerDraft, mode]);

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
   * autosave skips and publish surfaces a validation error. The
   * caller appends the optional `draft: true` flag for autosave
   * PATCHes (omitted otherwise so the server treats it as an
   * explicit Save).
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
      const res = await apiFetch<{ id: string }>(`/companies/${companyId}/articles`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
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
    // Tell the API to coalesce into the rolling draft instead of
    // producing a new published version. Explicit Save omits the
    // flag so the server's `update(draft=false)` path runs.
    const body = kind === 'autosave' ? { ...payload, draft: true } : payload;
    if (kind === 'publish') setSaving(true);
    const res = await apiFetch<{ revision?: number }>(
      `/companies/${companyId}/articles/${article.id}`,
      {
        method: 'PATCH',
        body: JSON.stringify(body),
      },
    );
    if (kind === 'publish') setSaving(false);
    if (!res.ok) {
      setError(extractErr(res.problem) ?? 'Save failed');
      return;
    }
    // Track the bumped revision so the chat snapshot's basis claim
    // stays honest across autosaves (WS-030).
    if (typeof res.data?.revision === 'number') {
      revisionRef.current = res.data.revision;
    }
    setLastSavedAt(new Date());
    setDirty(false);
    setFormatSwitchPending(false);
    // Server-side draft state mirrors what the API just did with
    // this PATCH: autosaves leave a draft row in place; an explicit
    // Save promotes/clears it.
    setHasServerDraft(kind === 'autosave');
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
        setDoc(markdownToTiptapDoc(markdownSource.trim().length > 0 ? markdownSource : '\n'));
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

  // Status label tracks both the autosave setting (so operators know
  // whether their work is being silently persisted) and the actual
  // last-saved timestamp. Three states matter:
  //   - editing a fresh form (no saves yet) → "draft · unsaved"
  //   - autosave off → "saved Xs ago" (factual; no auto label)
  //   - autosave on → "auto-saved Xs ago" (signals continuous persistence)
  const savedAgo = lastSavedAt
    ? savedLabelMounted
      ? timeAgo(lastSavedAt, tz)
      : formatDateTime(lastSavedAt, tz)
    : '';
  const autosaveLabel = !lastSavedAt
    ? 'draft · unsaved'
    : autosaveEnabled && mode === 'edit'
      ? `auto-saved ${savedAgo}`
      : `saved ${savedAgo}`;
  // One measure for the title and the body beneath it, so the two never
  // drift apart. Prose stays at a readable 920; Markdown's single-pane
  // views get the wider 1200 a monospace source column wants, and Split
  // is uncapped because both panes have to share the full canvas.
  const canvasMaxWidth = editorMode === 'tiptap' ? 920 : markdownView === 'split' ? 'none' : 1200;

  const formatControl = (
    <span className="sd-editor-format-control">
      <select
        aria-label="Editor format"
        value={editorMode}
        onChange={(e) => startModeSwitch(e.target.value as ArticleEditorMode)}
        className="sd-editor-format-select"
      >
        <option value="tiptap">WYSIWYG</option>
        <option value="markdown">Markdown</option>
      </select>
      <span className="sd-editor-format-chevron" aria-hidden="true">
        <Icon.chevronD size={11} stroke={1.8} />
      </span>
    </span>
  );

  function navigateAway() {
    if (mode === 'edit' && article) {
      router.push(`/admin/companies/${companyId}/articles/${article.id}`);
    } else {
      router.push(`/admin/companies/${companyId}/articles`);
    }
    router.refresh();
  }

  /**
   * Cancel/Discard click handler. The button shows "Discard" in
   * Create mode and "Cancel" in Edit mode, but both go through here.
   *
   * If the form is clean AND there is no server-side draft, navigate
   * straight away — there's nothing to lose. Otherwise open the
   * confirmation dialog and let the operator decide.
   */
  function handleCancelClick() {
    if (!dirty && !hasServerDraft) {
      navigateAway();
      return;
    }
    setConfirmDiscardOpen(true);
  }

  /**
   * "Discard" inside the confirm dialog. When the server is holding
   * an autosave draft, we hit `DELETE /articles/:id/draft` first so
   * the live row reverts to the last published version before the
   * read view re-renders; otherwise the user lands on the
   * autosaved-but-unreviewed body, defeating the whole point of the
   * dialog.
   */
  async function performDiscard() {
    setDiscarding(true);
    if (mode === 'edit' && article && hasServerDraft) {
      const res = await apiFetch(`/companies/${companyId}/articles/${article.id}/draft`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        setDiscarding(false);
        setError(extractErr(res.problem) ?? 'Could not discard draft.');
        return;
      }
    }
    setDirty(false);
    setHasServerDraft(false);
    setConfirmDiscardOpen(false);
    setDiscarding(false);
    if (hasServerDraft) {
      toast.push('Draft discarded — reverted to last saved version.', 'ok');
    }
    navigateAway();
  }

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
        sub={
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                flexWrap: 'wrap',
                minWidth: 0,
              }}
            >
              {dirty && <Tag tone="warn">unsaved</Tag>}
              {hasServerDraft && !dirty && <Tag tone="warn">draft</Tag>}
            </div>
            <div
              className="page-header-actions"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
                justifyContent: 'flex-end',
              }}
            >
              <span className="article-editor-save-status">{autosaveLabel}</span>
              <Btn kind="outline" size="md" disabled={saving} onClick={handleCancelClick}>
                {mode === 'create' ? 'Discard' : 'Cancel'}
              </Btn>
              {mode === 'edit' && article && (
                <Btn
                  kind="outline"
                  size="md"
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
              {mode === 'edit' && article && (
                <ArticleActions
                  article={{
                    id: article.id,
                    companyId,
                    title: article.title,
                    archivedAt: article.archivedAt,
                  }}
                  layout="topbar"
                  dirty={dirty}
                />
              )}
              <Btn
                kind="primary"
                size="md"
                icon={Icon.check}
                loading={saving}
                onClick={() => submit('publish')}
              >
                {mode === 'create' ? 'Publish' : 'Save'}
              </Btn>
            </div>
          </>
        }
        subClassName="page-header-sub"
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
          gridTemplateColumns: !isMobile ? 'minmax(0, 1fr) 320px' : 'minmax(0, 1fr)',
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
                maxWidth: canvasMaxWidth,
                margin: '0 auto',
                width: 'calc(100% - 48px)',
                padding: '30px 0 20px',
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
                  marginBottom: 0,
                }}
              />
            </div>

            {editorMode === 'tiptap' ? (
              <div
                style={{
                  maxWidth: canvasMaxWidth,
                  margin: '0 auto',
                  width: 'calc(100% - 48px)',
                  padding: '0 0 80px',
                }}
              >
                <RichTextEditor
                  variant="article"
                  value={doc}
                  onChange={onDocChange}
                  companyId={companyId}
                  autoFocus={mode === 'create'}
                  toolbarPortalTarget={scrollEl}
                  toolbarEnd={formatControl}
                />
              </div>
            ) : (
              <div
                style={{
                  width: 'calc(100% - 48px)',
                  maxWidth: canvasMaxWidth,
                  margin: '0 auto',
                  padding: '0 0 16px',
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
                  view={markdownView}
                  onViewChange={setMarkdownView}
                  autoFocus={mode === 'create'}
                  companyId={companyId}
                  toolbarPortalTarget={scrollEl}
                  toolbarEnd={formatControl}
                />
              </div>
            )}
          </div>
        </div>

        {!isMobile && (
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
            <ArticleProperties
              folders={flatFolders}
              folderId={folderId}
              onFolderChange={(next) => {
                setFolderId(next);
                markDirty();
              }}
              visibleToClients={visibleToClients}
              onVisibilityChange={(next) => {
                setVisibleToClients(next);
                markDirty();
              }}
            />
            {mode === 'edit' && article ? (
              <>
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
              </>
            ) : (
              <CreateModeSidebarPlaceholders />
            )}
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
              background: 'var(--accent-fill)',
              color: 'var(--accent-fill-ink)',
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
          Converting may change formatting. Mentions, custom image layout, and complex tables can
          lose fidelity. You can still undo before saving.
        </p>
      </Dialog>

      <Dialog
        open={confirmDiscardOpen}
        onClose={() => {
          if (!discarding) setConfirmDiscardOpen(false);
        }}
        title={hasServerDraft ? 'Discard autosaved draft?' : 'Discard unsaved changes?'}
        width={460}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn kind="outline" onClick={() => setConfirmDiscardOpen(false)} disabled={discarding}>
              Keep editing
            </Btn>
            <Btn kind="danger" onClick={performDiscard} loading={discarding}>
              Discard
            </Btn>
          </div>
        }
      >
        <p style={{ margin: 0, lineHeight: 1.5, color: 'var(--text)' }}>
          {hasServerDraft
            ? 'This article has unsaved autosave changes on the server. Discarding will delete them and revert the article to the last published version.'
            : 'You have unsaved changes. Discarding will lose them.'}
        </p>
      </Dialog>
    </>
  );
}

function ArticleProperties({
  folders,
  folderId,
  onFolderChange,
  visibleToClients,
  onVisibilityChange,
}: {
  folders: Array<{ id: string; name: string; depth: number }>;
  folderId: string | null;
  onFolderChange: (next: string | null) => void;
  visibleToClients: boolean;
  onVisibilityChange: (next: boolean) => void;
}) {
  return (
    <section aria-label="Article properties" className="article-property-list">
      <div className="article-property-row">
        <label htmlFor="article-folder" className="article-property-label">
          <Icon.folder size={13} />
          Folder
        </label>
        <span className="article-property-folder-control">
          <select
            id="article-folder"
            aria-label="Folder"
            value={folderId ?? ''}
            onChange={(e) => onFolderChange(e.target.value || null)}
            className="article-property-folder-select"
          >
            <option value="">Unfiled</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {'· '.repeat(folder.depth)}
                {folder.name}
              </option>
            ))}
          </select>
          <span className="article-property-folder-chevron" aria-hidden="true">
            <Icon.chevronD size={10} />
          </span>
        </span>
      </div>
      <div className="article-property-row">
        <span className="article-property-label">
          <Icon.eye size={13} />
          Visibility
        </span>
        <label className="article-property-visibility-control">
          <span>{visibleToClients ? 'Clients' : 'Internal'}</span>
          <input
            type="checkbox"
            aria-label="Visible to clients"
            checked={visibleToClients}
            onChange={(e) => onVisibilityChange(e.target.checked)}
            className="article-property-switch"
          />
        </label>
      </div>
    </section>
  );
}

/**
 * Create mode has no article id yet, so the relations and attachments
 * endpoints have nothing to hang off. We still render both panels so
 * the rail doesn't reflow on first save — the copy carries the "not
 * yet" and no wrapper opacity does, because dimming the whole Panel
 * takes the titles down with it (`--dim` at 0.72 over `--panel` lands
 * near 3:1, under AA for 11.5px text).
 */
function CreateModeSidebarPlaceholders() {
  const unavailable = (
    <div style={{ color: 'var(--dim)', fontSize: 11.5, lineHeight: 1.5 }}>
      Save the article first to add items here.
    </div>
  );

  return (
    <>
      <Panel
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon.link size={12} style={{ color: 'var(--accent)' }} />
            Linked items
          </span>
        }
      >
        {unavailable}
      </Panel>
      <Panel
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon.doc size={12} style={{ color: 'var(--accent)' }} />
            Attachments
          </span>
        }
      >
        {unavailable}
      </Panel>
    </>
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

function timeAgo(d: Date, tz: string): string {
  const sec = Math.max(1, Math.round((Date.now() - d.getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return formatDate(d, tz);
}
