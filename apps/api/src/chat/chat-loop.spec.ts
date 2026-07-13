import {
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
  type FinalizedToolCall,
} from './chat-loop.js';

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
  it('binds a captured basis onto the pending proposal', async () => {
    const resolver = jest.fn(async () => true);
    const out = await assignProposalBases(
      [call('update_article', { arguments: { article_id: ART } })],
      new Map([[ART, 7]]),
      resolver,
    );
    expect(out).toEqual([expect.objectContaining({ status: 'pending', baseRevision: 7 })]);
    // No fresh lookup for captured bases — persist time is lookup-free.
    expect(resolver).not.toHaveBeenCalled();
  });

  it('binds a captured basis onto a patch proposal', async () => {
    const resolver = jest.fn(async () => true);
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
      }),
    ]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('BLOCKS an uncaptured proposal whose article resolves in scope (never a blind update)', async () => {
    const out = await assignProposalBases(
      [call('update_article', { arguments: { article_id: ART } })],
      new Map(),
      jest.fn(async () => true),
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
      jest.fn(async () => false),
    );
    expect(out).toEqual([expect.objectContaining({ status: 'pending', baseRevision: null })]);
  });

  it('blocks an unresolvable patch target instead of promoting it to a create', async () => {
    const out = await assignProposalBases(
      [call('patch_article', { arguments: { article_id: ART, edits: [] } })],
      new Map(),
      jest.fn(async () => false),
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
    const resolver = jest.fn(async () => true);
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
      jest.fn(async () => true),
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
