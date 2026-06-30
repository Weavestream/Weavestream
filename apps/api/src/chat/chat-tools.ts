/**
 * OpenAI-style tool catalog exposed to the LLM during a chat turn.
 *
 * Design notes:
 *
 * - Reads are NOT a tool: relevant articles are inlined into the
 *   system prompt by the caller. This iteration is "agentic-write,
 *   inlined-read" — adding a `read_article` tool is a follow-up.
 *
 * - The LLM never picks a `company_id`. Apply-time wiring takes the
 *   company from the request scope (the page the chat was opened on)
 *   so a hallucinated id can never mutate the wrong tenant.
 *
 * - Tool calls do NOT execute when emitted; the chat UI renders an
 *   Apply / Reject card and the user confirms. The `description`
 *   fields make this explicit so the model phrases proposals as
 *   proposals rather than reporting completed work.
 *
 * - Schemas are `strict: true` with EVERY property listed in `required`
 *   and optional fields typed as a `["…","null"]` union. On vLLM this
 *   opts the `tool_choice: 'auto'` path into structural-tag constraints
 *   (without `strict` the args are scraped from raw text and can be
 *   malformed). The model emits `null` for fields it doesn't set; the
 *   apply path normalises `null → undefined` before re-validating
 *   against the looser apply-time Zod schema, which enforces the real
 *   required set (article_id for update; title+markdown for create).
 */
export const ARTICLE_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'update_article',
      strict: true,
      description: [
        'Propose an update to an existing article. The change is NOT',
        'applied immediately — the user sees a diff and clicks Apply',
        'or Reject in the chat UI. Provide the full new markdown body',
        '(do not send a partial diff). The article will be saved in',
        'Markdown editor mode regardless of its current mode.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          article_id: {
            type: 'string',
            description:
              'UUID of the article to update. Must match one of the article ids shown in the system context.',
          },
          title: {
            type: ['string', 'null'],
            description: 'New title. Use null to keep the existing title.',
          },
          markdown: {
            type: ['string', 'null'],
            description:
              'Full replacement markdown body. Required to change content; use null when only changing the title.',
          },
          summary: {
            type: ['string', 'null'],
            description:
              'One-line natural-language summary of the change shown to the user above the diff. null if none.',
          },
        },
        required: ['article_id', 'title', 'markdown', 'summary'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_article',
      strict: true,
      description: [
        'Propose creating a new article. The article is NOT created',
        'immediately — the user reviews the proposed title and body',
        'and clicks Apply or Reject in the chat UI. New articles are',
        'created in Markdown editor mode.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          markdown: {
            type: 'string',
            description: 'Article body as markdown.',
          },
          folder_id: {
            type: ['string', 'null'],
            description:
              'UUID of the parent folder. Use null to create the article at the root.',
          },
          visible_to_clients: {
            type: ['boolean', 'null'],
            description: 'Defaults to true. Use null for the default.',
          },
          summary: {
            type: ['string', 'null'],
            description:
              'One-line summary shown to the user above the preview. null if none.',
          },
        },
        required: ['title', 'markdown', 'folder_id', 'visible_to_clients', 'summary'],
      },
    },
  },
];

export type ArticleToolName = 'update_article' | 'create_article';

export function isArticleToolName(name: string): name is ArticleToolName {
  return name === 'update_article' || name === 'create_article';
}

/**
 * OpenAI `tool_choice` shapes we emit. `'none'` suppresses tool calls
 * (questions), `'auto'` lets the model self-select (constrained by the
 * `strict` schemas above), and the named-function form forces exactly
 * one tool — on vLLM that applies structured-output constraints by
 * default, the strongest portable reliability lever.
 */
export type ToolChoice =
  | 'none'
  | 'auto'
  | { type: 'function'; function: { name: ArticleToolName } };

/** The subset of `ARTICLE_TOOLS` matching the given names. */
export function articleToolsSubset(names: readonly ArticleToolName[]) {
  return ARTICLE_TOOLS.filter((t) =>
    names.includes(t.function.name as ArticleToolName),
  );
}
