import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  buildPatchPreview,
  proposalBaseFromArticle,
  splitMarkdownTitleAndBody,
  type PatchPreview,
  type PatchSource,
} from '@weavestream/shared';
import { UUID_RE } from '../../lib/uuid';
import { apiFetch } from '../../lib/api';
import { useOrgScope } from '../../lib/org-scope';
import { useArticleDetail } from '../../features/articles/queries';
import { Icon } from '../Icon';
import { Button } from '../primitives';
import { useAsk } from './AskProvider';
import { CreateArticleSheet } from './CreateArticleSheet';
import { DiffView, ProposedBody } from './DiffView';
import type { AskMessage } from './ask-reducer';
import type { ProposalView } from './proposal-card';

/**
 * The Ask proposal card (Phase 5b): preview, Apply, and Reject for
 * `create_article` / `patch_article` / `update_article`, replacing the
 * Phase 3 "Review and apply on desktop" holdover. Desktop's
 * ToolCallCard is the behavioral reference (no-drift standard) —
 * operations identical, styling mobile's own.
 *
 * The load-bearing rules:
 *
 *  - **Never apply a proposal the user cannot preview.** Patch AND
 *    revision-guarded update proposals gate Apply on the shared
 *    ladder's `ready` state, which requires the fetched base article at
 *    the matching revision — including title-only updates (an
 *    unfetchable target must not be appliable "blind").
 *  - **The fetch scope is the proposal's own** — `targetCompanyId`
 *    (server-resolved) first, current org second. In global Ask the
 *    hint is the only source; without one the ladder reports
 *    unavailable and Apply stays disabled.
 *  - **A failed Apply is never presented as success**: settled states
 *    render exactly what the server persisted, and the transient
 *    action error keeps the card pending with the message inline.
 *  - **One action at a time, globally**: every card's buttons disable
 *    while any action is in flight (the provider enforces the same
 *    rule, so a stray tap is a no-op either way).
 */
export function ProposalCard({
  view,
  message,
}: {
  view: ProposalView;
  message: AskMessage;
}) {
  const { state, applyToolCall, rejectToolCall } = useAsk();
  const { currentOrg } = useOrgScope();
  const [sheetOpen, setSheetOpen] = useState(false);

  const call = view.call;
  const serverMessageId = message.serverMessageId;
  const busy = state.toolAction;
  const busyHere = busy?.toolCallId === call.id ? busy.kind : null;
  const actionError =
    state.toolActionError?.toolCallId === call.id
      ? state.toolActionError.message
      : null;

  // ------------------------------------------------------------------
  // Base fetch — pending edit proposals only (creates carry their body).
  // ------------------------------------------------------------------
  const isPendingEdit = call.status === 'pending' && !view.treatAsCreate;
  const previewCompanyId = call.targetCompanyId ?? currentOrg?.id ?? null;
  const fetchArticleId =
    isPendingEdit && view.articleId && UUID_RE.test(view.articleId)
      ? view.articleId
      : '';
  const baseQuery = useArticleDetail(
    fetchArticleId ? previewCompanyId : null,
    fetchArticleId,
  );

  const source: PatchSource = !isPendingEdit
    ? { status: 'idle' }
    : !previewCompanyId || !fetchArticleId
      ? { status: 'idle' }
      : baseQuery.isPending
        ? { status: 'loading' }
        : baseQuery.isError || !baseQuery.data
          ? {
              status: 'error',
              message: 'The article could not be loaded for a safe preview.',
            }
          : { status: 'ready', ...proposalBaseFromArticle(baseQuery.data) };

  // The org chip: name the target org whenever the proposal knows it.
  const orgName = useCompanyName(
    call.status === 'pending' ? call.targetCompanyId ?? null : null,
  );

  // ------------------------------------------------------------------
  // Settled states first — exactly what the server persisted.
  // ------------------------------------------------------------------
  if (call.status !== 'pending') {
    return <SettledCard view={view} />;
  }

  // ------------------------------------------------------------------
  // Pending: create / promotion → sheet-confirmed apply.
  // ------------------------------------------------------------------
  if (view.treatAsCreate) {
    const body = view.markdown ? splitMarkdownTitleAndBody(view.markdown).body : '';
    const canAct = !!serverMessageId && !busy;
    return (
      <CardShell headline={view.headline} title={view.title}>
        {orgName && <OrgLine name={orgName} />}
        {body ? (
          <CollapsibleBody markdown={body} />
        ) : (
          <p className="text-[13px] text-warn">
            The assistant response is empty.
          </p>
        )}
        {actionError && <ErrorLine message={actionError} />}
        <CardActions
          applyLabel={busyHere === 'apply' ? 'Applying…' : 'Apply…'}
          rejectLabel={busyHere === 'reject' ? 'Rejecting…' : 'Reject'}
          applyDisabled={!canAct || !body}
          rejectDisabled={!canAct}
          onApply={() => setSheetOpen(true)}
          onReject={() => {
            if (serverMessageId) void rejectToolCall(serverMessageId, call.id);
          }}
        />
        <CreateArticleSheet
          open={sheetOpen}
          view={view}
          scopeCompanyId={message.scopeCompanyId}
          onClose={() => setSheetOpen(false)}
          onSubmit={async (companyId, overrides) => {
            if (!serverMessageId) return;
            await applyToolCall(serverMessageId, call.id, {
              companyId,
              createOverrides: overrides,
            });
          }}
        />
      </CardShell>
    );
  }

  // ------------------------------------------------------------------
  // Pending: rewrite whose hallucinated target has no body — cannot
  // promote to a create, cannot edit. Reject is the only action.
  // ------------------------------------------------------------------
  if (view.isRewrite && view.markdown === null && typeof call.baseRevision !== 'number') {
    return (
      <CardShell headline={view.headline} title={view.title}>
        <p className="text-[13px] text-warn">
          This proposal was not based on a confirmed article revision.
        </p>
        {actionError && <ErrorLine message={actionError} />}
        <CardActions
          applyLabel="Apply"
          rejectLabel={busyHere === 'reject' ? 'Rejecting…' : 'Reject'}
          applyDisabled
          rejectDisabled={!serverMessageId || !!busy}
          onApply={() => {}}
          onReject={() => {
            if (serverMessageId) void rejectToolCall(serverMessageId, call.id);
          }}
        />
      </CardShell>
    );
  }

  // ------------------------------------------------------------------
  // Pending: patch / revision-guarded update. One shared ladder; the
  // proposed AFTER differs per shape.
  // ------------------------------------------------------------------
  const hasBody = view.markdown !== null;
  const hasTitle = view.title !== null;
  const proposedBody = hasBody
    ? splitMarkdownTitleAndBody(view.markdown ?? '').body
    : null;

  const ladder: PatchPreview = view.isPatch
    ? buildPatchPreview(source, call.baseRevision, view.title ?? undefined, view.edits)
    : !hasBody && !hasTitle
      ? { status: 'error', message: 'The proposed edit does not contain any changes.' }
      : buildPatchPreview(
          source,
          call.baseRevision,
          // The ladder's change-detection rung: any update with a body
          // or a title IS a change; edits stay undefined for rewrites.
          view.title ?? (hasBody ? '' : undefined),
          undefined,
        );

  const ready = ladder.status === 'ready';
  const richTextWarning =
    view.isPatch &&
    view.edits !== undefined &&
    source.status === 'ready' &&
    source.isRichText;
  const canAct = !!serverMessageId && !busy;

  return (
    <CardShell headline={view.headline} title={view.title}>
      {orgName && <OrgLine name={orgName} />}

      {ladder.status === 'loading' && (
        <p className="text-[13px] text-muted">Loading article preview…</p>
      )}
      {ladder.status === 'error' && (
        <p className="text-[13px] text-warn">{ladder.message}</p>
      )}
      {ready && view.isPatch && (
        <DiffView before={ladder.before} after={ladder.markdown} />
      )}
      {ready && !view.isPatch && proposedBody !== null && (
        <DiffView before={ladder.before} after={proposedBody} />
      )}
      {ready && !view.isPatch && proposedBody === null && (
        <TitleOnlyChange
          from={source.status === 'ready' ? titleOf(baseQuery.data) : null}
          to={view.title ?? ''}
        />
      )}

      {richTextWarning && (
        <p className="text-[13px] text-warn">
          Applying converts this rich-text article to Markdown formatting.
        </p>
      )}
      {actionError && <ErrorLine message={actionError} />}

      <CardActions
        applyLabel={
          busyHere === 'apply'
            ? 'Applying…'
            : ladder.status === 'loading'
              ? 'Loading preview…'
              : 'Apply'
        }
        rejectLabel={busyHere === 'reject' ? 'Rejecting…' : 'Reject'}
        applyDisabled={!canAct || !ready}
        rejectDisabled={!canAct}
        onApply={() => {
          // Patch/update sends NO companyId: the persisted turn context
          // is authoritative, and the current org could belong to a
          // different tenant than the proposal's target.
          if (serverMessageId) void applyToolCall(serverMessageId, call.id);
        }}
        onReject={() => {
          if (serverMessageId) void rejectToolCall(serverMessageId, call.id);
        }}
      />
    </CardShell>
  );
}

function titleOf(article: { title?: string } | undefined): string | null {
  return article && typeof article.title === 'string' ? article.title : null;
}

/**
 * Company name for the org chip. Keyed under 'companies' so the
 * org-switch predicate invalidation covers it; server-authorized like
 * every read (a 403/404 simply drops the chip).
 */
function useCompanyName(companyId: string | null): string | null {
  const query = useQuery({
    queryKey: ['companies', companyId, 'name'],
    queryFn: ({ signal }) =>
      apiFetch<{ id: string; name: string }>(`/companies/${companyId}`, { signal }),
    enabled: companyId !== null,
    staleTime: 5 * 60 * 1000,
  });
  return query.data?.name ?? null;
}

// ---------------------------------------------------------------------
// Presentational pieces
// ---------------------------------------------------------------------

function CardShell({
  headline,
  title,
  children,
}: {
  headline: string;
  title: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-group border border-line bg-surface p-3.5">
      <div className="flex items-center gap-2">
        <Icon name="description" size={20} className="text-accent" />
        <span className="text-body font-semibold text-text">{headline}</span>
      </div>
      {title && <p className="truncate text-body text-text-2">{title}</p>}
      {children}
    </div>
  );
}

function OrgLine({ name }: { name: string }) {
  return (
    <p className="flex items-center gap-1.5 text-[13px] font-medium text-accent-text">
      <Icon name="apartment" size={16} className="shrink-0" />
      <span className="truncate">{name}</span>
    </p>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <p className="text-[13px] text-danger" role="alert">
      {message}
    </p>
  );
}

function TitleOnlyChange({ from, to }: { from: string | null; to: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-field bg-panel-2 p-2 text-[13.5px]">
      <p className="text-text">
        Title change: {from !== null ? `“${from}” → ` : ''}“{to}”
      </p>
      <p className="text-muted">Body unchanged.</p>
    </div>
  );
}

function CollapsibleBody({ markdown }: { markdown: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-tap self-start text-[13.5px] font-semibold text-accent-text"
      >
        {open ? 'Hide draft' : 'Show draft'}
      </button>
      {open && <ProposedBody markdown={markdown} />}
    </div>
  );
}

function CardActions({
  applyLabel,
  rejectLabel,
  applyDisabled,
  rejectDisabled,
  onApply,
  onReject,
}: {
  applyLabel: string;
  rejectLabel: string;
  applyDisabled: boolean;
  rejectDisabled: boolean;
  onApply: () => void;
  onReject: () => void;
}) {
  return (
    <div className="flex gap-2 pt-1">
      <Button kind="secondary" onClick={onReject} disabled={rejectDisabled} className="flex-1">
        {rejectLabel}
      </Button>
      <Button onClick={onApply} disabled={applyDisabled} className="flex-1">
        {applyLabel}
      </Button>
    </div>
  );
}

/**
 * Settled proposals render exactly what the server persisted — a failed
 * Apply must never look like success. Soft failures (the outcomes an
 * honest retry-with-the-assistant fixes) use the warn tone without a
 * "Failed:" prefix, matching desktop's StatusRow; everything else —
 * including `errorCode: null`, the permission-denial/generic bucket —
 * is the hard danger row.
 */
const SOFT_ERROR_CODES: ReadonlySet<string> = new Set([
  'truncated',
  'empty',
  'stale',
  'no_base',
  'patch_missing',
  'patch_ambiguous',
]);

function SettledCard({ view }: { view: ProposalView }) {
  const call = view.call;
  if (call.status === 'applied') {
    const isCreate =
      view.treatAsCreate || (call.result ?? '').startsWith('Created article');
    return (
      <CardShell headline={view.headline} title={view.title}>
        <p className="flex items-center gap-1.5 text-[13.5px] text-text-2">
          <Icon name="check_circle" size={18} className="shrink-0 text-ok" />
          <span className="min-w-0 flex-1">{call.result ?? 'Applied.'}</span>
        </p>
        {isCreate && view.markdown && (
          <CollapsibleBody
            markdown={splitMarkdownTitleAndBody(view.markdown).body}
          />
        )}
      </CardShell>
    );
  }
  if (call.status === 'rejected') {
    return (
      <CardShell headline={view.headline} title={view.title}>
        <p className="text-[13.5px] text-muted">Rejected.</p>
      </CardShell>
    );
  }
  // failed (and, defensively, executed — which proposals never are).
  const soft = call.errorCode !== null && call.errorCode !== undefined
    ? SOFT_ERROR_CODES.has(call.errorCode)
    : false;
  const text = call.error ?? 'The change could not be applied.';
  return (
    <CardShell headline={view.headline} title={view.title}>
      {soft ? (
        <p className="text-[13.5px] text-warn">{text}</p>
      ) : (
        <p className="flex items-center gap-1.5 text-[13.5px] text-danger" role="alert">
          <Icon name="error" size={18} className="shrink-0" />
          <span className="min-w-0 flex-1">Failed: {text}</span>
        </p>
      )}
    </CardShell>
  );
}
