import { z } from 'zod';
import { aiToolNameSchema } from './ai-tools.js';

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
 *   pending  → emitted by the LLM, awaiting user decision (proposal tools)
 *   applied  → user clicked Apply, the action ran successfully
 *   rejected → user dismissed without applying
 *   failed   → user clicked Apply but the action threw server-side, OR
 *              a read tool could not run (see `errorCode`)
 *   executed → a read tool ran server-side during the streaming loop;
 *              `result` holds a one-line summary, never the full output
 */
export const chatToolCallStatusSchema = z.enum([
  'pending',
  'applied',
  'rejected',
  'failed',
  'executed',
]);
export type ChatToolCallStatus = z.infer<typeof chatToolCallStatusSchema>;

/** Every tool the chat can persist — read and proposal alike. */
export const chatToolCallNameSchema = aiToolNameSchema;
export type ChatToolCallName = z.infer<typeof chatToolCallNameSchema>;

/**
 * Machine-readable reason a tool call could not be produced, kept
 * SEPARATE from `status` (which stays the 4-value lifecycle enum) and
 * from `error` (human display text). Set at stream-finalize time:
 *   truncated → the completion hit the model's length cap mid-JSON, so
 *               the streamed `arguments` blob was cut off
 *   malformed → the arguments blob parsed as invalid JSON for another
 *               reason (not length)
 *   empty     → the model emitted a tool call with no arguments
 * The UI switches its tone/icon on this instead of string-matching the
 * display text; tests assert on it directly.
 *
 * Read-loop / revision-guard additions:
 *   unavailable → a read tool was denied OR the target was not found.
 *                 Deliberately ONE code for both so the persisted DTO
 *                 cannot enumerate what exists; the audit log records
 *                 the true outcome.
 *   budget      → per-turn read cap or the Redis cross-turn tool budget
 *                 was exhausted before this call could run
 *   stale       → Apply was refused because the article was edited
 *                 after the proposal's base revision was captured
 *   no_base     → an article edit proposal had no server-captured base
 *                 revision (the model never read/attached the article
 *                 this turn), so it was blocked at persist time
 *   patch_missing → patch old_text did not occur in the base article
 *   patch_ambiguous → patch old_text occurred more than once
 */
export const chatToolCallErrorCodeSchema = z.enum([
  'truncated',
  'malformed',
  'empty',
  'unavailable',
  'budget',
  'stale',
  'no_base',
  'patch_missing',
  'patch_ambiguous',
]);
export type ChatToolCallErrorCode = z.infer<typeof chatToolCallErrorCodeSchema>;

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
  /** Machine-readable failure reason (see `chatToolCallErrorCodeSchema`).
   *  Independent of `status`/`error`; only set when a call could not be
   *  produced cleanly. */
  errorCode: chatToolCallErrorCodeSchema.nullable().optional(),
  /**
   * Optimistic-concurrency basis for article edit proposals,
   * captured server-side from the content the model actually saw
   * (attached snapshot with a matching revision claim, or a
   * `get_article` read) — never looked up at persist time.
   *
   *   number  → server-captured basis; Apply is guarded on it in the
   *             WHERE clause of the article update
   *   null    → the article did not resolve in the actor's scope at
   *             persist time; only the Save-as-article create
   *             promotion may apply this call (it can never update)
   *   absent  → legacy row persisted before revision guarding shipped
   *             (applies unguarded; new rows always set number|null)
   */
  baseRevision: z.number().int().positive().nullable().optional(),
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
 * Snapshot of the request scope that produced a turn, persisted on the
 * assistant message (column `chat_messages.turn_context`) so apply and
 * follow-up behaviour are bound to the turn that proposed the action
 * rather than re-sampled from whatever page is open later.
 *
 * METADATA ONLY — ids/titles, never full markdown bodies (size/privacy).
 * This is descriptive context, NOT an authorization source: apply still
 * derives the writable company from the article row for article edits
 * and re-checks `article.write`. `companyId` here only ever acts as a
 * reject-only cross-check (update) or the create scope (still gated by
 * `article.write`).
 */
export const chatTurnContextSchema = z.object({
  companyId: z.string().uuid().optional(),
  currentArticleId: z.string().uuid().optional(),
  currentTicketId: z.string().min(1).max(200).optional(),
  /** Ids of articles attached as read-only context on the turn. */
  articleIds: z.array(z.string().uuid()).max(10).optional(),
});
export type ChatTurnContext = z.infer<typeof chatTurnContextSchema>;

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
  /**
   * The saved article revision this snapshot was based on (unsaved
   * client edits do not bump it, so a dirty editor still claims the
   * revision it started from). The server captures an update-proposal
   * basis from this snapshot ONLY when this claim matches the current
   * row — a claim/DB mismatch means someone saved a newer revision
   * after the client fetched, so the snapshot's basis is stale and no
   * base is captured. Safe to accept from the client: it is a
   * concurrency token, not authorization — misstating it can only make
   * Apply fail stale or get blocked, never widen write access.
   * Optional for older clients (absent = basis unconfirmable).
   */
  revision: z.number().int().positive().optional(),
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
 * Per-ticket markdown snapshot the client attaches to a turn.
 *
 * Tickets are NEVER persisted in Weavestream — the markdown blob the
 * client sends is whatever the upstream system returned at fetch time,
 * already normalised by the provider driver. The server treats this
 * as opaque read-only grounding for the LLM and never proposes a tool
 * call against it (no `update_ticket` / `create_ticket`). The 120 KB
 * envelope is generous because ticket activity timelines can be long;
 * the API request limiter is the outer backstop.
 *
 * `id` is the provider-side ticket id (not a Weavestream UUID — this
 * field is intentionally NOT typed as `z.string().uuid()`).
 */
export const chatContextTicketSchema = z.object({
  id: z.string().min(1).max(200),
  provider: z.string().min(1).max(64),
  subject: z.string().max(500),
  markdown: z.string().max(120_000),
});
export type ChatContextTicket = z.infer<typeof chatContextTicketSchema>;

/**
 * Request-scoped grounding for a single chat turn. All fields are
 * optional — a freeform tab with no @-mentions and no page context
 * sends nothing. The server uses this to (1) build a system prompt
 * inlining the attached articles + assets + domains and (2) scope
 * agentic article proposal tool calls to the
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
  /**
   * The ticket the user is currently viewing, when applicable. Same
   * role as `currentAssetId` — used by the system prompt to resolve
   * "this ticket". Provider-side id (not a UUID).
   */
  currentTicketId: z.string().min(1).max(200).optional(),
  articles: z.array(chatContextArticleSchema).max(10).optional(),
  assets: z.array(chatContextAssetSchema).max(10).optional(),
  domains: z.array(chatContextDomainSchema).max(10).optional(),
  /**
   * Read-only ticket context — auto-attached when the user is on a
   * ticket detail page. The server inlines the markdown into the
   * system prompt; there is no `update_ticket` / `create_ticket`
   * tool, so this is grounding only.
   */
  tickets: z.array(chatContextTicketSchema).max(5).optional(),
});
export type ChatRequestContext = z.infer<typeof chatRequestContextSchema>;

/**
 * `POST /chat/conversations/:id/messages` body. The server caps content
 * at 8 KB — well above any reasonable single chat turn, but tight
 * enough that a runaway client can't shovel novel-length prompts into
 * the DB or the LLM.
 */
/**
 * Optional, opt-in routing hint sent by an explicit UI affordance
 * ("draft this edit" / "draft an article from this"). Advisory only —
 * the server uses it to pick `tool_choice`/which tool to offer, and it
 * NEVER affects authorization (apply re-checks tenant + article.write
 * regardless). Omitted on ordinary sends, which default to `auto`.
 */
export const chatTurnIntentSchema = z.enum(['question', 'edit', 'create']);
export type ChatTurnIntent = z.infer<typeof chatTurnIntentSchema>;

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
  intent: chatTurnIntentSchema.optional(),
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
