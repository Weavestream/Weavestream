import { z } from 'zod';
import {
  AI_TOOL_MODES,
  createArticleToolInputSchema,
  findRelatedItemsToolInputSchema,
  findRelatedItemsToolOutputSchema,
  getArticleToolInputSchema,
  getArticleToolOutputSchema,
  getAppHelpToolInputSchema,
  getAppHelpToolOutputSchema,
  getCompanySummaryToolInputSchema,
  getCompanySummaryToolOutputSchema,
  getRelatedItemsToolInputSchema,
  getRelatedItemsToolOutputSchema,
  patchArticleToolInputSchema,
  searchToolInputSchema,
  searchToolOutputSchema,
  updateArticleToolInputSchema,
} from '@weavestream/shared';
import type {
  AiToolMode,
  AiToolName,
  GetArticleToolOutput,
  GetAppHelpToolOutput,
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
  /**
   * Optional replacement for the generic unavailable message on failed
   * executions. MUST be one static string covering not-found AND denied
   * alike — it may steer the model's fallback behavior, but must never
   * let it (or the persisted DTO) distinguish absence from denial.
   */
  unavailableMessage?: string;
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
  summarize: ((args: Record<string, unknown>, output: unknown) => string) | null;
}

export const AI_TOOL_SPECS: Record<AiToolName, AiToolSpec> = {
  patch_article: {
    name: 'patch_article',
    description: [
      'Propose focused edits to an existing article using exact text',
      'replacements. The edits are NOT applied immediately — the user',
      'reviews a diff and clicks Apply or Reject. Use this for additions,',
      'corrections, and localized changes. Copy old_text verbatim from',
      'the article and include enough context that it occurs exactly once.',
      'The article is saved in Markdown editor mode when content changes.',
    ].join(' '),
    mode: AI_TOOL_MODES.patch_article,
    permission: 'article.write',
    scopeNote:
      'Never executes during streaming. Apply derives the writable company from ' +
      'the article row, re-checks article.write, applies exact edits server-side, ' +
      'and guards the base revision in the WHERE clause of the update.',
    inputSchema: patchArticleToolInputSchema,
    outputSchema: null,
    summarize: null,
  },
  update_article: {
    name: 'update_article',
    description: [
      'Propose a complete rewrite of an existing article. Use this only',
      'when the user explicitly wants the whole document rewritten,',
      'reorganized, or replaced. The change is NOT',
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
      'Resolves through SearchService under the actor tenant scope, requires an exact ' +
      'eligible entity-name match, then reuses the relation tool’s source-row and ' +
      'counterpart permission checks before returning links.',
    // Without this steer, the model's natural recovery from a failed
    // lookup is a plain `search` next round, presented as relationships.
    unavailableMessage:
      'No single exact-name match was found, or it is not accessible. Do not ' +
      'present search results as related items — say the relationships could ' +
      'not be verified and ask the user for the exact item name.',
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
      'before proposing an edit or rewrite, unless its content is already',
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
  get_app_help: {
    name: 'get_app_help',
    description: [
      'Retrieve official, version-matched instructions for using the',
      'Weavestream application. Use this for questions about navigating',
      'the UI, creating or managing records, asset layouts, integrations,',
      'organization mappings, field mappings, and syncs. It contains',
      'application usage guidance only: it does not inspect live tenant',
      'configuration and does not cover Docker, deployment, environment',
      'variables, databases, or server administration.',
    ].join(' '),
    mode: AI_TOOL_MODES.get_app_help,
    permission: null,
    scopeNote:
      'Authenticated-only static help. The implementation reads only bundled, ' +
      'application-owned Markdown from a fixed directory, accepts no path or ' +
      'tenant scope from the model, and returns no live tenant data.',
    inputSchema: getAppHelpToolInputSchema,
    outputSchema: getAppHelpToolOutputSchema,
    summarize: (_args, output) => {
      const o = output as GetAppHelpToolOutput;
      return `Retrieved ${o.matches.length} app-help section${o.matches.length === 1 ? '' : 's'}`;
    },
  },
};
