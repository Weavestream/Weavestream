'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type CSSProperties } from 'react';
import type { ChatToolCallDto } from '@weavestream/shared';
import {
  buildPatchPreview,
  computeLineDiff,
  isRewriteTargetHallucinated,
  proposalBaseFromArticle,
  splitMarkdownTitleAndBody,
  type ArticleTextEdit,
  type DiffOp,
  type PatchPreview,
  type PatchSource,
} from '@weavestream/shared';
import { apiFetch } from '../../lib/api';
import type { ArticleDetail } from '../../lib/server-api';
import { Icon } from '../ui';
import { useChatPanel, type ChatPageContextSnapshot, type ChatTab } from './chat-panel-provider';
import { SaveAsArticleDialog } from './save-as-article-dialog';

/**
 * Apply / Reject card rendered inline inside an assistant message
 * bubble whenever the model proposed an article-editing action.
 *
 * Pending state shows a header, optional one-line summary, a
 * collapsible diff (for patch_article / update_article) or preview (for
 * create_article), and the Apply / Reject buttons.
 *
 * Once acted on, the card collapses to a single-line status row
 * ("Applied" / "Rejected" / "Failed") so the conversation stays
 * legible after the user scrolled past it.
 */
export function ToolCallCard({
  tab,
  messageId,
  scopeCompanyId,
  toolCall,
}: {
  tab: ChatTab;
  messageId: string;
  /**
   * The company this turn was scoped to (null = global turn). Apply
   * binds a create to this scope and refuses a differing confirmed
   * destination, so the Save-as-article dialog locks its company
   * picker to it rather than offering a choice the server would reject.
   */
  scopeCompanyId: string | null;
  toolCall: ChatToolCallDto;
}) {
  const { state, applyToolCall, rejectToolCall, getPageDirty } = useChatPanel();
  const router = useRouter();
  const [busy, setBusy] = useState<'apply' | 'reject' | null>(null);
  const [showDiff, setShowDiff] = useState(true);
  // The created-article card stays collapsed by default to keep the
  // chat history scannable, but the body is still recoverable on
  // demand. Independent from the pending preview's `showDiff` so the
  // user's expanded state survives the apply transition cleanly.
  const [showCreatedBody, setShowCreatedBody] = useState(false);
  // `create_article` Apply routes through the Save-as-article dialog
  // so the user picks the target company / folder explicitly — the
  // LLM's `folder_id` is treated as advisory only. Article edit tools
  // keep the inline Apply flow because the target row is already
  // pinned to a real article.
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const pageContext = state.pageContext;

  const isPatch = toolCall.name === 'patch_article';
  const isRewrite = toolCall.name === 'update_article';
  const rawTargetArticleId =
    (isPatch || isRewrite) && typeof toolCall.arguments['article_id'] === 'string'
      ? toolCall.arguments['article_id']
      : null;
  // Prefer the server-resolved company on the proposal (F2): it lets the
  // patch preview fetch the article even from a chat with no company
  // shell (global-admin / freeform tabs), where page/company context is
  // absent and Apply would otherwise be permanently disabled. Falls back
  // to page/company context for legacy rows persisted before this field.
  const previewCompanyId =
    toolCall.targetCompanyId ??
    state.pageContext?.companyId ??
    state.companyContext?.companyId ??
    null;
  const patchPreviewKey =
    isPatch && rawTargetArticleId && previewCompanyId
      ? `${previewCompanyId}:${rawTargetArticleId}`
      : null;
  const [loadedPatchSource, setLoadedPatchSource] = useState<{
    key: string;
    source: Extract<PatchSource, { status: 'ready' | 'error' }>;
  } | null>(null);
  const patchSource: PatchSource = !patchPreviewKey
    ? { status: 'idle' }
    : loadedPatchSource?.key === patchPreviewKey
      ? loadedPatchSource.source
      : { status: 'loading' };

  useEffect(() => {
    if (!patchPreviewKey || !rawTargetArticleId || !previewCompanyId) return;
    const controller = new AbortController();
    void apiFetch<ArticleDetail>(`/companies/${previewCompanyId}/articles/${rawTargetArticleId}`, {
      signal: controller.signal,
    }).then((res) => {
      if (controller.signal.aborted) return;
      if (!res.ok || !res.data) {
        setLoadedPatchSource({
          key: patchPreviewKey,
          source: {
            status: 'error',
            message: 'The article could not be loaded for a safe preview.',
          },
        });
        return;
      }
      // Shared with mobile's card: markdown from whichever column the
      // editor mode populates, plus the rich-text flag that drives the
      // convert-to-Markdown warning (F10).
      setLoadedPatchSource({
        key: patchPreviewKey,
        source: { status: 'ready', ...proposalBaseFromArticle(res.data) },
      });
    }).catch(() => {
      // apiFetch swallows AbortError (returns a sentinel) but RE-THROWS
      // network failures. Without this handler a transient blip left the
      // card stuck on "Loading preview…" forever (deps never change, so
      // no retry) and surfaced an unhandled rejection. Fail into an error
      // source so Apply shows a message instead of hanging.
      if (controller.signal.aborted) return;
      setLoadedPatchSource({
        key: patchPreviewKey,
        source: {
          status: 'error',
          message: 'The article could not be loaded for a safe preview.',
        },
      });
    });
    return () => controller.abort();
  }, [patchPreviewKey, previewCompanyId, rawTargetArticleId]);

  // Read tools (WS-030) executed server-side during streaming; they
  // are never pending and have no Apply/Reject affordance — render a
  // compact status chip. (Placed after every hook: Rules of Hooks.)
  if (
    toolCall.name !== 'patch_article' &&
    toolCall.name !== 'update_article' &&
    toolCall.name !== 'create_article'
  ) {
    return <ReadToolChip toolCall={toolCall} />;
  }

  const isUpdate = isPatch || isRewrite;
  const args = toolCall.arguments as {
    article_id?: string;
    title?: string;
    markdown?: string;
    edits?: ArticleTextEdit[];
    folder_id?: string;
    visible_to_clients?: boolean;
    summary?: string;
  };
  // Preview the body exactly as the server will persist it on Apply —
  // a leading `# Heading` is promoted to the article title and removed
  // from the body so the rendered article doesn't show the title
  // twice. Keep this client preview aligned with the server's
  // `splitMarkdownTitleAndBody` strip so the user sees an accurate
  // diff before clicking Apply.
  const proposedMarkdown =
    typeof args.markdown === 'string' ? splitMarkdownTitleAndBody(args.markdown).body : '';
  const targetArticleId = rawTargetArticleId;
  // Narrow once — the article-specific page-context fields
  // (`onBeforeAiApply`, `onAfterAiApply`, etc.) only exist on the
  // article variant. The asset variant is read-only and never
  // referenced by tool-call apply.
  const articlePageContext = pageContext && pageContext.kind === 'article' ? pageContext : null;
  const targetIsCurrentPage =
    !!targetArticleId &&
    articlePageContext !== null &&
    articlePageContext.articleId === targetArticleId;
  // The set of article ids the LLM legitimately knows about for this
  // turn: the current page (if any) plus every explicitly @-mentioned
  // article. The system prompt instructs the model to only reference
  // ids it has seen there, so anything else is a hallucination and we
  // should treat the proposal as a brand-new article instead of
  // letting the apply path fail with "Article not found".
  const knownArticleIds = (() => {
    const ids = new Set<string>();
    if (articlePageContext?.articleId) ids.add(articlePageContext.articleId);
    for (const m of tab.mentions) {
      if (m.kind === 'article') ids.add(m.id);
    }
    return ids;
  })();
  // A rewrite whose target isn't the current page / an @-mention AND has
  // no server-captured basis is a hallucinated id → route to create.
  // The basis check (F2) keeps a `get_article`-found article in a freeform
  // tab classified as a real edit. See `isRewriteTargetHallucinated`.
  const rewriteTargetIsHallucinated = isRewriteTargetHallucinated({
    isRewrite,
    targetArticleId,
    knownArticleIds,
    baseRevision: toolCall.baseRevision,
  });
  // Treat hallucinated update targets exactly like a `create_article`
  // proposal — the header, preview, and Apply flow all route through
  // the Save-as-article dialog. The server-side fallback in
  // `applyUpdate` matches this: a missing article + user-confirmed
  // overrides becomes a create.
  const treatAsCreate = !isUpdate || rewriteTargetIsHallucinated;
  // The "current" body comes from the page context if the LLM is
  // updating the article currently being viewed/edited. Otherwise we
  // don't have it client-side (we'd have to re-fetch); for v1 we just
  // show the proposed body as a preview without a side-by-side diff.
  const currentMarkdown =
    targetIsCurrentPage && articlePageContext
      ? safeGetMarkdown(articlePageContext.getMarkdown)
      : null;

  const patchPreview = buildPatchPreview(
    patchSource,
    toolCall.baseRevision,
    args.title,
    args.edits,
  );
  // A patch that applies edits to a rich-text article converts it to
  // Markdown mode on the server (F10). Warn before Apply — a title-only
  // patch (no edits) leaves the body/mode untouched, so no warning.
  const patchConvertsToMarkdown =
    isPatch &&
    args.edits !== undefined &&
    patchSource.status === 'ready' &&
    patchSource.isRichText;

  const header = treatAsCreate
    ? `Proposed: create "${args.title ?? 'new article'}"`
    : isPatch
      ? `Proposed edit: "${resolvedArticleTitle(tab, pageContext, targetArticleId)}"`
      : `Proposed rewrite: "${resolvedArticleTitle(tab, pageContext, targetArticleId)}"`;

  async function onApply() {
    if (busy) return;
    // Anything that lands as a "create" — both genuine `create_article`
    // proposals and `update_article` calls against an article the LLM
    // hallucinated — goes through the Save-as-article dialog so the
    // user picks the target company / folder / title / visibility.
    // The server treats the dialog's overrides as the canonical
    // target and falls back to creating when the update target
    // doesn't exist.
    if (treatAsCreate) {
      setSaveDialogOpen(true);
      return;
    }
    if (isPatch && patchPreview.status !== 'ready') return;
    // Unsaved-changes guard: if the user is in the middle of editing
    // the same article the AI wants to overwrite, make them
    // acknowledge the swap before we clobber the form's body.
    if (targetIsCurrentPage && getPageDirty()) {
      const ok =
        typeof window === 'undefined'
          ? true
          : window.confirm(
              'You have unsaved edits in the article editor. Applying the AI suggestion will replace them with the reviewed article version. Continue?',
            );
      if (!ok) return;
    }
    setBusy('apply');
    articlePageContext?.onBeforeAiApply?.();
    const applyError = await applyToolCall(tab.id, messageId, toolCall.id);
    setBusy(null);
    if (applyError) return;
    // If we just mutated the article the user is looking at, sync
    // the page surface to the new body. We do BOTH:
    //  1. `onAfterAiApply` — for client-component editors that hold
    //     their own React state (article-form): patch state in place
    //     so the user immediately sees the change.
    //  2. `router.refresh()` — for server-rendered read-only views
    //     (`[articleId]/page.tsx`): re-fetch the article so the body
    //     and "last activity" panel update. The edit form's
    //     `onAfterAiApply` returns the new body without remount, so
    //     the refresh is a belt-and-suspenders pickup of server-side
    //     fields (slug, updatedBy, plaintext excerpt).
    if (targetIsCurrentPage) {
      const parsed =
        isRewrite && typeof args.markdown === 'string'
          ? splitMarkdownTitleAndBody(args.markdown)
          : null;
      const resolvedTitle =
        typeof args.title === 'string'
          ? args.title
          : parsed?.hadLeadingHeading
            ? parsed.title
            : undefined;
      const appliedMarkdown =
        isPatch && patchPreview.status === 'ready' ? patchPreview.markdown : parsed?.body;
      articlePageContext?.onAfterAiApply?.({
        ...(appliedMarkdown !== undefined && args.edits !== undefined
          ? { markdown: appliedMarkdown }
          : parsed
            ? { markdown: parsed.body }
            : {}),
        ...(resolvedTitle !== undefined ? { title: resolvedTitle } : {}),
      });
      router.refresh();
    }
  }

  async function onReject() {
    if (busy) return;
    setBusy('reject');
    await rejectToolCall(tab.id, messageId, toolCall.id);
    setBusy(null);
  }

  if (toolCall.status !== 'pending') {
    // Keep the proposed body recoverable on a settled "create" call
    // (either a real `create_article` or an `update_article` we
    // promoted to a create because the LLM hallucinated the target
    // id) so the chat history doesn't lose the AI's output once the
    // user navigates away. Legitimate `update_article` status rows
    // stay terse — the canonical body lives on the article itself,
    // and the diff against the pre-apply version was already gone.
    const settledAsCreate =
      toolCall.name === 'create_article' ||
      (toolCall.status === 'applied' &&
        typeof toolCall.result === 'string' &&
        toolCall.result.startsWith('Created article'));
    if (settledAsCreate && proposedMarkdown.trim()) {
      return (
        <CreatedArticleCard
          toolCall={toolCall}
          title={typeof args.title === 'string' ? args.title : 'new article'}
          summary={typeof args.summary === 'string' ? args.summary : null}
          markdown={proposedMarkdown}
          expanded={showCreatedBody}
          onToggle={() => setShowCreatedBody((v) => !v)}
        />
      );
    }
    return <StatusRow toolCall={toolCall} />;
  }

  // Default the dialog company to the article snapshot when present;
  // otherwise fall back to the broadcast company scope so the dialog
  // opens with a sensible pre-pick on home / asset pages too. A
  // company-scoped turn is not a default at all — it's the scope the
  // server binds the create to, so it locks the picker instead.
  const dialogDefaultCompanyId =
    state.pageContext?.companyId ?? state.companyContext?.companyId ?? null;
  const proposedTitle =
    typeof args.title === 'string' && args.title.trim() ? args.title : undefined;
  const proposedVisibleToClients =
    typeof args.visible_to_clients === 'boolean' ? args.visible_to_clients : false;

  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 6,
        background: 'var(--panel-2)',
        overflow: 'hidden',
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          borderBottom: '1px solid var(--line)',
          background: 'var(--panel)',
        }}
      >
        <Icon.doc size={13} style={{ color: 'var(--accent)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontWeight: 600,
              color: 'var(--text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={header}
          >
            {header}
          </div>
          {typeof args.summary === 'string' && args.summary.trim() && (
            <div style={{ color: 'var(--muted)', fontSize: 11.5, marginTop: 2 }}>
              {args.summary}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowDiff((v) => !v)}
          aria-label={showDiff ? 'Hide preview' : 'Show preview'}
          style={iconButtonStyle}
          title={showDiff ? 'Hide preview' : 'Show preview'}
        >
          <Icon.chevron
            size={11}
            style={{
              transform: showDiff ? 'rotate(180deg)' : 'none',
              transition: 'transform 0.15s',
            }}
          />
        </button>
      </div>

      {patchConvertsToMarkdown && (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 6,
            padding: '6px 10px',
            borderBottom: '1px solid var(--line)',
            background: 'var(--panel-2)',
            color: 'var(--warn, #b7791f)',
            fontSize: 11,
            lineHeight: 1.4,
          }}
        >
          <Icon.warn size={11} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>Applying converts this rich-text article to Markdown formatting.</span>
        </div>
      )}

      {showDiff && (
        <div
          className="scroll"
          style={{
            maxHeight: 320,
            overflow: 'auto',
            padding: 8,
            background: 'var(--panel-2)',
          }}
        >
          {isPatch ? (
            <PatchPreviewBlock preview={patchPreview} />
          ) : !treatAsCreate && currentMarkdown !== null ? (
            <DiffBlock before={currentMarkdown} after={proposedMarkdown} />
          ) : (
            <PreviewBlock markdown={proposedMarkdown} />
          )}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          gap: 6,
          padding: 8,
          borderTop: '1px solid var(--line)',
          justifyContent: 'flex-end',
          background: 'var(--panel)',
        }}
      >
        <button
          type="button"
          onClick={onReject}
          disabled={!!busy}
          style={btnStyle(false, busy === 'reject')}
        >
          {busy === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
        <button
          type="button"
          onClick={onApply}
          disabled={!!busy || (isPatch && patchPreview.status !== 'ready')}
          style={btnStyle(true, busy === 'apply')}
        >
          {busy === 'apply'
            ? 'Applying…'
            : isPatch && patchPreview.status === 'loading'
              ? 'Loading preview…'
              : 'Apply'}
        </button>
      </div>
      {treatAsCreate && (
        <SaveAsArticleDialog
          open={saveDialogOpen}
          markdown={typeof args.markdown === 'string' ? args.markdown : ''}
          {...(proposedTitle ? { defaultTitle: proposedTitle } : {})}
          pendingCreate={toolCall.pendingCreate}
          lockedCompanyId={scopeCompanyId}
          defaultCompanyId={dialogDefaultCompanyId}
          defaultVisibleToClients={proposedVisibleToClients}
          dialogTitle="Create article from suggestion"
          submitLabel="Create article"
          applyToolCall={async ({ companyId, title, folderId, visibleToClients }) => {
            const error = await applyToolCall(tab.id, messageId, toolCall.id, {
              companyId,
              createOverrides: { title, folderId, visibleToClients },
            });
            if (error) return { ok: false, error };
            // The tool-call apply endpoint surfaces a human-readable
            // result string but doesn't expose the new article id, so
            // we close without navigating — the chat history still
            // shows the "applied" badge with the proposed body for
            // recovery, and any company-scoped listings refresh.
            return { ok: true };
          }}
          onClose={() => setSaveDialogOpen(false)}
        />
      )}
    </div>
  );
}

function PatchPreviewBlock({ preview }: { preview: PatchPreview }) {
  if (preview.status === 'loading') {
    return <div style={{ color: 'var(--muted)' }}>Loading article preview…</div>;
  }
  if (preview.status === 'error') {
    return <div style={{ color: 'var(--warn, #b7791f)' }}>{preview.message}</div>;
  }
  if (preview.before === preview.markdown) {
    return <div style={{ color: 'var(--muted)' }}>Article body unchanged.</div>;
  }
  return <DiffBlock before={preview.before} after={preview.markdown} />;
}

/**
 * Settled-state card for a `create_article` tool call.
 *
 * Mirrors the visual chrome of the pending card so the assistant
 * turn keeps the same vertical rhythm before/after Apply, but swaps
 * the Apply/Reject footer for a status badge and starts collapsed
 * so the history stays scannable. Expanding reveals the exact
 * Markdown body that was persisted to the new article.
 */
function CreatedArticleCard({
  toolCall,
  title,
  summary,
  markdown,
  expanded,
  onToggle,
}: {
  toolCall: ChatToolCallDto;
  title: string;
  summary: string | null;
  markdown: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const tone: 'ok' | 'danger' | 'muted' =
    toolCall.status === 'applied' ? 'ok' : toolCall.status === 'failed' ? 'danger' : 'muted';
  const StatusIcon = tone === 'ok' ? Icon.check : tone === 'danger' ? Icon.x : Icon.chat;
  const toneColor =
    tone === 'ok'
      ? 'var(--ok, #2ea043)'
      : tone === 'danger'
        ? 'var(--danger, #c0392b)'
        : 'var(--muted)';
  const statusLabel =
    toolCall.status === 'applied'
      ? (toolCall.result ?? `Created article "${title}".`)
      : toolCall.status === 'rejected'
        ? `Rejected: ${title}`
        : `Failed: ${toolCall.error ?? 'unknown error'}`;
  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 6,
        background: 'var(--panel-2)',
        overflow: 'hidden',
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          borderBottom: expanded ? '1px solid var(--line)' : 'none',
          background: 'var(--panel)',
        }}
      >
        <StatusIcon size={13} style={{ color: toneColor, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontWeight: 600,
              color: 'var(--text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={statusLabel}
          >
            {statusLabel}
          </div>
          {summary && summary.trim() && (
            <div style={{ color: 'var(--muted)', fontSize: 11.5, marginTop: 2 }}>{summary}</div>
          )}
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide article content' : 'Show article content'}
          title={expanded ? 'Hide article content' : 'Show article content'}
          style={iconButtonStyle}
        >
          <Icon.chevron
            size={11}
            style={{
              transform: expanded ? 'rotate(-90deg)' : 'rotate(90deg)',
              transition: 'transform 0.15s',
            }}
          />
        </button>
      </div>
      {expanded && (
        <div
          className="scroll"
          style={{
            maxHeight: 320,
            overflow: 'auto',
            padding: 8,
            background: 'var(--panel-2)',
          }}
        >
          <PreviewBlock markdown={markdown} />
        </div>
      )}
    </div>
  );
}

/**
 * Compact one-line chip for an executed (or failed) read tool. The
 * persisted `result` is a server-written one-line summary — never
 * document content — and failures carry deliberately generic text.
 */
function ReadToolChip({ toolCall }: { toolCall: ChatToolCallDto }) {
  const verb =
    toolCall.name === 'search'
      ? 'Searched'
      : toolCall.name === 'find_related_items'
        ? 'Checked linked items'
        : toolCall.name === 'get_article'
          ? 'Read article'
          : toolCall.name === 'get_related_items'
            ? 'Checked linked items'
            : 'Company summary';
  const ok = toolCall.status === 'executed';
  const label = ok
    ? `${verb} — ${toolCall.result ?? 'done'}`
    : `${verb} — ${toolCall.error ?? 'not available'}`;
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 8px',
        border: '1px solid var(--line)',
        borderRadius: 6,
        background: 'var(--panel-2)',
        fontSize: 11.5,
        color: ok ? 'var(--muted)' : 'var(--warn, #b7791f)',
        maxWidth: '100%',
      }}
    >
      {ok ? <Icon.check size={11} /> : <Icon.x size={11} />}
      <span style={{ overflowWrap: 'anywhere' }}>{label}</span>
    </div>
  );
}

function StatusRow({ toolCall }: { toolCall: ChatToolCallDto }) {
  // A truncated/empty proposal is a "couldn't finish" warning, not a
  // hard failure — the server already put a friendly explanation in
  // `error`, so we show it without the alarming "Failed:" prefix.
  // Revision-guard refusals (stale / no_base) are the same kind of
  // soft outcome: the server's message tells the user how to proceed
  // and the newer article content was preserved, not lost.
  const isSoftFailure =
    toolCall.status === 'failed' &&
    (toolCall.errorCode === 'truncated' ||
      toolCall.errorCode === 'empty' ||
      toolCall.errorCode === 'stale' ||
      toolCall.errorCode === 'no_base' ||
      toolCall.errorCode === 'patch_missing' ||
      toolCall.errorCode === 'patch_ambiguous');
  const tone =
    toolCall.status === 'applied'
      ? 'ok'
      : toolCall.status === 'failed'
        ? isSoftFailure
          ? 'warn'
          : 'danger'
        : 'muted';
  const label =
    toolCall.status === 'applied'
      ? (toolCall.result ?? 'Applied.')
      : toolCall.status === 'rejected'
        ? 'Rejected.'
        : toolCall.status === 'failed'
          ? isSoftFailure
            ? (toolCall.error ?? 'The draft could not be completed.')
            : `Failed: ${toolCall.error ?? 'unknown error'}`
          : 'Pending.';
  const color =
    tone === 'ok'
      ? 'var(--ok, #2ea043)'
      : tone === 'danger'
        ? 'var(--danger, #c0392b)'
        : tone === 'warn'
          ? 'var(--warn, #b7791f)'
          : 'var(--muted)';
  const IconCmp = tone === 'ok' ? Icon.check : tone === 'muted' ? Icon.chat : Icon.x;
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 8px',
        border: '1px solid var(--line)',
        borderRadius: 6,
        background: 'var(--panel-2)',
        fontSize: 11.5,
        color,
      }}
    >
      <IconCmp size={11} />
      <span>{label}</span>
    </div>
  );
}

/**
 * Minimal line-level diff renderer. Computes the longest common
 * subsequence (good enough for ~hundreds of lines), then walks the
 * arrays emitting added / removed / unchanged rows. Pure presentation
 * — no external deps.
 */
function DiffBlock({ before, after }: { before: string; after: string }) {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  // Bounded (5b): null = over the shared cell budget — a newline-heavy
  // body would freeze the tab in the O(n·m) table. Fall back to the
  // proposed content with an explicit note instead of hanging.
  const ops = computeLineDiff(a, b);
  if (ops === null) {
    return (
      <div>
        <div style={{ color: 'var(--muted)', marginBottom: 4 }}>
          Change too large to diff — showing proposed content.
        </div>
        <PreviewBlock markdown={after} />
      </div>
    );
  }
  return (
    <pre
      style={{
        margin: 0,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: 11.5,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {ops.map((op, i) => (
        <DiffLine key={i} op={op} />
      ))}
    </pre>
  );
}

function DiffLine({ op }: { op: DiffOp }) {
  const palette: Record<DiffOp['kind'], { bg: string; fg: string; mark: string }> = {
    same: { bg: 'transparent', fg: 'var(--muted)', mark: '  ' },
    add: {
      bg: 'color-mix(in oklch, var(--ok, #2ea043) 14%, var(--panel-2))',
      fg: 'var(--text)',
      mark: '+ ',
    },
    del: {
      bg: 'color-mix(in oklch, var(--danger, #c0392b) 14%, var(--panel-2))',
      fg: 'var(--text)',
      mark: '- ',
    },
  };
  const c = palette[op.kind];
  return (
    <div style={{ background: c.bg, color: c.fg, padding: '0 4px' }}>
      <span style={{ color: 'var(--dim)' }}>{c.mark}</span>
      {op.text}
    </div>
  );
}

function PreviewBlock({ markdown }: { markdown: string }) {
  return (
    <pre
      style={{
        margin: 0,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: 11.5,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--text)',
      }}
    >
      {markdown}
    </pre>
  );
}

function resolvedArticleTitle(
  tab: ChatTab,
  pageContext: ChatPageContextSnapshot | null,
  articleId: string | null,
): string {
  if (!articleId) return 'article';
  if (pageContext?.kind === 'article' && pageContext.articleId === articleId) {
    return pageContext.title;
  }
  const mention = tab.mentions.find((m) => m.id === articleId);
  if (mention) return mention.title;
  return 'article';
}

function safeGetMarkdown(get: () => string): string {
  try {
    return get();
  } catch {
    return '';
  }
}

const iconButtonStyle: CSSProperties = {
  width: 22,
  height: 22,
  display: 'grid',
  placeItems: 'center',
  border: '1px solid var(--line)',
  borderRadius: 4,
  background: 'var(--panel-2)',
  color: 'var(--muted)',
  cursor: 'pointer',
};

function btnStyle(primary: boolean, busy: boolean): CSSProperties {
  return {
    height: 26,
    padding: '0 10px',
    borderRadius: 5,
    border: '1px solid var(--line)',
    background: primary ? 'var(--accent)' : 'var(--surface)',
    color: primary ? 'var(--accent-ink)' : 'var(--text)',
    cursor: busy ? 'wait' : 'pointer',
    fontSize: 12,
    fontWeight: 600,
    opacity: busy ? 0.7 : 1,
  };
}
