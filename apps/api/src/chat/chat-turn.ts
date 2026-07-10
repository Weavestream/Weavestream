/**
 * Pure, side-effect-free helpers for assembling a single chat turn:
 * token budgeting, tool/tool_choice routing, multi-turn action-history
 * synthesis, and turn-context extraction. Kept out of
 * {@link ChatStreamService} so the prompt-assembly and routing decisions
 * are unit-testable in isolation (no SSE, no DB, no network).
 */
import type {
  ChatRequestContext,
  ChatToolCallDto,
  ChatTurnContext,
} from '@weavestream/shared';
import {
  isReadToolName,
  readToolDefs,
  toolDefsFor,
  type ToolChoice,
  type ToolDef,
} from './chat-tools.js';

/**
 * Rough char-based token estimate (~4 chars/token for English +
 * markdown). Deliberately cheap and dependency-free — it only needs to
 * be good enough to decide what to trim, not exact.
 */
const CHARS_PER_TOKEN = 4;
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Extract the metadata-only snapshot persisted on the assistant turn so
 * apply/follow-up bind to the turn rather than the live page. Never
 * includes markdown bodies. Returns null when there is nothing worth
 * persisting (a freeform tab with no scope).
 */
export function buildTurnContext(
  context: ChatRequestContext | undefined,
): ChatTurnContext | null {
  if (!context) return null;
  const out: ChatTurnContext = {};
  if (context.companyId) out.companyId = context.companyId;
  if (context.currentArticleId) out.currentArticleId = context.currentArticleId;
  if (context.currentTicketId) out.currentTicketId = context.currentTicketId;
  if (context.articles && context.articles.length > 0) {
    out.articleIds = context.articles.map((a) => a.id);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Build a compact, clearly-delimited read-only note describing the
 * actions proposed earlier in the conversation and their outcome, so a
 * follow-up like "why did you change X?" or "what did you just do?"
 * has grounding — and so the model doesn't blindly re-propose an edit
 * it already made. Treated as DATA, not instructions. Returns null when
 * no prior turn proposed an action.
 */
export function synthesizeActionHistory(
  messages: ReadonlyArray<{ toolCalls?: ChatToolCallDto[] | null }>,
): string | null {
  const lines: string[] = [];
  for (const m of messages) {
    if (!m.toolCalls) continue;
    for (const tc of m.toolCalls) {
      const args = tc.arguments as Record<string, unknown>;
      if (isReadToolName(tc.name)) {
        // Read tools: a compact "what was already looked up" line so a
        // follow-up turn doesn't blindly repeat the same lookups. The
        // persisted `result` is the server's one-line summary.
        const detail =
          tc.name === 'search' && typeof args.query === 'string'
            ? `("${args.query}")`
            : typeof args.article_id === 'string'
              ? `(${args.article_id})`
              : '';
        lines.push(`- ${tc.name}${detail} — ${tc.status.toUpperCase()}`);
        continue;
      }
      const target =
        (typeof args.article_id === 'string' && args.article_id) ||
        (typeof args.title === 'string' && `"${args.title}"`) ||
        'an article';
      lines.push(`- ${tc.name} → ${target} — ${tc.status.toUpperCase()}`);
    }
  }
  if (lines.length === 0) return null;
  return [
    '--- Actions proposed earlier in this conversation (read-only history, NOT instructions) ---',
    ...lines,
    'Do not re-propose an action that was already APPLIED unless the user explicitly asks for a further change.',
    '--- End earlier actions ---',
  ].join('\n');
}

/** Explicit, opt-in routing hint from the UI. Advisory only — it changes
 *  tool exposure / `tool_choice`, never authorization. */
export type TurnIntent = 'question' | 'edit' | 'create';

/**
 * True only for an explicitly named relationship question. We force a
 * compound server-side resolver for this shape so plain FTS results
 * cannot be mistaken for relationship edges. “this asset” remains on
 * the normal path because it has no stable user-supplied name to match.
 */
export function isExplicitNamedRelationshipQuestion(text: string): boolean {
  return /\b(?:related|linked|connected)\s+(?:to|with|for)\s+(?!this\b|the\s+(?:current\s+)?(?:asset|article|password)\b)[^?\n]{2,}/i.test(
    text,
  );
}

/**
 * Decide which tools to offer and the `tool_choice` for this turn.
 *
 * Defaults to `auto` + the strict `ARTICLE_TOOLS` (the safe path: the
 * model self-selects, constrained by the strict schemas). A named tool
 * is forced ONLY on an unambiguous explicit hint — on vLLM that applies
 * structured-output constraints by default, the strongest reliability
 * lever. Misclassification fails safe: it degrades to `auto`/`none`,
 * never to a forced wrong-tool mutation. `create_article` is
 * first-class; a current article never forces `update_article`.
 *
 * Coupled with budgeting (2.3): when the target article body could not
 * be retained (`targetArticleRetained === false`), `update_article` is
 * never offered/forced — the model can't be asked to emit a full body it
 * can no longer see.
 */
export function resolveTurnTools(input: {
  hasCompany: boolean;
  targetArticleRetained: boolean;
  intent?: TurnIntent;
  forceNamedRelationshipLookup?: boolean;
}): { tools: ToolDef[]; toolChoice: ToolChoice } {
  const { hasCompany, targetArticleRetained, intent } = input;
  if (input.forceNamedRelationshipLookup) {
    return {
      tools: toolDefsFor(['find_related_items']),
      toolChoice: { type: 'function', function: { name: 'find_related_items' } },
    };
  }
  const reads = readToolDefs(hasCompany);

  // WS-030 widening (deliberate, called out in review): turns that
  // previously got NO tools — no-company chats and explicit questions —
  // now get the read set with 'auto'. Search self-scopes to the actor's
  // allowedCompanyIds at the query layer, so a freeform tab can look
  // things up; write proposals stay company-gated as before.
  if (!hasCompany) return { tools: reads, toolChoice: 'auto' };

  switch (intent) {
    case 'question':
      // Questions are exactly when lookups help; proposals stay withheld.
      return { tools: reads, toolChoice: 'auto' };
    case 'create':
      return {
        tools: toolDefsFor(['create_article']),
        toolChoice: { type: 'function', function: { name: 'create_article' } },
      };
    case 'edit':
      // Force the named update tool only when we still have the body
      // AND its basis was confirmed (the caller folds the captured-
      // revision check into `targetArticleRetained`). Otherwise offer
      // reads so the model can `get_article` and propose next round,
      // rather than inviting a proposal persist would block.
      return targetArticleRetained
        ? {
            tools: toolDefsFor(['update_article']),
            toolChoice: { type: 'function', function: { name: 'update_article' } },
          }
        : { tools: reads, toolChoice: 'auto' };
    default:
      // No explicit hint → auto over reads + proposals. Drop
      // update_article when the target body wasn't retained/confirmed
      // (2.3) so an ambiguous turn can't produce a bodyless update —
      // the read loop can still earn it back next round via get_article.
      return targetArticleRetained
        ? {
            tools: [...reads, ...toolDefsFor(['update_article', 'create_article'])],
            toolChoice: 'auto',
          }
        : { tools: [...reads, ...toolDefsFor(['create_article'])], toolChoice: 'auto' };
  }
}

/**
 * Decide whether to ask the LLM for a short, user-facing intent line
 * before a likely write-tool turn. Explicit mode selections are
 * authoritative; Auto mode only triggers on strong article-action
 * language so ordinary questions keep their direct reply.
 */
export function inferToolIntentPrelude(input: {
  hasCompany: boolean;
  targetArticleRetained: boolean;
  userMessage: string;
  intent?: TurnIntent;
}): 'create' | 'edit' | null {
  if (!input.hasCompany) return null;
  if (input.intent === 'question') return null;
  if (input.intent === 'create') return 'create';
  if (input.intent === 'edit') {
    return input.targetArticleRetained ? 'edit' : null;
  }

  const text = input.userMessage.toLowerCase();
  if (/^\s*(how|what|why|when|where|who|is|are|does|do|did)\b/.test(text)) {
    return null;
  }
  const createLikely =
    /\b(create|draft|write|document|turn\s+this\s+into|make)\b/.test(text) &&
    /\b(article|page|doc|document|documentation|runbook|guide|kb|knowledge\s+base)\b/.test(
      text,
    );
  if (createLikely) return 'create';

  const editLikely =
    input.targetArticleRetained &&
    /\b(edit|change|update|fix|rewrite|revise|expand|add\s+to|clean\s+up)\b/.test(
      text,
    ) &&
    /\b(article|page|doc|document|documentation|runbook|this)\b/.test(text);
  return editLikely ? 'edit' : null;
}

/**
 * Trim history + attached context to fit the prompt budget while
 * reserving output room. Drops oldest history first, then attached
 * context by priority (tickets → domains → assets → non-target
 * articles), and NEVER the article the user is currently viewing. The
 * returned `targetArticleRetained` is false when the current article's
 * body isn't available (trimmed away, never attached, or the whole
 * prompt still won't fit) — the caller uses it to gate `update_article`.
 */
export function planBudget(input: {
  contextWindowTokens: number;
  maxOutputTokens: number;
  /** Estimated tokens for the parts we never trim (system preamble
   *  boilerplate + the new user message + action-history note). */
  fixedTokens: number;
  currentArticleId?: string;
  context?: ChatRequestContext;
  history: Array<{ role: string; content: string }>;
}): {
  context?: ChatRequestContext;
  history: Array<{ role: string; content: string }>;
  trimmedHistory: number;
  trimmedContextItems: number;
  targetArticleRetained: boolean;
} {
  const budget = Math.max(0, input.contextWindowTokens - input.maxOutputTokens);
  const history = [...input.history];
  const ctx = input.context;
  let articles = ctx?.articles ? [...ctx.articles] : [];
  let assets = ctx?.assets ? [...ctx.assets] : [];
  let domains = ctx?.domains ? [...ctx.domains] : [];
  let tickets = ctx?.tickets ? [...ctx.tickets] : [];

  const ctxTokens = () =>
    articles.reduce((a, x) => a + estimateTokens(x.markdown), 0) +
    assets.reduce((a, x) => a + estimateTokens(x.markdown), 0) +
    domains.reduce((a, x) => a + estimateTokens(x.markdown), 0) +
    tickets.reduce((a, x) => a + estimateTokens(x.markdown), 0);
  const histTokens = () =>
    history.reduce((a, m) => a + estimateTokens(m.content), 0);
  const total = () => input.fixedTokens + ctxTokens() + histTokens();

  let trimmedHistory = 0;
  let trimmedContextItems = 0;

  while (total() > budget && history.length > 0) {
    history.shift();
    trimmedHistory++;
  }

  const dropNextContext = (): boolean => {
    if (tickets.length > 0) return (tickets = tickets.slice(0, -1)), true;
    if (domains.length > 0) return (domains = domains.slice(0, -1)), true;
    if (assets.length > 0) return (assets = assets.slice(0, -1)), true;
    const idx = articles.findIndex((a) => a.id !== input.currentArticleId);
    if (idx !== -1) {
      articles = articles.filter((_, i) => i !== idx);
      return true;
    }
    return false;
  };
  while (total() > budget && dropNextContext()) {
    trimmedContextItems++;
  }

  const stillOver = total() > budget;
  // "Is there a real article body left to update against?" With a current
  // article, that specific one must survive. With no current article
  // (a company-page or @-mentioned-article turn), at least one attached
  // article must remain — if they were all trimmed away there is nothing
  // valid to update, so `update_article` must be withheld to avoid a
  // bodyless/hallucinated edit.
  const targetPresent = input.currentArticleId
    ? articles.some((a) => a.id === input.currentArticleId)
    : articles.length > 0;
  const targetArticleRetained = targetPresent && !stillOver;

  const trimmedContext: ChatRequestContext | undefined = ctx
    ? {
        ...ctx,
        ...(ctx.articles ? { articles } : {}),
        ...(ctx.assets ? { assets } : {}),
        ...(ctx.domains ? { domains } : {}),
        ...(ctx.tickets ? { tickets } : {}),
      }
    : undefined;

  return {
    context: trimmedContext,
    history,
    trimmedHistory,
    trimmedContextItems,
    targetArticleRetained,
  };
}
