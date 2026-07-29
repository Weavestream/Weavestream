'use client';

import type {
  ChatConversationDetail,
  ChatConversationSummary,
  ChatToolCallDto,
} from '@weavestream/shared';
import { apiFetch } from './api';

/**
 * Thin REST helpers for the per-user chat history endpoints. The
 * streaming send-message path lives in `chat-stream.ts` because it
 * reads `response.body` directly rather than going through
 * `apiFetch`'s JSON parser.
 */

export async function listChatConversations(): Promise<ChatConversationSummary[]> {
  const res = await apiFetch<{ items: ChatConversationSummary[] }>(
    '/chat/conversations',
  );
  if (!res.ok || !res.data) return [];
  return res.data.items;
}

export async function getChatConversation(
  id: string,
): Promise<ChatConversationDetail | null> {
  const res = await apiFetch<ChatConversationDetail>(`/chat/conversations/${id}`);
  if (!res.ok || !res.data) return null;
  return res.data;
}

export async function createChatConversation(): Promise<ChatConversationDetail | null> {
  const res = await apiFetch<ChatConversationDetail>('/chat/conversations', {
    method: 'POST',
  });
  if (!res.ok || !res.data) return null;
  return res.data;
}

export async function deleteChatConversation(id: string): Promise<boolean> {
  const res = await apiFetch<unknown>(`/chat/conversations/${id}`, {
    method: 'DELETE',
  });
  return res.ok;
}

export type ToolCallActionResponse = {
  toolCall: ChatToolCallDto;
  updatedToolCalls: ChatToolCallDto[];
};

export type ApplyChatToolCallResult =
  | { ok: true; data: ToolCallActionResponse }
  | {
      ok: false;
      error: string;
      /** Stable RFC-7807 `code` when the server sent one — clients
       *  branch on codes (e.g. create-recovery), never message text. */
      code?: string;
    };

/**
 * Apply a pending tool call. The server re-validates the LLM-supplied
 * arguments, re-checks `article.write` for the article's actual
 * company, then mutates via the articles service.
 *
 * For `create_article` proposals, the Save-as-article confirmation
 * dialog passes `createOverrides` carrying the user-picked target
 * company / folder / title / visibility so the server doesn't fall
 * back to the LLM's (sometimes hallucinated) `folder_id`.
 */
export async function applyChatToolCall(args: {
  conversationId: string;
  messageId: string;
  toolCallId: string;
  companyId?: string;
  createOverrides?: {
    title: string;
    folderId: string | null;
    visibleToClients: boolean;
  };
}): Promise<ApplyChatToolCallResult> {
  const body: Record<string, unknown> = {};
  if (args.companyId) body.companyId = args.companyId;
  if (args.createOverrides) body.createOverrides = args.createOverrides;
  const res = await apiFetch<ToolCallActionResponse>(
    `/chat/conversations/${args.conversationId}/messages/${args.messageId}/tool-calls/${encodeURIComponent(
      args.toolCallId,
    )}/apply`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
  if (!res.ok || !res.data) {
    return {
      ok: false,
      error: extractProblemMessage(res.problem),
      ...(extractProblemCode(res.problem) ? { code: extractProblemCode(res.problem) } : {}),
    };
  }
  return { ok: true, data: res.data };
}

function extractProblemCode(problem: unknown): string | undefined {
  if (!problem || typeof problem !== 'object') return undefined;
  const code = (problem as { code?: unknown }).code;
  return typeof code === 'string' && code ? code : undefined;
}

function extractProblemMessage(problem: unknown): string {
  if (!problem || typeof problem !== 'object') return 'Apply failed.';
  const p = problem as { detail?: unknown; title?: unknown; message?: unknown };
  for (const key of ['detail', 'message', 'title'] as const) {
    const v = p[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return 'Apply failed.';
}

export async function rejectChatToolCall(args: {
  conversationId: string;
  messageId: string;
  toolCallId: string;
}): Promise<ToolCallActionResponse | null> {
  const res = await apiFetch<ToolCallActionResponse>(
    `/chat/conversations/${args.conversationId}/messages/${args.messageId}/tool-calls/${encodeURIComponent(
      args.toolCallId,
    )}/reject`,
    { method: 'POST' },
  );
  if (!res.ok || !res.data) return null;
  return res.data;
}
