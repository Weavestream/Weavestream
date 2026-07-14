import {
  MAX_COMPLETIONS,
  MAX_TOOL_ROUNDS,
  NO_BASE_BLOCK_MESSAGE,
  TOOL_RESULT_MAX_CHARS,
  TOOL_RESULT_MIN_CHARS,
  assignProposalBases,
  clampToolResult,
  completeArticleReadBasis,
  confirmedSnapshotBases,
  fitToolResultChars,
  joinRoundText,
  partitionToolCalls,
  remainingMs,
  roundTools,
  runToolLoop,
  type FinalizedToolCall,
  type RoundResult,
  type ToolLoopDeps,
  type ToolLoopInput,
  type UpstreamMessage,
} from './chat-loop.js';
import type { AiToolExecutionResult } from '../ai-tools/ai-tool-executor.service.js';

const ART = '4e8c7a52-88a1-4f5e-9b1e-1a2b3c4d5e6f';

function call(
  name: FinalizedToolCall['name'],
  overrides: Partial<FinalizedToolCall> = {},
): FinalizedToolCall {
  return {
    id: `tc-${name}`,
    name,
    arguments: {},
    status: 'pending',
    result: null,
    error: null,
    errorCode: null,
    rawArguments: '{}',
    ...overrides,
  };
}

describe('partitionToolCalls', () => {
  it('splits reads, proposals, and finalize-failed calls', () => {
    const search = call('search');
    const update = call('update_article');
    const broken = call('get_article', { status: 'failed', errorCode: 'malformed' });
    const { reads, proposals, malformed } = partitionToolCalls([search, update, broken]);
    expect(reads).toEqual([search]);
    expect(proposals).toEqual([update]);
    expect(malformed).toEqual([broken]);
  });
});

describe('roundTools', () => {
  const names = (r: { tools: Array<{ function: { name: string } }> }) =>
    r.tools.map((t) => t.function.name);

  it('drops reads when the per-turn budget is spent', () => {
    const r = roundTools({ readBudget: 0, hasCompany: true, anyBasisCaptured: false });
    expect(names(r)).toEqual(['create_article']);
  });

  it('earns article edit tools back once a basis was captured this turn', () => {
    const r = roundTools({ readBudget: 3, hasCompany: true, anyBasisCaptured: true });
    expect(names(r)).toContain('update_article');
    expect(names(r)).toContain('patch_article');
    expect(names(r)).toContain('create_article');
    expect(names(r)).toContain('get_company_summary');
  });

  it('never offers create or company summary without a company scope', () => {
    const r = roundTools({ readBudget: 3, hasCompany: false, anyBasisCaptured: true });
    expect(names(r)).toEqual([
      'search',
      'find_related_items',
      'get_article',
      'get_related_items',
      'get_app_help',
      'patch_article',
      'update_article',
    ]);
  });

  it('withholds get_app_help from CLIENT_USER (appHelpAllowed=false) (F13)', () => {
    const r = roundTools({
      readBudget: 3,
      hasCompany: true,
      anyBasisCaptured: false,
      appHelpAllowed: false,
    });
    expect(names(r)).not.toContain('get_app_help');
    // Other read tools stay on the menu.
    expect(names(r)).toContain('search');
    expect(names(r)).toContain('get_article');
  });
});

describe('text/result helpers', () => {
  it('joinRoundText joins non-empty pieces with a blank line', () => {
    expect(joinRoundText('', 'b')).toBe('b');
    expect(joinRoundText('a', '')).toBe('a');
    expect(joinRoundText('a\n', 'b')).toBe('a\n\nb');
  });

  it('clampToolResult marks truncation honestly', () => {
    expect(clampToolResult('short', 10)).toEqual({ text: 'short', truncated: false });
    const clamped = clampToolResult('x'.repeat(20), 10);
    expect(clamped.truncated).toBe(true);
    expect(clamped.text).toBe(`${'x'.repeat(10)}…[truncated]`);
  });

  it('only treats a complete get_article response as an update basis', () => {
    const complete = completeArticleReadBasis({
      ok: true,
      output: { id: ART, revision: 7, truncated: false },
      payloadJson: '{}',
      summary: 'read',
    });
    expect(complete).toEqual({ articleId: ART, revision: 7 });

    expect(
      completeArticleReadBasis({
        ok: true,
        output: { id: ART, revision: 7, truncated: true },
        payloadJson: '{}',
        summary: 'read',
      }),
    ).toBeNull();
  });

  it('fitToolResultChars respects ceiling and floor', () => {
    const base = { contextWindowTokens: 1_000_000, maxOutputTokens: 1000, messages: [] };
    expect(fitToolResultChars(base)).toBe(TOOL_RESULT_MAX_CHARS);
    const crowded = {
      contextWindowTokens: 1000,
      maxOutputTokens: 900,
      messages: [{ role: 'user', content: 'x'.repeat(4000) }],
    };
    expect(fitToolResultChars(crowded)).toBe(TOOL_RESULT_MIN_CHARS);
  });

  it('remainingMs floors at zero', () => {
    expect(remainingMs(1000, 400)).toBe(600);
    expect(remainingMs(1000, 2000)).toBe(0);
  });
});

describe('confirmedSnapshotBases (capture point a)', () => {
  it('captures only when the client claim matches the current row', () => {
    const captured = confirmedSnapshotBases([{ id: 'a-1', revision: 5 }], new Map([['a-1', 5]]));
    expect(captured.get('a-1')).toBe(5);
  });

  it('does NOT capture when the row moved past the claim — the review TOCTOU repro', () => {
    // Snapshot body is revision 5; another user saved revision 6 after
    // the client fetched. Capturing 6 here would let Apply overwrite
    // that newer edit with a proposal drafted from 5.
    const captured = confirmedSnapshotBases([{ id: 'a-1', revision: 5 }], new Map([['a-1', 6]]));
    expect(captured.size).toBe(0);
  });

  it('does NOT capture snapshots without a revision claim (old clients)', () => {
    const captured = confirmedSnapshotBases([{ id: 'a-1' }], new Map([['a-1', 5]]));
    expect(captured.size).toBe(0);
  });
});

describe('assignProposalBases', () => {
  const COMPANY = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

  it('binds a captured basis onto a rewrite proposal without a fresh lookup', async () => {
    const resolver = jest.fn(async () => COMPANY);
    const out = await assignProposalBases(
      [call('update_article', { arguments: { article_id: ART } })],
      new Map([[ART, 7]]),
      resolver,
    );
    expect(out).toEqual([expect.objectContaining({ status: 'pending', baseRevision: 7 })]);
    // Rewrites don't fetch by company, so the captured basis stays
    // lookup-free — the revision is never re-read.
    expect(resolver).not.toHaveBeenCalled();
    expect(out[0]).not.toHaveProperty('targetCompanyId');
  });

  it('binds a captured basis onto a patch proposal and attaches the target company (F2)', async () => {
    const resolver = jest.fn(async () => COMPANY);
    const out = await assignProposalBases(
      [call('patch_article', { arguments: { article_id: ART, edits: [] } })],
      new Map([[ART, 9]]),
      resolver,
    );
    expect(out).toEqual([
      expect.objectContaining({
        name: 'patch_article',
        status: 'pending',
        baseRevision: 9,
        targetCompanyId: COMPANY,
      }),
    ]);
    // Company-only resolve for the preview hint; the basis revision (9)
    // still comes from the captured map, never a fresh read.
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith(ART);
  });

  it('omits targetCompanyId on a captured patch whose company no longer resolves', async () => {
    const out = await assignProposalBases(
      [call('patch_article', { arguments: { article_id: ART, edits: [] } })],
      new Map([[ART, 9]]),
      jest.fn(async () => null),
    );
    expect(out[0]).toEqual(
      expect.objectContaining({ status: 'pending', baseRevision: 9 }),
    );
    expect(out[0]).not.toHaveProperty('targetCompanyId');
  });

  it('BLOCKS an uncaptured proposal whose article resolves in scope (never a blind update)', async () => {
    const out = await assignProposalBases(
      [call('update_article', { arguments: { article_id: ART } })],
      new Map(),
      jest.fn(async () => COMPANY),
    );
    expect(out).toEqual([
      expect.objectContaining({
        status: 'failed',
        errorCode: 'no_base',
        error: NO_BASE_BLOCK_MESSAGE,
      }),
    ]);
  });

  it('keeps an unresolvable article pending with baseRevision null (promotion-only)', async () => {
    const out = await assignProposalBases(
      [call('update_article', { arguments: { article_id: ART } })],
      new Map(),
      jest.fn(async () => null),
    );
    expect(out).toEqual([expect.objectContaining({ status: 'pending', baseRevision: null })]);
  });

  it('blocks an unresolvable patch target instead of promoting it to a create', async () => {
    const out = await assignProposalBases(
      [call('patch_article', { arguments: { article_id: ART, edits: [] } })],
      new Map(),
      jest.fn(async () => null),
    );
    expect(out).toEqual([
      expect.objectContaining({
        name: 'patch_article',
        status: 'failed',
        errorCode: 'unavailable',
      }),
    ]);
    expect(out[0]).not.toHaveProperty('baseRevision');
  });

  it('treats a non-uuid article id as unresolvable without querying', async () => {
    const resolver = jest.fn(async () => COMPANY);
    const out = await assignProposalBases(
      [call('update_article', { arguments: { article_id: 'not-a-uuid' } })],
      new Map(),
      resolver,
    );
    expect(out[0]).toMatchObject({ status: 'pending', baseRevision: null });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('passes create proposals through untouched and strips rawArguments everywhere', async () => {
    const out = await assignProposalBases(
      [call('create_article', { arguments: { title: 'T', markdown: 'B' } })],
      new Map(),
      jest.fn(async () => COMPANY),
    );
    expect(out).toEqual([
      {
        id: 'tc-create_article',
        name: 'create_article',
        arguments: { title: 'T', markdown: 'B' },
        status: 'pending',
        result: null,
        error: null,
        errorCode: null,
      },
    ]);
    expect('rawArguments' in out[0]!).toBe(false);
  });
});

describe('runToolLoop', () => {
  // These tests assume the two-execution-round shape (F3): tool rounds
  // 1..MAX_TOOL_ROUNDS execute reads, round MAX_COMPLETIONS is forced-final.
  beforeAll(() => {
    expect(MAX_TOOL_ROUNDS).toBe(2);
    expect(MAX_COMPLETIONS).toBe(3);
  });

  function okRead(summary: string, output: Record<string, unknown> = {}): AiToolExecutionResult {
    return { ok: true, output, payloadJson: JSON.stringify(output), summary };
  }

  function harness(rounds: RoundResult[]) {
    const seen = {
      rounds: [] as Array<{ round: number; offeredTools: boolean; toolChoice: unknown }>,
      executed: [] as string[],
      notices: [] as string[],
    };
    const deps: ToolLoopDeps = {
      callRound: async (round, _messages, tools, toolChoice) => {
        seen.rounds.push({ round, offeredTools: tools !== null, toolChoice });
        return rounds[round - 1] ?? { text: '', finishReason: 'stop', toolCalls: [] };
      },
      executeRead: async (c) => {
        seen.executed.push(c.name);
        return okRead(`ran ${c.name}`);
      },
      onReadResult: () => {},
      onToolActivity: () => {},
      onNotice: (m) => seen.notices.push(m),
      now: () => 0,
    };
    const input: ToolLoopInput = {
      messages: [{ role: 'user', content: 'hi' }] as UpstreamMessage[],
      tools: [],
      toolChoice: 'auto',
      hasCompany: true,
      appHelpAllowed: true,
      anyBasisCaptured: () => false,
      deadline: 1_000_000,
      contextWindowTokens: 8_000,
      maxOutputTokens: 1_000,
    };
    return { deps, input, seen };
  }

  const read = (id: string, name: FinalizedToolCall['name'], args: Record<string, unknown>) =>
    call(name, { id, arguments: args, rawArguments: JSON.stringify(args) });

  it('executes reads in BOTH tool rounds before the forced-final answer (F3)', async () => {
    const { deps, input, seen } = harness([
      { text: 'looking', finishReason: 'tool_calls', toolCalls: [read('r1', 'search', { query: 'a' })] },
      {
        text: 'more',
        finishReason: 'tool_calls',
        toolCalls: [read('r2', 'get_article', { article_id: ART })],
      },
      { text: 'final answer', finishReason: 'stop', toolCalls: [] },
    ]);

    const outcome = await runToolLoop(deps, input);

    // The regression: the round-2 read is EXECUTED, not dropped as
    // "tool limit reached". Before the fix only 'search' ran.
    expect(seen.executed).toEqual(['search', 'get_article']);
    expect(seen.rounds.map((r) => r.round)).toEqual([1, 2, 3]);
    // Round 3 is forced-final — no tools offered.
    expect(seen.rounds[2]).toMatchObject({ round: 3, offeredTools: false, toolChoice: null });
    expect(outcome.text).toContain('final answer');
    expect(
      outcome.settledCalls.filter((c) => c.status === 'executed').map((c) => c.name),
    ).toEqual(['search', 'get_article']);
  });

  it('returns a proposal from the last tool round instead of deferring it away', async () => {
    const { deps, input, seen } = harness([
      { text: 'reading', finishReason: 'tool_calls', toolCalls: [read('r1', 'search', { query: 'a' })] },
      {
        text: 'proposing',
        finishReason: 'tool_calls',
        toolCalls: [
          read('r2', 'search', { query: 'b' }),
          read('p1', 'update_article', { article_id: ART }),
        ],
      },
    ]);

    const outcome = await runToolLoop(deps, input);

    // Only round 1's read runs; round 2 short-circuits to return the
    // proposal (round 3 offers no tools to re-propose in).
    expect(seen.executed).toEqual(['search']);
    expect(seen.rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(outcome.proposals.map((p) => p.name)).toEqual(['update_article']);
    // The unexecuted round-2 read settles as a limit-reached failure.
    expect(
      outcome.settledCalls.some((c) => c.name === 'search' && c.errorCode === 'budget'),
    ).toBe(true);
  });
});
