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
  problemMessage,
} from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import { useTimezone } from '../../../../../lib/timezone-context';
import type { FolderNode } from '@weavestream/shared';
import type { ArticleDetail } from '../../../../../lib/server-api/articles';
import {
  Btn,
  Dialog,
  Icon,
  MenuDivider,
  MenuItem,
  OverflowMenu,
  Panel,
  Sheet,
  SplitBtn,
  Tag,
  useToast,
} from '../../../../../components/ui';
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
import { NARROW_DESKTOP_PX } from '../../../../../lib/breakpoints';
import { markdownToTiptapDoc, tiptapDocToMarkdown } from '../../../../../lib/article-format';
import { useArticleArchive } from './article-actions';

/**
 * Shared create + edit form. A single client component handles both
 * modes. Autosave is OFF by default and gated by the workspace-wide
 * `SystemSetting.articleAutosaveEnabled` toggle (see
 * /admin/settings → Article editor). When enabled, edits coalesce
 * into a single rolling draft `ArticleVersion` row on the server via
 * `PATCH /articles/:id { draft: true }`; clicking Save promotes that
 * draft to a published version, Cancel discards it and reverts the
 * article row to the last published version.
 *
 * Only **Publish** publishes. "Save draft" (in Publish's dropdown) is
 * the manual version of one autosave tick, so the draft path works
 * with autosave off too. In Create mode it creates the article with a
 * draft v1 (`POST { draft: true }`) — never published — and reopens it
 * in the editor. Cancel never discards a saved draft; "Discard draft"
 * in the same dropdown does, and only when a published version exists
 * to revert to.
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
  const [dirty, setDirtyState] = useState(false);
  // `dirtyRef` mirrors `dirty` synchronously so code that resumes after
  // an `await` (Cancel waiting for a save) reads the current value, not
  // the one its closure captured.
  const dirtyRef = useRef(false);
  const setDirty = useCallback((next: boolean) => {
    dirtyRef.current = next;
    setDirtyState(next);
  }, []);
  // Bumped on every edit. A save records the value it sent and clears
  // `dirty` only if no edit happened while the request was in flight —
  // otherwise the newer edits would be treated as saved.
  const editSeq = useRef(0);
  // Saves run one at a time through this queue, so an older autosave
  // can never reach the server after a newer save, and Cancel / the
  // discard actions can wait for every outstanding save by awaiting
  // the tail. The tail never rejects.
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  // True from the moment a save that leaves the page (any save of a new
  // article, or Publish) is requested until it fails. The form is inert
  // meanwhile, so nothing typed during the request is silently dropped
  // by the navigation that follows.
  const [formLocked, setFormLocked] = useState(false);
  // Autosave stands down while Cancel or a discard confirm is in
  // progress, so the timer cannot save the edits being discarded.
  const [autosaveHeld, setAutosaveHeld] = useState(false);
  // Tracks whether the server is currently holding an in-progress
  // autosave draft for this article. Seeded from the detail load and
  // flipped by autosave success / publish / discard. Drives the
  // Cancel dialog (must call the discard endpoint when true) and the
  // "Discard draft" affordance in the topbar.
  const [hasServerDraft, setHasServerDraft] = useState<boolean>(article?.hasDraft ?? false);
  // False for a never-published article (its only version is a draft).
  // Draft writes cannot change it; Publish navigates away.
  const isPublished = mode === 'edit' && (article?.isPublished ?? true);
  // Which confirm is open: losing unsaved local edits on Cancel, or
  // deleting the saved draft via "Discard draft".
  const [confirmDiscard, setConfirmDiscard] = useState<'unsaved' | 'draft' | null>(null);
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
  // The read view's rails collapse at 1240 (see the narrow-desktop stage
  // in `globals.css`); the editor has to agree or the same article gains
  // a 320px rail the moment you click Edit. Below this the properties
  // rail moves into the bottom sheet and the canvas claims the width.
  // `isMobile` still governs the phone-only affordances beneath it.
  const isNarrow = useIsMobile(NARROW_DESKTOP_PX);
  const [detailsOpen, setDetailsOpen] = useState(false);
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
  }, [setDirty]);
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
    if (autosaveHeld) return;
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      void submit('autosave');
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
    autosaveHeld,
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
    // A saved draft is kept on leave (see Cancel), so only unsaved
    // local edits are at risk.
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty, mode]);

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
    editSeq.current += 1;
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
   * caller appends the optional `draft: true` flag for autosave and
   * Save-draft PATCHes (omitted otherwise so the server treats it as
   * an explicit Save).
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

  /**
   * - `publish`: Publish — a new published version (or promotes the
   *   draft). The only kind that publishes.
   * - `draft`: the user's "Save draft" — same server path as autosave,
   *   but user-initiated, so it reports validation errors and stays in
   *   the editor with a toast.
   * - `autosave`: the debounce timer — silent on validation failures.
   */
  function submit(kind: 'publish' | 'draft' | 'autosave'): Promise<boolean> {
    // The body is this render's state, so the edit count is taken now
    // too — not when the queued request finally runs.
    const sentSeq = editSeq.current;
    const leavesPage = mode === 'create' || kind === 'publish';
    if (leavesPage) setFormLocked(true);
    const run = saveQueue.current.then(() => runSubmit(kind, sentSeq));
    saveQueue.current = run.then(
      () => undefined,
      // A failed save already reported itself; the queue only orders
      // requests and must keep running.
      () => undefined,
    );
    if (leavesPage) {
      void run.then(
        (navigated) => {
          if (!navigated) setFormLocked(false);
        },
        () => setFormLocked(false),
      );
    }
    return run;
  }

  /** Let a save in flight settle before Cancel or a discard acts. */
  async function settleInflight() {
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }
    // Waits for every queued save, not just the latest one.
    await saveQueue.current;
  }

  /** Runs one queued save. Resolves `true` when it navigated away. */
  async function runSubmit(
    kind: 'publish' | 'draft' | 'autosave',
    sentSeq: number,
  ): Promise<boolean> {
    const manual = kind !== 'autosave';
    setError(null);
    const t = title.trim();
    if (!t) {
      setError('Title is required.');
      return false;
    }
    if (editorMode === 'markdown' && !markdownSource.trim()) {
      if (manual) {
        setError('Add some Markdown content before saving.');
      }
      return false;
    }
    if (mode === 'create') {
      const body = buildBody('create');
      if (!body) {
        if (manual) {
          setError('Add some content before publishing.');
        }
        return false;
      }
      setSaving(true);
      const res = await apiFetch<{ id: string }>(`/companies/${companyId}/articles`, {
        method: 'POST',
        // `draft: true` makes v1 a draft: nothing is published.
        body: JSON.stringify(kind === 'draft' ? { ...body, draft: true } : body),
      });
      if (!res.ok || !res.data) {
        setSaving(false);
        setError(problemMessage(res.problem) ?? 'Create failed');
        return false;
      }
      // Success navigates away: stay "saving" (and locked) until the
      // page changes, so nothing can be typed into a form being left.
      if (kind === 'draft') {
        // No draft row can exist before the article does, so Save draft
        // creates it and reopens it in the editor; later Save draft
        // clicks there take the regular draft PATCH path.
        toast.push('Draft saved — not published', 'ok');
        router.push(`/admin/companies/${companyId}/articles/${res.data.id}/edit`);
      } else {
        toast.push('Article published', 'ok');
        router.push(`/admin/companies/${companyId}/articles/${res.data.id}`);
      }
      router.refresh();
      return true;
    }

    if (!article) return false;
    // A draft write with nothing changed is a server no-op (no draft
    // row), so a "Draft saved" toast would claim a save that did not
    // happen. Say so instead of sending it.
    if (kind === 'draft' && !dirty) {
      toast.push('No changes to save as a draft', 'ok');
      return false;
    }
    if (kind === 'autosave' && !canAutosaveBody()) {
      return false;
    }
    const payload = buildBody('edit');
    if (!payload) {
      return false;
    }
    // Tell the API to coalesce into the rolling draft instead of
    // producing a new published version. Explicit Save omits the
    // flag so the server's `update(draft=false)` path runs.
    const body = kind === 'publish' ? payload : { ...payload, draft: true };
    if (manual) setSaving(true);
    const res = await apiFetch<{ revision?: number; hasDraft?: boolean }>(
      `/companies/${companyId}/articles/${article.id}`,
      {
        method: 'PATCH',
        body: JSON.stringify(body),
      },
    );
    if (manual) setSaving(false);
    if (!res.ok) {
      setError(problemMessage(res.problem) ?? 'Save failed');
      return false;
    }
    // Track the bumped revision so the chat snapshot's basis claim
    // stays honest across autosaves (WS-030).
    if (typeof res.data?.revision === 'number') {
      revisionRef.current = res.data.revision;
    }
    setLastSavedAt(new Date());
    // Edits made while the request was in flight are not in this save.
    if (editSeq.current === sentSeq) {
      setDirty(false);
      setFormatSwitchPending(false);
    }
    // Server-side draft state mirrors what the API just did with
    // this PATCH: draft writes leave a draft row in place; an explicit
    // Save promotes/clears it. Prefer the server's answer — a no-op
    // draft write on a clean article creates no draft row.
    setHasServerDraft(res.data?.hasDraft ?? kind !== 'publish');
    if (kind === 'draft') {
      toast.push(isPublished ? 'Draft saved' : 'Draft saved — not published', 'ok');
    }
    if (kind === 'publish') {
      toast.push('Article published', 'ok');
      router.push(`/admin/companies/${companyId}/articles/${article.id}`);
      router.refresh();
      return true;
    }
    return false;
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
    editSeq.current += 1;
    setDirty(true);
    if (mode === 'edit') {
      setFormatSwitchPending(true);
    }
  }

  // Status label tracks both the autosave setting (so operators know
  // whether their work is being silently persisted) and the actual
  // last-saved timestamp. Three states matter:
  //   - editing a fresh form (no saves yet) → "not saved yet"
  //   - autosave off → "saved Xs ago" (factual; no auto label)
  //   - autosave on → "auto-saved Xs ago" (signals continuous persistence)
  const savedAgo = lastSavedAt
    ? savedLabelMounted
      ? timeAgo(lastSavedAt, tz)
      : formatDateTime(lastSavedAt, tz)
    : '';
  const autosaveLabel = !lastSavedAt
    ? 'not saved yet'
    : autosaveEnabled && mode === 'edit'
      ? `auto-saved ${savedAgo}`
      : `saved ${savedAgo}`;

  // Archive / restore / permanent-delete, shared with the read view and
  // the list rows. The hook is unconditional (rules of hooks); the menu
  // rows and dialogs that drive it only render in edit mode, where an
  // article actually exists to archive.
  const {
    archived,
    requestArchiveToggle,
    requestPurge,
    dialogs: archiveDialogsNode,
  } = useArticleArchive({
    article: {
      id: article?.id ?? '',
      companyId,
      title: article?.title ?? '',
      archivedAt: article?.archivedAt ?? null,
    },
    dirty,
  });
  const archiveDialogs = mode === 'edit' && article ? archiveDialogsNode : null;

  // One definition, two placements: the right rail above the
  // narrow-desktop threshold, the bottom sheet below it. Folder and
  // visibility travel with the panels — on a narrow viewport they were
  // previously unreachable from the editor at all, because the old
  // sheet carried only links and attachments.
  const sidebarContent = (
    <>
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
    </>
  );
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
   * Cancel only ever drops *unsaved* local edits: a saved draft stays
   * (it was saved on purpose, or by autosave) and is removed only by
   * "Discard draft". A clean form leaves straight away.
   */
  async function handleCancelClick() {
    // Hold autosave first, then let any save in flight land: edits it
    // carries were made before Cancel and become part of the saved
    // draft, which Cancel keeps. Only what is still unsaved after that
    // is offered for discard.
    setAutosaveHeld(true);
    await settleInflight();
    if (!dirtyRef.current) {
      navigateAway();
      return;
    }
    setConfirmDiscard('unsaved');
  }

  function closeDiscardConfirm() {
    setConfirmDiscard(null);
    setAutosaveHeld(false);
  }

  /**
   * Confirm-dialog action. `unsaved` just leaves. `draft` calls
   * `DELETE /articles/:id/draft` first so the live row reverts to the
   * last published version before the read view re-renders. Only
   * offered when a published version exists — a never-published
   * article has nothing to revert to (Archive removes it).
   */
  async function performDiscard() {
    const discardDraft = confirmDiscard === 'draft';
    setDiscarding(true);
    // A draft write landing after the DELETE would re-create the draft.
    await settleInflight();
    if (discardDraft && article) {
      const res = await apiFetch(`/companies/${companyId}/articles/${article.id}/draft`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        setDiscarding(false);
        closeDiscardConfirm();
        setError(problemMessage(res.problem) ?? 'Could not discard draft.');
        return;
      }
      setHasServerDraft(false);
      toast.push('Draft discarded — reverted to the published version.', 'ok');
    }
    setDirty(false);
    setConfirmDiscard(null);
    setDiscarding(false);
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
        // Same shape as the read view: the editor's own controls sit in
        // the breadcrumb row rather than in a second 50px row below it.
        // Cancel and Save stay visible — Cancel is the escape hatch and
        // must never hide in a menu — while Preview and Archive move
        // into the overflow.
        right={
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="article-editor-save-status hide-on-narrow">
              {autosaveLabel}
            </span>
            {dirty && <Tag tone="warn">unsaved</Tag>}
            {mode === 'edit' && !isPublished && !dirty && <Tag tone="warn">not published</Tag>}
            {hasServerDraft && isPublished && !dirty && <Tag tone="warn">draft</Tag>}
            <Btn
              kind="outline"
              size="md"
              disabled={saving || formLocked}
              onClick={() => void handleCancelClick()}
            >
              {mode === 'create' ? 'Discard' : 'Cancel'}
            </Btn>
            {/* Only Publish publishes, so it is the one primary action and
                is never labelled "Save". The draft actions sit behind its
                chevron rather than competing for a header slot. */}
            <SplitBtn
              icon={Icon.check}
              loading={saving || formLocked}
              onClick={() => void submit('publish')}
              menuLabel="Draft options"
              menu={(close) => (
                <>
                  <MenuItem
                    icon={Icon.edit}
                    disabled={saving}
                    onClick={() => {
                      close();
                      void submit('draft');
                    }}
                  >
                    Save draft
                  </MenuItem>
                  {hasServerDraft && isPublished && (
                    <>
                      <MenuDivider />
                      <MenuItem
                        icon={Icon.x}
                        tone="danger"
                        disabled={saving}
                        onClick={() => {
                          close();
                          setAutosaveHeld(true);
                          setConfirmDiscard('draft');
                        }}
                      >
                        Discard draft
                      </MenuItem>
                    </>
                  )}
                </>
              )}
            >
              Publish
            </SplitBtn>
            {/* The menu is the only route to the properties rail below
                1240, so it cannot be gated on edit mode: a *new* article
                is exactly when Folder and Visibility matter, and on a
                laptop the phone's floating trigger never appears. */}
            {(isNarrow || (mode === 'edit' && article)) && (
              <OverflowMenu>
                {(close) => (
                  <>
                    {isNarrow && (
                      <MenuItem
                        icon={Icon.sliders}
                        onClick={() => {
                          setDetailsOpen(true);
                          close();
                        }}
                      >
                        Details
                      </MenuItem>
                    )}
                    {mode === 'edit' && article && (
                      <>
                        <MenuItem
                          icon={Icon.ext}
                          onClick={() => {
                            window.open(
                              `/admin/companies/${companyId}/articles/${article.id}`,
                              '_blank',
                              'noopener,noreferrer',
                            );
                            close();
                          }}
                        >
                          Preview
                        </MenuItem>
                        <MenuDivider />
                        {archived ? (
                          <MenuItem
                            icon={Icon.trash}
                            tone="danger"
                            onClick={() => {
                              requestPurge();
                              close();
                            }}
                          >
                            Delete forever
                          </MenuItem>
                        ) : (
                          <MenuItem
                            icon={Icon.archive}
                            onClick={() => {
                              requestArchiveToggle();
                              close();
                            }}
                          >
                            Archive
                          </MenuItem>
                        )}
                      </>
                    )}
                  </>
                )}
              </OverflowMenu>
            )}
            {archiveDialogs}
          </div>
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
        // Read-only while a save that leaves the page is under way.
        inert={formLocked}
        aria-busy={formLocked || undefined}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: !isNarrow ? 'minmax(0, 1fr) 320px' : 'minmax(0, 1fr)',
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

        {!isNarrow && (
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
            {sidebarContent}
          </aside>
        )}
      </div>

      {isNarrow && (
        <>
          {/* Thumb-reach shortcut, phones only. Above 768 the same sheet
              opens from the header's overflow menu, where a floating pill
              over a laptop-sized canvas would just be in the way. */}
          {isMobile && (
            <button
              type="button"
              onClick={() => setDetailsOpen(true)}
              aria-label="Open article details"
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
              <Icon.sliders size={14} /> Details
            </button>
          )}
          <Sheet
            open={detailsOpen}
            onClose={() => setDetailsOpen(false)}
            side="bottom"
            ariaLabel="Article details"
            height="min(80vh, 640px)"
          >
            <div
              inert={formLocked}
              style={{
                padding: 16,
                overflow: 'auto',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                gap: 20,
              }}
            >
              {sidebarContent}
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
        open={confirmDiscard !== null}
        onClose={() => {
          if (!discarding) closeDiscardConfirm();
        }}
        title={confirmDiscard === 'draft' ? 'Discard draft?' : 'Discard unsaved changes?'}
        width={460}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn kind="outline" onClick={closeDiscardConfirm} disabled={discarding}>
              Keep editing
            </Btn>
            <Btn kind="danger" onClick={performDiscard} loading={discarding}>
              {confirmDiscard === 'draft' ? 'Discard draft' : 'Discard changes'}
            </Btn>
          </div>
        }
      >
        <p style={{ margin: 0, lineHeight: 1.5, color: 'var(--text)' }}>
          {confirmDiscard === 'draft'
            ? 'This deletes the saved draft and reverts the article to its published version. Any unsaved changes are lost too.'
            : hasServerDraft
              ? 'Your changes since the last draft save will be lost. The saved draft is kept.'
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

function timeAgo(d: Date, tz: string): string {
  const sec = Math.max(1, Math.round((Date.now() - d.getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return formatDate(d, tz);
}
