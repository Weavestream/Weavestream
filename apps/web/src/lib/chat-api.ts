'use client';

import type {
  ChatConversationDetail,
  ChatConversationSummary,
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
