import {
  AI_TOOL_MODES,
  isRewriteTargetHallucinated,
  type AiToolMode,
  type ArticleTextEdit,
  type ChatToolCallDto,
} from '@weavestream/shared';

/**
 * Classification for the Ask proposal cards (Phase 5b — mobile now
 * previews, applies, and rejects article proposals through the same
 * authorized endpoints desktop uses).
 *
 * Two traps this module exists to absorb:
 *
 *  - The `tool_call` event carries EVERY tool call attached to the
 *    turn, including executed/failed READ tools (search, get_article).
 *    Only proposal-mode tools (`AI_TOOL_MODES`) become cards — a
 *    completed search rendered as a proposal would be a lie.
 *  - `arguments` is whatever JSON the LLM produced; the schema
 *    deliberately admits malformed output so a broken call can still be
 *    persisted and rejected (chat.ts). Every read is runtime-narrowed —
 *    an `arguments.title` that isn't a string must not crash the
 *    transcript.
 */

export interface ProposalView {
  call: ChatToolCallDto;
  /** "Drafted an article" / "Drafted an article edit". */
  headline: string;
  /** The proposed title, when the model supplied a usable one. */
  title: string | null;
  /** `arguments.article_id`, narrowed. */
  articleId: string | null;
  /** Raw proposed body (`arguments.markdown`), narrowed. */
  markdown: string | null;
  /** Raw `arguments.edits` — validated downstream by the shared ladder. */
  edits: ArticleTextEdit[] | undefined;
  isPatch: boolean;
  isRewrite: boolean;
  /**
   * Whether Apply routes through the create confirmation sheet: a
   * genuine `create_article`, or a rewrite whose target the model
   * hallucinated — but ONLY when it carries a body, because the
   * server's create-promotion requires one (`markdown` is optional on
   * `update_article` for title-only edits). Mobile has no page context
   * and no mentions, so `knownArticleIds` is always empty here.
   */
  treatAsCreate: boolean;
}

const PROPOSAL_HEADLINES: Partial<Record<string, string>> = {
  create_article: 'Drafted an article',
  update_article: 'Drafted an article edit',
  patch_article: 'Drafted an article edit',
};

export function proposalViews(
  toolCalls: readonly ChatToolCallDto[],
): ProposalView[] {
  return toolCalls.flatMap((call) => {
    const mode = (AI_TOOL_MODES as Partial<Record<string, AiToolMode>>)[
      call.name
    ];
    if (mode !== 'proposal') return [];
    const isPatch = call.name === 'patch_article';
    const isRewrite = call.name === 'update_article';
    const articleId = extractString(call.arguments, 'article_id');
    const markdown = extractString(call.arguments, 'markdown');
    const hallucinated = isRewriteTargetHallucinated({
      isRewrite,
      targetArticleId: articleId,
      knownArticleIds: EMPTY_IDS,
      baseRevision: call.baseRevision,
    });
    return [
      {
        call,
        headline: PROPOSAL_HEADLINES[call.name] ?? 'Drafted a change',
        title: extractTitle(call.arguments),
        articleId,
        markdown,
        edits: extractEdits(call.arguments),
        isPatch,
        isRewrite,
        treatAsCreate:
          call.name === 'create_article' || (hallucinated && markdown !== null),
      },
    ];
  });
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

function extractTitle(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null;
  const title = (args as Record<string, unknown>).title;
  return typeof title === 'string' && title.trim() ? title.trim() : null;
}

function extractString(args: unknown, key: string): string | null {
  if (typeof args !== 'object' || args === null) return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' && value ? value : null;
}

/**
 * Pass edits through UNVALIDATED when present-but-broken: the shared
 * `buildPatchPreview` ladder owns the malformed-edits message, and
 * pre-filtering here would misreport a broken patch as "no changes".
 */
function extractEdits(args: unknown): ArticleTextEdit[] | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const edits = (args as Record<string, unknown>).edits;
  if (edits === undefined || edits === null) return undefined;
  return edits as ArticleTextEdit[];
}
