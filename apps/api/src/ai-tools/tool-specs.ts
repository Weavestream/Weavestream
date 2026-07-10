import { z } from 'zod';
import {
  AI_TOOL_MODES,
  createArticleToolInputSchema,
  findRelatedItemsToolInputSchema,
  findRelatedItemsToolOutputSchema,
  getArticleToolInputSchema,
  getArticleToolOutputSchema,
  getCompanySummaryToolInputSchema,
  getCompanySummaryToolOutputSchema,
  getRelatedItemsToolInputSchema,
  getRelatedItemsToolOutputSchema,
  searchToolInputSchema,
  searchToolOutputSchema,
  updateArticleToolInputSchema,
} from '@weavestream/shared';
import type {
  AiToolMode,
  AiToolName,
  GetArticleToolOutput,
  GetCompanySummaryToolOutput,
  GetRelatedItemsToolOutput,
  FindRelatedItemsToolOutput,
  SearchToolOutput,
} from '@weavestream/shared';
import type { Action } from '../rbac/permissions.js';

/**
 * API-side binding of the shared tool schemas to their execution
 * metadata: the LLM-facing description, the mode, the entry-gate
 * permission, and the one-line summary persisted on executed calls.
 *
 * Pure data — no Nest imports — so `chat-tools.ts` can derive the
 * OpenAI catalog from it at module load and `chat-turn.ts` stays
 * unit-testable without DI.
 *
 * Schema fields are deliberately type-erased (`z.ZodTypeAny`): every
 * consumer validates at runtime (`inputSchema.parse` before execution
 * or apply, `outputSchema.parse` before results reach the model), so
 * carrying the concrete generics here buys nothing and fights
 * variance when the specs are collected into one record.
 */
export interface AiToolSpec {
  name: AiToolName;
  /** LLM-facing tool description (shown in the tool catalog). */
  description: string;
  mode: AiToolMode;
  /**
   * Entry-gate permission the executor checks against the resolved
   * company before `execute()` runs. `null` = authenticated-only with
   * query-layer self-scoping — `scopeNote` must justify it. Tools with
   * heterogeneous outputs enforce additional per-kind checks inside
   * their implementation; proposal tools re-check at apply time.
   */
  permission: Action | null;
  /** Why the permission model above is sufficient. Documentation only. */
  scopeNote: string;
  /** Always a Zod object schema — enforced by the catalog converter. */
  inputSchema: z.ZodTypeAny;
  /** Read tools validate outputs defensively; proposal tools have none. */
  outputSchema: z.ZodTypeAny | null;
  /**
   * One-line persisted `result` for executed read calls — shown as a
   * status chip in the UI and stored in the tool-call JSONB. Receives
   * the schema-validated args/output (erased); never include document
   * content. Full outputs are never persisted.
   */
  summarize:
    | ((args: Record<string, unknown>, output: unknown) => string)
    | null;
}

export const AI_TOOL_SPECS: Record<AiToolName, AiToolSpec> = {
  update_article: {
    name: 'update_article',
    description: [
      'Propose an update to an existing article. The change is NOT',
      'applied immediately — the user sees a diff and clicks Apply',
      'or Reject in the chat UI. Provide the full new markdown body',
      '(do not send a partial diff). The article will be saved in',
      'Markdown editor mode regardless of its current mode.',
    ].join(' '),
    mode: AI_TOOL_MODES.update_article,
    permission: 'article.write',
    scopeNote:
      'Never executes during streaming. Apply derives the writable company from ' +
      'the article row and re-checks article.write; the base revision is guarded ' +
      'in the WHERE clause of the update.',
    inputSchema: updateArticleToolInputSchema,
    outputSchema: null,
    summarize: null,
  },
  create_article: {
    name: 'create_article',
    description: [
      'Propose creating a new article. The article is NOT created',
      'immediately — the user reviews the proposed title and body',
      'and clicks Apply or Reject in the chat UI. New articles are',
      'created in Markdown editor mode.',
    ].join(' '),
    mode: AI_TOOL_MODES.create_article,
    permission: 'article.write',
    scopeNote:
      'Never executes during streaming. Apply scopes the create to the turn ' +
      'company and re-checks article.write; Save-as-article overrides win over ' +
      'LLM-supplied folder/title/visibility.',
    inputSchema: createArticleToolInputSchema,
    outputSchema: null,
    summarize: null,
  },
  search: {
    name: 'search',
    description: [
      'Search the knowledge base (assets, articles, password entries,',
      'domains, uploads) the current user can access. Results are already',
      'filtered to the user’s permissions and include an href — cite it',
      'inline as a markdown link whenever your answer uses a result.',
    ].join(' '),
    mode: AI_TOOL_MODES.search,
    permission: null,
    scopeNote:
      'Mirrors the @AuthedOnly() SearchController: SearchService derives scope ' +
      'from requireTenantContext() at the query layer (allowedCompanyIds, ' +
      'client visibility, restricted-password filtering).',
    inputSchema: searchToolInputSchema,
    outputSchema: searchToolOutputSchema,
    summarize: (args, output) => {
      const o = output as SearchToolOutput;
      const query = typeof args['query'] === 'string' ? args['query'] : '';
      return `${o.results.length} result${o.results.length === 1 ? '' : 's'} for "${query}"`;
    },
  },
  find_related_items: {
    name: 'find_related_items',
    description: [
      'Find the linked items for an explicitly named asset, article, or',
      'password entry. This resolves the exact name and traverses its',
      'relationships server-side; use it for questions such as “what is',
      'related to ACM-DB01?”. Search hits alone are NOT relationships.',
    ].join(' '),
    mode: AI_TOOL_MODES.find_related_items,
    permission: null,
    scopeNote:
      'Resolves through SearchService under the actor tenant scope, requires an exact ',
      'eligible entity-name match, then reuses the relation tool’s source-row and ',
      'counterpart permission checks before returning links.',
    inputSchema: findRelatedItemsToolInputSchema,
    outputSchema: findRelatedItemsToolOutputSchema,
    summarize: (_args, output) => {
      const o = output as FindRelatedItemsToolOutput;
      return `${o.totalCount} related item${o.totalCount === 1 ? '' : 's'} for "${o.sourceTitle}"`;
    },
  },
  get_article: {
    name: 'get_article',
    description: [
      'Read an article’s body as markdown. Long articles return one chunk',
      'plus a continuation cursor — call again with the cursor to keep',
      'reading the SAME article. Always read an article with this tool',
      'before proposing an update to it, unless its content is already',
      'attached to this conversation. Cite the returned href when you use',
      'the content.',
    ].join(' '),
    mode: AI_TOOL_MODES.get_article,
    permission: 'article.read',
    scopeNote:
      'Company resolved scope-safely from the article row, then article.read is ' +
      'checked; ArticlesService.getById additionally enforces CLIENT_USER ' +
      'visibility at the query layer.',
    inputSchema: getArticleToolInputSchema,
    outputSchema: getArticleToolOutputSchema,
    summarize: (_args, output) => {
      const o = output as GetArticleToolOutput;
      return `Read "${o.title}" (revision ${o.revision})${o.truncated ? ' — truncated' : ''}`;
    },
  },
  get_related_items: {
    name: 'get_related_items',
    description: [
      'List items (assets, articles, password entries) linked to the given',
      'entity. entity_name must be the exact displayed name of that entity;',
      'the server verifies it matches entity_id. Only returns items the',
      'current user can access. Cite the returned hrefs when you use them.',
    ].join(' '),
    mode: AI_TOOL_MODES.get_related_items,
    permission: 'relation.read',
    scopeNote:
      'Company resolved scope-safely from the source row; the source kind’s ' +
      'own read permission plus a full source-row read (archived / visibility / ' +
      'password restriction) are enforced before traversal, and every returned ' +
      'kind is gated independently.',
    inputSchema: getRelatedItemsToolInputSchema,
    outputSchema: getRelatedItemsToolOutputSchema,
    summarize: (_args, output) => {
      const o = output as GetRelatedItemsToolOutput;
      return `${o.totalCount} related item${o.totalCount === 1 ? '' : 's'}`;
    },
  },
  get_company_summary: {
    name: 'get_company_summary',
    description: [
      'Summarize the company this chat is scoped to: counts of the assets,',
      'articles, domains, password entries and uploads the current user may',
      'see. Takes no arguments — the company is always the one the chat was',
      'opened on. Unavailable in chats not opened from a company page.',
    ].join(' '),
    mode: AI_TOOL_MODES.get_company_summary,
    permission: 'company.read',
    scopeNote:
      'Company comes exclusively from the trusted turn context (never the ' +
      'model). Each count section is additionally gated by its own read ' +
      'permission and omitted — not zeroed — when unauthorized.',
    inputSchema: getCompanySummaryToolInputSchema,
    outputSchema: getCompanySummaryToolOutputSchema,
    summarize: (_args, output) => {
      const o = output as GetCompanySummaryToolOutput;
      return `Summarized company "${o.companyName}"`;
    },
  },
};
