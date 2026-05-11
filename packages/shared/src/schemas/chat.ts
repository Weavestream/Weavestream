import { z } from 'zod';

/**
 * Per-user AI chat history. A conversation == one chat tab in the UI;
 * messages within belong to that conversation only. Roles map 1:1 to
 * the OpenAI Chat Completions API (`system` is never exposed to the
 * client — it's injected server-side as needed).
 */
export const chatRoleSchema = z.enum(['user', 'assistant']);
export type ChatRole = z.infer<typeof chatRoleSchema>;

export const chatMessageSchema = z.object({
  id: z.string().uuid(),
  role: chatRoleSchema,
  content: z.string(),
  createdAt: z.string(),
});
export type ChatMessageDto = z.infer<typeof chatMessageSchema>;

/**
 * Lightweight list-row shape: no messages, no model. Used by the
 * history popover and the `GET /chat/conversations` listing.
 */
export const chatConversationSummarySchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  updatedAt: z.string(),
  createdAt: z.string(),
});
export type ChatConversationSummary = z.infer<
  typeof chatConversationSummarySchema
>;

export const chatConversationDetailSchema = chatConversationSummarySchema.extend({
  model: z.string().nullable(),
  messages: z.array(chatMessageSchema),
});
export type ChatConversationDetail = z.infer<
  typeof chatConversationDetailSchema
>;

/**
 * `POST /chat/conversations/:id/messages` body. The server caps content
 * at 8 KB — well above any reasonable single chat turn, but tight
 * enough that a runaway client can't shovel novel-length prompts into
 * the DB or the LLM.
 */
export const sendChatMessageSchema = z.object({
  content: z
    .string()
    .transform((v) => v.trim())
    .pipe(
      z
        .string()
        .min(1, 'Message cannot be empty')
        .max(8000, 'Message is too long'),
    ),
});
export type SendChatMessageInput = z.infer<typeof sendChatMessageSchema>;
