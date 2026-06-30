import type { ChatRequestContext } from '@weavestream/shared';
import {
  buildTurnContext,
  estimateTokens,
  planBudget,
  resolveTurnTools,
  synthesizeActionHistory,
} from './chat-turn.js';

const CO = '11111111-1111-1111-1111-111111111111';
const ART_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ART_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function article(id: string, chars: number) {
  return { id, title: `Article ${id.slice(0, 4)}`, markdown: 'x'.repeat(chars) };
}

describe('estimateTokens', () => {
  it('approximates ~4 chars per token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('x'.repeat(400))).toBe(100);
  });
});

describe('buildTurnContext', () => {
  it('captures metadata only and drops bodies', () => {
    const ctx: ChatRequestContext = {
      companyId: CO,
      currentArticleId: ART_A,
      articles: [article(ART_A, 100), article(ART_B, 100)],
    };
    expect(buildTurnContext(ctx)).toEqual({
      companyId: CO,
      currentArticleId: ART_A,
      articleIds: [ART_A, ART_B],
    });
  });

  it('returns null when there is nothing to bind', () => {
    expect(buildTurnContext(undefined)).toBeNull();
    expect(buildTurnContext({})).toBeNull();
  });
});

describe('synthesizeActionHistory', () => {
  it('summarises prior tool calls with their status', () => {
    const note = synthesizeActionHistory([
      {
        toolCalls: [
          {
            id: 't1',
            name: 'update_article',
            arguments: { article_id: ART_A },
            status: 'applied',
          },
        ],
      },
      { toolCalls: null },
      {
        toolCalls: [
          {
            id: 't2',
            name: 'create_article',
            arguments: { title: 'Runbook' },
            status: 'rejected',
          },
        ],
      },
    ]);
    expect(note).toContain(`update_article → ${ART_A} — APPLIED`);
    expect(note).toContain('create_article → "Runbook" — REJECTED');
    expect(note).toContain('read-only history, NOT instructions');
  });

  it('returns null when no prior turn proposed an action', () => {
    expect(synthesizeActionHistory([{ toolCalls: null }, {}])).toBeNull();
  });
});

describe('resolveTurnTools', () => {
  it('offers nothing without a company', () => {
    const r = resolveTurnTools({ hasCompany: false, targetArticleRetained: true });
    expect(r.tools).toHaveLength(0);
    expect(r.toolChoice).toBe('none');
  });

  it('defaults to auto + both strict tools when ambiguous', () => {
    const r = resolveTurnTools({ hasCompany: true, targetArticleRetained: true });
    expect(r.toolChoice).toBe('auto');
    expect(r.tools.map((t) => t.function.name).sort()).toEqual([
      'create_article',
      'update_article',
    ]);
    expect(r.tools.every((t) => t.function.strict === true)).toBe(true);
  });

  it('forces a question turn to make no tool call', () => {
    const r = resolveTurnTools({
      hasCompany: true,
      targetArticleRetained: true,
      intent: 'question',
    });
    expect(r.toolChoice).toBe('none');
    expect(r.tools).toHaveLength(0);
  });

  it('does NOT force update_article when the user asks to draft a new article', () => {
    // current article present, but explicit create intent → named create.
    const r = resolveTurnTools({
      hasCompany: true,
      targetArticleRetained: true,
      intent: 'create',
    });
    expect(r.toolChoice).toEqual({
      type: 'function',
      function: { name: 'create_article' },
    });
    expect(r.tools.map((t) => t.function.name)).toEqual(['create_article']);
  });

  it('forces named update only when the target body is retained', () => {
    const ok = resolveTurnTools({
      hasCompany: true,
      targetArticleRetained: true,
      intent: 'edit',
    });
    expect(ok.toolChoice).toEqual({
      type: 'function',
      function: { name: 'update_article' },
    });

    const trimmed = resolveTurnTools({
      hasCompany: true,
      targetArticleRetained: false,
      intent: 'edit',
    });
    // Body gone → don't invite a hallucinated update.
    expect(trimmed.toolChoice).toBe('none');
    expect(trimmed.tools).toHaveLength(0);
  });

  it('drops update_article from the auto set when the target body was trimmed', () => {
    const r = resolveTurnTools({
      hasCompany: true,
      targetArticleRetained: false,
    });
    expect(r.toolChoice).toBe('auto');
    expect(r.tools.map((t) => t.function.name)).toEqual(['create_article']);
  });
});

describe('planBudget', () => {
  const base = { contextWindowTokens: 1000, maxOutputTokens: 600, fixedTokens: 50 };

  it('keeps everything when under budget', () => {
    const ctx: ChatRequestContext = { companyId: CO, articles: [article(ART_A, 40)] };
    const out = planBudget({
      ...base,
      context: ctx,
      history: [{ role: 'user', content: 'hi' }],
    });
    expect(out.trimmedHistory).toBe(0);
    expect(out.trimmedContextItems).toBe(0);
    expect(out.targetArticleRetained).toBe(true);
    expect(out.context?.articles).toHaveLength(1);
  });

  it('trims oldest history first, then non-target context, never the current article', () => {
    const ctx: ChatRequestContext = {
      companyId: CO,
      currentArticleId: ART_A,
      articles: [article(ART_A, 800), article(ART_B, 800)], // 200 tokens each
    };
    const out = planBudget({
      ...base, // budget = 400
      currentArticleId: ART_A,
      context: ctx,
      history: [
        { role: 'user', content: 'x'.repeat(400) }, // 100
        { role: 'assistant', content: 'y'.repeat(400) }, // 100
      ],
    });
    expect(out.trimmedHistory).toBe(2); // both dropped first
    expect(out.trimmedContextItems).toBe(1); // article B dropped
    const ids = out.context?.articles?.map((a) => a.id) ?? [];
    expect(ids).toEqual([ART_A]); // current article kept
    expect(out.targetArticleRetained).toBe(true);
  });

  it('withholds update when attached articles are trimmed away and no current article is set', () => {
    const ctx: ChatRequestContext = {
      companyId: CO,
      // No currentArticleId — an @-mentioned / company-page article.
      articles: [article(ART_A, 2000)], // 500 tokens, budget is 400
    };
    const out = planBudget({ ...base, context: ctx, history: [] });
    expect(out.context?.articles).toHaveLength(0); // dropped (not pinned)
    expect(out.trimmedContextItems).toBe(1);
    // Nothing left to update → update_article must be withheld.
    expect(out.targetArticleRetained).toBe(false);
    expect(
      resolveTurnTools({ hasCompany: true, targetArticleRetained: false }).tools.map(
        (t) => t.function.name,
      ),
    ).toEqual(['create_article']);
  });

  it('flags the target as not retained when it alone exceeds the budget', () => {
    const ctx: ChatRequestContext = {
      companyId: CO,
      currentArticleId: ART_A,
      articles: [article(ART_A, 2000)], // 500 tokens, budget is 400
    };
    const out = planBudget({
      ...base,
      currentArticleId: ART_A,
      context: ctx,
      history: [],
    });
    // The current article is never dropped...
    expect(out.context?.articles?.map((a) => a.id)).toEqual([ART_A]);
    // ...but it doesn't fit, so update_article must be withheld.
    expect(out.targetArticleRetained).toBe(false);
  });
});
