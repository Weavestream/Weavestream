import { z } from 'zod';
import { searchEntityKindSchema } from './search.js';

/**
 * Single source of truth for the AI chat tool surface.
 *
 * Every tool the LLM can call is declared here once: its name, its
 * input schema (validated server-side before execution or apply, and
 * converted into the OpenAI-style strict JSON-Schema definition the
 * model sees), and — for read tools — the output schema the executor
 * validates results against before they are returned to the model.
 *
 * Two modes:
 *   read     — executes server-side during the streaming tool loop,
 *              behind the acting user's own permissions. Results are
 *              DATA for the model, never instructions.
 *   proposal — never executes during streaming; persisted as a pending
 *              Apply/Reject card and re-validated at apply time.
 *
 * The tool input schemas deliberately do NOT accept a company or
 * tenant scope — scope is always derived server-side from the
 * authenticated actor and the trusted turn context.
 */
export const aiToolNames = [
  'update_article',
  'create_article',
  'search',
  'find_related_items',
  'get_article',
  'get_related_items',
  'get_company_summary',
] as const;
export const aiToolNameSchema = z.enum(aiToolNames);
export type AiToolName = z.infer<typeof aiToolNameSchema>;

export type AiToolMode = 'read' | 'proposal';

export const AI_TOOL_MODES: Record<AiToolName, AiToolMode> = {
  update_article: 'proposal',
  create_article: 'proposal',
  search: 'read',
  find_related_items: 'read',
  get_article: 'read',
  get_related_items: 'read',
  get_company_summary: 'read',
};

export const AI_READ_TOOL_NAMES = aiToolNames.filter(
  (n) => AI_TOOL_MODES[n] === 'read',
);
export const AI_PROPOSAL_TOOL_NAMES = aiToolNames.filter(
  (n) => AI_TOOL_MODES[n] === 'proposal',
);

// ----------------------------------------------------------------------
// Input schemas
//
// Convention: fields the LLM may omit use `.optional()`. The JSON-Schema
// converter renders those as `["T","null"]` unions listed in `required`
// (the strict shape vLLM's structural-tag path needs), the model emits
// `null` for fields it isn't setting, and `stripNullArgs` normalises
// `null → undefined` before these schemas re-validate.
// ----------------------------------------------------------------------

/** `update_article` — proposal. Moved verbatim from the apply-time schema. */
export const updateArticleToolInputSchema = z.object({
  article_id: z
    .string()
    .uuid()
    .describe(
      'UUID of the article to update. Must match one of the article ids shown in the system context.',
    ),
  title: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('New title. Use null to keep the existing title.'),
  markdown: z
    .string()
    .min(1)
    .max(100_000)
    .optional()
    .describe(
      'Full replacement markdown body. Required to change content; use null when only changing the title.',
    ),
  summary: z
    .string()
    .max(1000)
    .optional()
    .describe(
      'One-line natural-language summary of the change shown to the user above the diff. null if none.',
    ),
});
export type UpdateArticleToolInput = z.infer<typeof updateArticleToolInputSchema>;

/** `create_article` — proposal. Moved verbatim from the apply-time schema. */
export const createArticleToolInputSchema = z.object({
  title: z.string().min(1).max(200),
  markdown: z
    .string()
    .min(1)
    .max(100_000)
    .describe('Article body as markdown.'),
  folder_id: z
    .string()
    .uuid()
    .optional()
    .describe('UUID of the parent folder. Use null to create the article at the root.'),
  visible_to_clients: z
    .boolean()
    .optional()
    .describe('Defaults to true. Use null for the default.'),
  summary: z
    .string()
    .max(1000)
    .optional()
    .describe('One-line summary shown to the user above the preview. null if none.'),
});
export type CreateArticleToolInput = z.infer<typeof createArticleToolInputSchema>;

/** `search` — read. Scope is derived from the actor, never from args. */
export const searchToolInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(400)
    .describe('Full-text search query. Plain words work best; no special syntax.'),
  types: z
    .array(searchEntityKindSchema)
    .min(1)
    .max(5)
    .optional()
    .describe('Restrict results to these kinds. Use null to search all kinds.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Maximum number of results (default 5, max 10). Use null for the default.'),
});
export type SearchToolInput = z.infer<typeof searchToolInputSchema>;

/**
 * Resolve an explicitly named entity and traverse its links in one
 * server-side operation. Used for questions like “what is related to
 * ACM-DB01?” so the model cannot mistake plain search hits for links.
 */
export const findRelatedItemsToolInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe(
      'Exact displayed name of the asset, article, or password entry whose linked items the user requested.',
    ),
});
export type FindRelatedItemsToolInput = z.infer<
  typeof findRelatedItemsToolInputSchema
>;

/** `get_article` — read. */
export const getArticleToolInputSchema = z.object({
  article_id: z
    .string()
    .uuid()
    .describe('UUID of the article to read.'),
  cursor: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe(
      'Continuation token from a previous truncated read of the SAME article. Use null to read from the start.',
    ),
});
export type GetArticleToolInput = z.infer<typeof getArticleToolInputSchema>;

export const relatedItemsSourceKinds = ['asset', 'article', 'password'] as const;
export const relatedItemsSourceKindSchema = z.enum(relatedItemsSourceKinds);
export type RelatedItemsSourceKind = z.infer<typeof relatedItemsSourceKindSchema>;

/** `get_related_items` — read. */
export const getRelatedItemsToolInputSchema = z.object({
  entity_type: relatedItemsSourceKindSchema.describe(
    'Kind of the entity to look up relations for.',
  ),
  entity_id: z.string().uuid().describe('UUID of the entity.'),
  entity_name: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe(
      'Exact displayed name of the entity the user asked about. Copy it from the current page or a search result. The server verifies this matches entity_id.',
    ),
});
export type GetRelatedItemsToolInput = z.infer<typeof getRelatedItemsToolInputSchema>;

/**
 * `get_company_summary` — read. Intentionally takes NO arguments: the
 * company is always the one the chat was opened on (trusted turn
 * context). The model can never pick a company id.
 */
export const getCompanySummaryToolInputSchema = z.object({});
export type GetCompanySummaryToolInput = z.infer<typeof getCompanySummaryToolInputSchema>;

// ----------------------------------------------------------------------
// Read-tool output schemas
//
// Validated by the executor before results are handed to the model —
// a defensive contract so a service change can't silently start
// leaking extra fields into the LLM conversation.
// ----------------------------------------------------------------------

export const aiSearchResultSchema = z.object({
  kind: searchEntityKindSchema,
  id: z.string().uuid(),
  title: z.string(),
  snippet: z.string(),
  companyName: z.string(),
  href: z.string(),
  updatedAt: z.string(),
});
export type AiSearchResult = z.infer<typeof aiSearchResultSchema>;

export const searchToolOutputSchema = z.object({
  results: z.array(aiSearchResultSchema).max(10),
});
export type SearchToolOutput = z.infer<typeof searchToolOutputSchema>;

export const getArticleToolOutputSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  /** One chunk of the article body as markdown (never more than a chunk). */
  markdown: z.string().max(60_000),
  /** Monotonic revision of the article row this body was read from. */
  revision: z.number().int().positive(),
  href: z.string(),
  visibleToClients: z.boolean(),
  updatedAt: z.string(),
  /** True when the body continues past this chunk. */
  truncated: z.boolean(),
  /** Continuation token for the next chunk; null when `truncated` is false. */
  nextCursor: z.string().nullable(),
});
export type GetArticleToolOutput = z.infer<typeof getArticleToolOutputSchema>;

export const aiRelatedItemSchema = z.object({
  kind: relatedItemsSourceKindSchema,
  id: z.string().uuid(),
  title: z.string(),
  href: z.string(),
  /** 'manual' for user-created links, otherwise the managing field relation. */
  relationType: z.string(),
});
export type AiRelatedItem = z.infer<typeof aiRelatedItemSchema>;

export const getRelatedItemsToolOutputSchema = z.object({
  /** Server-resolved title of the entity traversed; never model-inferred. */
  sourceTitle: z.string(),
  items: z.array(aiRelatedItemSchema),
  totalCount: z.number().int().min(0),
});
export type GetRelatedItemsToolOutput = z.infer<typeof getRelatedItemsToolOutputSchema>;

/** Same relationship result shape for the named-entity resolver tool. */
export const findRelatedItemsToolOutputSchema = getRelatedItemsToolOutputSchema;
export type FindRelatedItemsToolOutput = z.infer<
  typeof findRelatedItemsToolOutputSchema
>;

/**
 * Company summary. Every count section is OPTIONAL and is omitted —
 * never zeroed — when the actor lacks that section's read permission,
 * so the response shape cannot become a presence side channel.
 */
export const getCompanySummaryToolOutputSchema = z.object({
  companyId: z.string().uuid(),
  companyName: z.string(),
  href: z.string(),
  assets: z.number().int().min(0).optional(),
  articles: z.number().int().min(0).optional(),
  domains: z.number().int().min(0).optional(),
  passwords: z.number().int().min(0).optional(),
  uploads: z.number().int().min(0).optional(),
  /** Audit events in the last 30 days; requires `audit.read`. */
  auditEventsLast30d: z.number().int().min(0).optional(),
});
export type GetCompanySummaryToolOutput = z.infer<typeof getCompanySummaryToolOutputSchema>;

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

/**
 * Drop `null`-valued keys from LLM tool arguments before validation.
 * The strict tool schemas (`strict: true`) require every property to be
 * present, so the model emits `null` for fields it isn't setting; the
 * validation schemas use `.optional()` (which accepts `undefined`, not
 * `null`), so an un-stripped `{ summary: null }` would throw a ZodError.
 */
export function stripNullArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== null) out[key] = value;
  }
  return out;
}
