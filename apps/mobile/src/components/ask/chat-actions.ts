import type { ChatConversationDetail, ChatToolCallDto } from '@weavestream/shared';
import { ApiError, apiFetch } from '../../lib/api';

/**
 * REST wrappers for the chat tool-call actions (Phase 5b) — the SAME
 * authorized apply/reject endpoints desktop uses; mobile adds no
 * mutation surface. `apiFetch` supplies CSRF, the step-up retry, and
 * problem+json parsing; callers catch `ApiError` and route on status /
 * problem code (`isCreateRecoveryPendingProblem`), never message text.
 */

export interface ToolCallActionResponse {
  toolCall: ChatToolCallDto;
  updatedToolCalls: ChatToolCallDto[];
}

export interface CreateOverrides {
  title: string;
  folderId: string | null;
  visibleToClients: boolean;
}

function actionPath(
  conversationId: string,
  messageId: string,
  toolCallId: string,
  action: 'apply' | 'reject',
): string {
  return (
    `/chat/conversations/${conversationId}/messages/${messageId}` +
    `/tool-calls/${encodeURIComponent(toolCallId)}/${action}`
  );
}

/**
 * Apply a pending proposal. `companyId` is sent ONLY from the create
 * confirmation sheet — for patch/update the persisted turn context is
 * authoritative, and sending the current org for a global-turn proposal
 * targeting another org would trip the server's tenancy cross-check
 * into a spurious 403.
 */
export function applyChatToolCall(
  args: {
    conversationId: string;
    messageId: string;
    toolCallId: string;
    companyId?: string;
    createOverrides?: CreateOverrides;
  },
  signal?: AbortSignal,
): Promise<ToolCallActionResponse> {
  const body: Record<string, unknown> = {};
  if (args.companyId) body.companyId = args.companyId;
  if (args.createOverrides) body.createOverrides = args.createOverrides;
  return apiFetch<ToolCallActionResponse>(
    actionPath(args.conversationId, args.messageId, args.toolCallId, 'apply'),
    { method: 'POST', body: JSON.stringify(body), signal },
  );
}

export function rejectChatToolCall(
  args: { conversationId: string; messageId: string; toolCallId: string },
  signal?: AbortSignal,
): Promise<ToolCallActionResponse> {
  return apiFetch<ToolCallActionResponse>(
    actionPath(args.conversationId, args.messageId, args.toolCallId, 'reject'),
    { method: 'POST', signal },
  );
}

/**
 * Re-read the actor's own conversation — the resync path for the
 * already-settled 400 race (another device acted) and for post-meta
 * transport recovery (the turn persisted but the stream died before
 * its frames arrived).
 */
export function fetchConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<ChatConversationDetail> {
  return apiFetch<ChatConversationDetail>(`/chat/conversations/${conversationId}`, {
    signal,
  });
}

/**
 * Human-readable message off an RFC-7807 problem, mirroring desktop's
 * `extractProblemMessage` precedence (detail → message → title).
 */
export function problemMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.problem && typeof err.problem === 'object') {
    const p = err.problem as { detail?: unknown; message?: unknown; title?: unknown };
    for (const key of ['detail', 'message', 'title'] as const) {
      const v = p[key];
      if (typeof v === 'string' && v.trim()) return v;
    }
  }
  return fallback;
}
