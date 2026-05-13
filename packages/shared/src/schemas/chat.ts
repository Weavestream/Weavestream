import { z } from 'zod';

/**
 * Per-user AI chat history. A conversation == one chat tab in the UI;
 * messages within belong to that conversation only. Roles map 1:1 to
 * the OpenAI Chat Completions API (`system` is never exposed to the
 * client — it's injected server-side as needed).
 */
export const chatRoleSchema = z.enum(['user', 'assistant']);
export type ChatRole = z.infer<typeof chatRoleSchema>;

/**
 * Tool call status lifecycle:
 *   pending  → emitted by the LLM, awaiting user decision
 *   applied  → user clicked Apply, the action ran successfully
 *   rejected → user dismissed without applying
 *   failed   → user clicked Apply but the action threw server-side
 */
export const chatToolCallStatusSchema = z.enum([
  'pending',
  'applied',
  'rejected',
  'failed',
]);
export type ChatToolCallStatus = z.infer<typeof chatToolCallStatusSchema>;

export const chatToolCallNameSchema = z.enum([
  'update_article',
  'create_article',
]);
export type ChatToolCallName = z.infer<typeof chatToolCallNameSchema>;

/**
 * A proposed agentic action attached to an assistant turn. `arguments`
 * is whatever JSON the LLM produced — schema is enforced at apply time
 * (see `applyToolCall` in apps/api/src/chat/chat-tool-call.service.ts)
 * so we can persist malformed calls and still let the user reject them.
 */
export const chatToolCallSchema = z.object({
  id: z.string(),
  name: chatToolCallNameSchema,
  arguments: z.record(z.unknown()),
  status: chatToolCallStatusSchema,
  result: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});
export type ChatToolCallDto = z.infer<typeof chatToolCallSchema>;

export const chatMessageSchema = z.object({
  id: z.string().uuid(),
  role: chatRoleSchema,
  content: z.string(),
  createdAt: z.string(),
  toolCalls: z.array(chatToolCallSchema).nullable().optional(),
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
 * Per-article markdown snapshot the client attaches to a turn. The
 * server treats this as immutable, read-only context — it never falls
 * back to fetching the article body from the DB based on `id` alone,
 * because the client snapshot may include unsaved edits from the
 * active form. The body cap is generous (60 KB ≈ ~10–15 k tokens for
 * most models); the server-side request limiter still applies on top.
 */
export const chatContextArticleSchema = z.object({
  id: z.string().uuid(),
  title: z.string().max(300),
  markdown: z.string().max(60_000),
});
export type ChatContextArticle = z.infer<typeof chatContextArticleSchema>;

/**
 * Per-asset markdown snapshot the client attaches to a turn. Same
 * size envelope as `chatContextArticleSchema`. Assets are strictly
 * read-only context — the server never proposes asset tool calls,
 * and the chat tool set does not include `update_asset` /
 * `create_asset`. `layoutName` is included so the system prompt can
 * disambiguate "Server" / "Workstation" / etc. without re-querying.
 */
export const chatContextAssetSchema = z.object({
  id: z.string().uuid(),
  name: z.string().max(300),
  layoutName: z.string().max(120),
  markdown: z.string().max(60_000),
});
export type ChatContextAsset = z.infer<typeof chatContextAssetSchema>;

/**
 * Per-domain markdown snapshot the client attaches to a turn. Same
 * size envelope as `chatContextArticleSchema`. Domains are strictly
 * read-only context — the server never proposes domain tool calls,
 * and the chat tool set does not include `update_domain` /
 * `create_domain`. `hostname` is included so the system prompt can
 * disambiguate domains by their canonical DNS name without re-
 * querying.
 */
export const chatContextDomainSchema = z.object({
  id: z.string().uuid(),
  hostname: z.string().max(253),
  markdown: z.string().max(60_000),
});
export type ChatContextDomain = z.infer<typeof chatContextDomainSchema>;

/**
 * Request-scoped grounding for a single chat turn. All fields are
 * optional — a freeform tab with no @-mentions and no page context
 * sends nothing. The server uses this to (1) build a system prompt
 * inlining the attached articles + assets + domains and (2) scope
 * agentic tool calls (`create_article` / `update_article`) to the
 * current company so the LLM cannot accidentally mutate a different
 * tenant. Assets and domains are read-only context and never travel
 * as tool-call targets.
 */
export const chatRequestContextSchema = z.object({
  companyId: z.string().uuid().optional(),
  currentArticleId: z.string().uuid().optional(),
  /**
   * The asset the user is currently viewing, when applicable. Used by
   * the system prompt to resolve deictic references like "this asset"
   * even when other assets are @-mentioned in the same turn.
   */
  currentAssetId: z.string().uuid().optional(),
  /**
   * The domain the user is currently viewing, when applicable. Same
   * role as `currentAssetId` — purely for deictic disambiguation;
   * domains are read-only context and never travel as tool-call
   * targets.
   */
  currentDomainId: z.string().uuid().optional(),
  articles: z.array(chatContextArticleSchema).max(10).optional(),
  assets: z.array(chatContextAssetSchema).max(10).optional(),
  domains: z.array(chatContextDomainSchema).max(10).optional(),
});
export type ChatRequestContext = z.infer<typeof chatRequestContextSchema>;

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
  context: chatRequestContextSchema.optional(),
});
export type SendChatMessageInput = z.infer<typeof sendChatMessageSchema>;

/**
 * `POST /chat/conversations/:convId/messages/:msgId/tool-calls/:id/apply`
 * body. The client may send the company id of the page it's currently
 * viewing as a sanity check; the server still ignores any LLM-supplied
 * `company_id` argument and uses request scope only.
 *
 * `createOverrides` is set by the Save-as-article confirmation dialog
 * when the user clicks Apply on a `create_article` proposal — the LLM
 * sometimes hallucinates a `folder_id` that doesn't belong to the
 * request company, so the user picks the target explicitly in the UI
 * and the server uses those values instead of `args.folder_id` /
 * `args.title` / `args.visible_to_clients`. `companyId` still scopes
 * the create (and is matched against the tenancy the actor can write
 * into).
 */
export const applyChatToolCallSchema = z.object({
  companyId: z.string().uuid().optional(),
  createOverrides: z
    .object({
      title: z.string().min(1).max(200),
      folderId: z.string().uuid().nullable(),
      visibleToClients: z.boolean(),
    })
    .optional(),
});
export type ApplyChatToolCallInput = z.infer<typeof applyChatToolCallSchema>;
