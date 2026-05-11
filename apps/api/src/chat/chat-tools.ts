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
 */
export const ARTICLE_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'update_article',
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
            type: 'string',
            description: 'New title. Omit to keep the existing title.',
          },
          markdown: {
            type: 'string',
            description:
              'Full replacement markdown body. Required when the goal is to change the article content.',
          },
          summary: {
            type: 'string',
            description:
              'One-line natural-language summary of the change shown to the user above the diff.',
          },
        },
        required: ['article_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_article',
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
            type: 'string',
            description:
              'Optional UUID of the parent folder. Omit to create the article at the root.',
          },
          visible_to_clients: {
            type: 'boolean',
            description: 'Defaults to true.',
          },
          summary: {
            type: 'string',
            description: 'One-line summary shown to the user above the preview.',
          },
        },
        required: ['title', 'markdown'],
      },
    },
  },
];

export type ArticleToolName = 'update_article' | 'create_article';

export function isArticleToolName(name: string): name is ArticleToolName {
  return name === 'update_article' || name === 'create_article';
}
