'use client';

import { useRouter } from 'next/navigation';
import { useState, type CSSProperties } from 'react';
import type { ChatToolCallDto } from '@weavestream/shared';
import { Icon } from '../ui';
import {
  useChatPanel,
  type ChatPageContextSnapshot,
  type ChatTab,
} from './chat-panel-provider';

/**
 * Apply / Reject card rendered inline inside an assistant message
 * bubble whenever the model proposed an article-editing action.
 *
 * Pending state shows a header, optional one-line summary, a
 * collapsible diff (for update_article) or preview (for
 * create_article), and the Apply / Reject buttons.
 *
 * Once acted on, the card collapses to a single-line status row
 * ("Applied" / "Rejected" / "Failed") so the conversation stays
 * legible after the user scrolled past it.
 */
export function ToolCallCard({
  tab,
  messageId,
  toolCall,
}: {
  tab: ChatTab;
  messageId: string;
  toolCall: ChatToolCallDto;
}) {
  const { state, applyToolCall, rejectToolCall, getPageDirty } = useChatPanel();
  const router = useRouter();
  const [busy, setBusy] = useState<'apply' | 'reject' | null>(null);
  const [showDiff, setShowDiff] = useState(true);
  const pageContext = state.pageContext;

  const isUpdate = toolCall.name === 'update_article';
  const args = toolCall.arguments as {
    article_id?: string;
    title?: string;
    markdown?: string;
    folder_id?: string;
    visible_to_clients?: boolean;
    summary?: string;
  };
  const proposedMarkdown =
    typeof args.markdown === 'string' ? args.markdown : '';
  const targetArticleId =
    isUpdate && typeof args.article_id === 'string' ? args.article_id : null;
  const targetIsCurrentPage =
    !!targetArticleId &&
    pageContext?.kind === 'article' &&
    pageContext.articleId === targetArticleId;
  // The "current" body comes from the page context if the LLM is
  // updating the article currently being viewed/edited. Otherwise we
  // don't have it client-side (we'd have to re-fetch); for v1 we just
  // show the proposed body as a preview without a side-by-side diff.
  const currentMarkdown =
    targetIsCurrentPage && pageContext
      ? safeGetMarkdown(pageContext.getMarkdown)
      : null;

  const header = isUpdate
    ? `Proposed: update "${resolvedArticleTitle(tab, pageContext, targetArticleId)}"`
    : `Proposed: create "${args.title ?? 'new article'}"`;

  async function onApply() {
    if (busy) return;
    // Unsaved-changes guard: if the user is in the middle of editing
    // the same article the AI wants to overwrite, make them
    // acknowledge the swap before we clobber the form's body.
    if (targetIsCurrentPage && getPageDirty()) {
      const ok =
        typeof window === 'undefined'
          ? true
          : window.confirm(
              'You have unsaved edits in the article editor. Applying the AI suggestion will overwrite them with the proposed markdown. Continue?',
            );
      if (!ok) return;
    }
    setBusy('apply');
    pageContext?.onBeforeAiApply?.();
    await applyToolCall(tab.id, messageId, toolCall.id);
    setBusy(null);
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
      pageContext?.onAfterAiApply?.({
        ...(typeof args.markdown === 'string' ? { markdown: args.markdown } : {}),
        ...(typeof args.title === 'string' ? { title: args.title } : {}),
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
    return <StatusRow toolCall={toolCall} />;
  }

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
          {isUpdate && currentMarkdown !== null ? (
            <DiffBlock
              before={currentMarkdown}
              after={proposedMarkdown}
            />
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
          disabled={!!busy}
          style={btnStyle(true, busy === 'apply')}
        >
          {busy === 'apply' ? 'Applying…' : 'Apply'}
        </button>
      </div>
    </div>
  );
}

function StatusRow({ toolCall }: { toolCall: ChatToolCallDto }) {
  const tone =
    toolCall.status === 'applied'
      ? 'ok'
      : toolCall.status === 'failed'
        ? 'danger'
        : 'muted';
  const label =
    toolCall.status === 'applied'
      ? toolCall.result ?? 'Applied.'
      : toolCall.status === 'rejected'
        ? 'Rejected.'
        : toolCall.status === 'failed'
          ? `Failed: ${toolCall.error ?? 'unknown error'}`
          : 'Pending.';
  const color =
    tone === 'ok'
      ? 'var(--ok, #2ea043)'
      : tone === 'danger'
        ? 'var(--danger, #c0392b)'
        : 'var(--muted)';
  const IconCmp =
    tone === 'ok' ? Icon.check : tone === 'danger' ? Icon.x : Icon.chat;
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
  const ops = computeLineDiff(a, b);
  return (
    <pre
      style={{
        margin: 0,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
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

type DiffOp =
  | { kind: 'same'; text: string }
  | { kind: 'add'; text: string }
  | { kind: 'del'; text: string };

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

function computeLineDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // LCS table: (n+1) x (m+1). For very large inputs this is O(n*m);
  // article bodies in this product cap at ~2 k lines so it's fine.
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i]![j] = (dp[i + 1]![j + 1] ?? 0) + 1;
      else dp[i]![j] = Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      ops.push({ kind: 'del', text: a[i]! });
      i++;
    } else {
      ops.push({ kind: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ kind: 'del', text: a[i++]! });
  while (j < m) ops.push({ kind: 'add', text: b[j++]! });
  return ops;
}

function PreviewBlock({ markdown }: { markdown: string }) {
  return (
    <pre
      style={{
        margin: 0,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
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
  if (
    pageContext?.kind === 'article' &&
    pageContext.articleId === articleId
  ) {
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
