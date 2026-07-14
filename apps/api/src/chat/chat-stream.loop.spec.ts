import type { AiToolExecutionResult } from '../ai-tools/ai-tool-executor.service.js';
import {
  MAX_READ_CALLS,
  READ_FAILED_LIMIT_MESSAGE,
  TOOL_MSG_INVALID_ARGS,
  TOOL_MSG_PROPOSAL_DEFERRED,
  runToolLoop,
  type FinalizedToolCall,
  type RoundResult,
  type ToolLoopDeps,
  type ToolLoopInput,
  type UpstreamMessage,
} from './chat-loop.js';
import { readToolDefs } from './chat-tools.js';

/**
 * Drives `runToolLoop` with fakes — no SSE, no network, no executor —
 * asserting the decision table from the WS-030 design: round/read
 * bounds, mixed-round deferral, force-final, deadline skip, protocol
 * validity (every echoed tool_call answered), and activity callbacks.
 */

let callCounter = 0;
function call(
  name: FinalizedToolCall['name'],
  overrides: Partial<FinalizedToolCall> = {},
): FinalizedToolCall {
  callCounter += 1;
  return {
    id: `tc-${callCounter}`,
    name,
    arguments: name === 'search' ? { query: 'q' } : {},
    status: 'pending',
    result: null,
    error: null,
    errorCode: null,
    rawArguments: '{"query":"q"}',
    ...overrides,
  };
}

function okResult(summary: string): AiToolExecutionResult {
  return {
    ok: true,
    output: { summary },
    payloadJson: JSON.stringify({ summary }),
    summary,
  };
}

function makeHarness(rounds: RoundResult[], opts: {
  executeRead?: jest.Mock;
  nowSequence?: number[];
  basisCaptured?: boolean;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
} = {}) {
  const messages: UpstreamMessage[] = [{ role: 'user', content: 'hello' }];
  const activity: Array<{ id: string; status: string }> = [];
  const notices: string[] = [];
  let nowIdx = 0;
  const nows = opts.nowSequence ?? [];
  const deps: ToolLoopDeps = {
    callRound: jest.fn(async (round: number) => {
      const r = rounds[round - 1];
      if (!r) throw new Error(`no scripted round ${round}`);
      return r;
    }) as ToolLoopDeps['callRound'],
    executeRead:
      opts.executeRead ??
      (jest.fn(async (c: FinalizedToolCall) =>
        okResult(`did ${c.name}`),
      ) as ToolLoopDeps['executeRead']),
    onReadResult: jest.fn(),
    onToolActivity: (c, status) => activity.push({ id: c.id, status }),
    onNotice: (m) => notices.push(m),
    now: () => (nowIdx < nows.length ? nows[nowIdx++]! : 0),
  };
  const input: ToolLoopInput = {
    messages,
    tools: readToolDefs(true),
    toolChoice: 'auto',
    hasCompany: true,
    appHelpAllowed: true,
    anyBasisCaptured: () => opts.basisCaptured ?? false,
    deadline: 120_000,
    contextWindowTokens: opts.contextWindowTokens ?? 32_000,
    maxOutputTokens: opts.maxOutputTokens ?? 2_000,
  };
  return { deps, input, messages, activity, notices };
}

describe('runToolLoop', () => {
  beforeEach(() => {
    callCounter = 0;
  });

  it('returns a plain answer after one round when no tools were called', async () => {
    const { deps, input } = makeHarness([
      { text: 'plain answer', finishReason: 'stop', toolCalls: [] },
    ]);
    const out = await runToolLoop(deps, input);
    expect(out).toEqual({
      text: 'plain answer',
      finishReason: 'stop',
      settledCalls: [],
      proposals: [],
    });
    expect(deps.callRound).toHaveBeenCalledTimes(1);
  });

  it('finishes immediately on a proposals-only round (single-round behavior preserved)', async () => {
    const update = call('update_article');
    const { deps, input } = makeHarness([
      { text: 'Here is the edit.', finishReason: 'tool_calls', toolCalls: [update] },
    ]);
    const out = await runToolLoop(deps, input);
    expect(out.proposals).toEqual([update]);
    expect(out.settledCalls).toEqual([]);
    expect(deps.callRound).toHaveBeenCalledTimes(1);
  });

  it('2-round happy path: read → result fed back → final answer', async () => {
    const search = call('search');
    const { deps, input, messages, activity } = makeHarness([
      { text: 'Looking that up.', finishReason: 'tool_calls', toolCalls: [search] },
      { text: 'Here is the answer.', finishReason: 'stop', toolCalls: [] },
    ]);
    const out = await runToolLoop(deps, input);

    expect(out.text).toBe('Looking that up.\n\nHere is the answer.');
    expect(out.settledCalls).toEqual([
      expect.objectContaining({
        id: search.id,
        status: 'executed',
        result: 'did search',
      }),
    ]);
    // Upstream protocol: assistant message echoing the call, then
    // exactly one tool reply for it.
    const assistantMsg = messages.find((m) => m.tool_calls);
    expect(assistantMsg?.tool_calls).toEqual([
      { id: search.id, type: 'function', function: { name: 'search', arguments: '{"query":"q"}' } },
    ]);
    expect(messages.filter((m) => m.role === 'tool')).toHaveLength(1);
    expect(activity).toEqual([
      { id: search.id, status: 'started' },
      { id: search.id, status: 'succeeded' },
    ]);
    // Round 2 got a leading separator because round 1 had text.
    expect(deps.callRound).toHaveBeenLastCalledWith(
      2,
      messages,
      expect.anything(),
      'auto',
      { leadingSeparator: true },
    );
  });

  it('defers proposals mixed with reads in round 1 and persists only the re-proposal', async () => {
    const search = call('search');
    const earlyUpdate = call('update_article');
    const reProposed = call('update_article');
    const { deps, input, messages } = makeHarness(
      [
        { text: '', finishReason: 'tool_calls', toolCalls: [search, earlyUpdate] },
        { text: 'Grounded proposal.', finishReason: 'tool_calls', toolCalls: [reProposed] },
      ],
      { basisCaptured: true },
    );
    const out = await runToolLoop(deps, input);

    // The early proposal never persisted — only the round-2 one did.
    expect(out.proposals).toEqual([reProposed]);
    // But it WAS answered upstream with the deferral note.
    const toolMsgs = messages.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs.map((m) => m.content)).toContain(TOOL_MSG_PROPOSAL_DEFERRED);
  });

  it('caps executions at MAX_READ_CALLS and fails the excess with budget code', async () => {
    const reads = Array.from({ length: MAX_READ_CALLS + 2 }, () => call('search'));
    const { deps, input, messages } = makeHarness([
      { text: '', finishReason: 'tool_calls', toolCalls: reads },
      { text: 'done', finishReason: 'stop', toolCalls: [] },
    ]);
    const out = await runToolLoop(deps, input);

    expect(deps.executeRead).toHaveBeenCalledTimes(MAX_READ_CALLS);
    const failed = out.settledCalls.filter((c) => c.status === 'failed');
    expect(failed).toHaveLength(2);
    expect(failed.every((c) => c.errorCode === 'budget')).toBe(true);
    expect(failed.every((c) => c.error === READ_FAILED_LIMIT_MESSAGE)).toBe(true);
    // Every echoed call was answered.
    expect(messages.filter((m) => m.role === 'tool')).toHaveLength(reads.length);
  });

  it('executes reads in BOTH tool rounds, then force-finals with no tools (F3)', async () => {
    const first = call('search');
    const second = call('search');
    const { deps, input, messages } = makeHarness([
      { text: '', finishReason: 'tool_calls', toolCalls: [first] },
      { text: '', finishReason: 'tool_calls', toolCalls: [second] },
      { text: 'forced final answer', finishReason: 'stop', toolCalls: [] },
    ]);
    const out = await runToolLoop(deps, input);

    expect(out.text).toBe('forced final answer');
    // Two execution rounds (F3): the round-2 read now runs too, feeding
    // the forced-final round — it is no longer dropped as budget-failed.
    expect(deps.executeRead).toHaveBeenCalledTimes(2);
    expect(out.settledCalls).toEqual([
      expect.objectContaining({ id: first.id, status: 'executed' }),
      expect.objectContaining({ id: second.id, status: 'executed' }),
    ]);
    // The forced-final round carried no tools at all.
    expect(deps.callRound).toHaveBeenLastCalledWith(3, messages, null, null, {
      leadingSeparator: false,
    });
  });

  it('finishes without a third completion when the last tool round mixes reads and proposals', async () => {
    const read = call('search');
    const proposal = call('update_article');
    const { deps, input } = makeHarness([
      { text: '', finishReason: 'tool_calls', toolCalls: [call('search')] },
      { text: 'text', finishReason: 'tool_calls', toolCalls: [read, proposal] },
    ]);
    const out = await runToolLoop(deps, input);
    expect(deps.callRound).toHaveBeenCalledTimes(2);
    expect(out.proposals).toEqual([proposal]);
    expect(out.settledCalls).toEqual([
      expect.objectContaining({ status: 'executed' }),
      expect.objectContaining({ id: read.id, status: 'failed', errorCode: 'budget' }),
    ]);
  });

  it('skips further rounds when the deadline is nearly spent', async () => {
    const read = call('search');
    const { deps, input, notices } = makeHarness(
      [{ text: 'partial', finishReason: 'tool_calls', toolCalls: [read] }],
      // First now() call happens after round 1: 2s before the deadline.
      { nowSequence: [118_000] },
    );
    const out = await runToolLoop(deps, input);
    expect(deps.callRound).toHaveBeenCalledTimes(1);
    expect(deps.executeRead).not.toHaveBeenCalled();
    expect(out.settledCalls).toEqual([
      expect.objectContaining({ id: read.id, status: 'failed', errorCode: 'budget' }),
    ]);
    expect(notices.some((n) => /time/i.test(n))).toBe(true);
  });

  it('answers malformed calls upstream without executing or charging them', async () => {
    const broken = call('get_article', {
      status: 'failed',
      errorCode: 'malformed',
      error: 'bad json',
    });
    const good = call('search');
    const { deps, input, messages } = makeHarness([
      { text: '', finishReason: 'tool_calls', toolCalls: [broken, good] },
      { text: 'done', finishReason: 'stop', toolCalls: [] },
    ]);
    const out = await runToolLoop(deps, input);
    expect(deps.executeRead).toHaveBeenCalledTimes(1);
    const toolMsgs = messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.content)).toContain(TOOL_MSG_INVALID_ARGS);
    expect(out.settledCalls).toEqual([
      expect.objectContaining({ id: broken.id, status: 'failed', errorCode: 'malformed' }),
      expect.objectContaining({ id: good.id, status: 'executed' }),
    ]);
  });

  it('surfaces executor failures generically and emits one budget notice with the retry window', async () => {
    const read1 = call('search');
    const read2 = call('search');
    const executeRead = jest.fn(async () => ({
      ok: false as const,
      error: 'Tool budget reached for now — answer with what you already have.',
      errorCode: 'budget' as const,
      retryAfterSeconds: 1800,
    }));
    const { deps, input, notices, activity } = makeHarness(
      [
        { text: '', finishReason: 'tool_calls', toolCalls: [read1, read2] },
        { text: 'done', finishReason: 'stop', toolCalls: [] },
      ],
      { executeRead },
    );
    const out = await runToolLoop(deps, input);
    expect(out.settledCalls.every((c) => c.status === 'failed')).toBe(true);
    expect(out.settledCalls.every((c) => c.errorCode === 'budget')).toBe(true);
    // One notice, not one per failed call; names the retry window.
    expect(notices.filter((n) => /budget/i.test(n))).toHaveLength(1);
    expect(notices[0]).toMatch(/30 min/);
    expect(activity.filter((a) => a.status === 'failed')).toHaveLength(2);
  });

  it('records read results so a get_article can earn update_article back next round', async () => {
    const read = call('get_article');
    const { deps, input } = makeHarness([
      { text: '', finishReason: 'tool_calls', toolCalls: [read] },
      { text: 'done', finishReason: 'stop', toolCalls: [] },
    ]);
    await runToolLoop(deps, input);
    expect(deps.onReadResult).toHaveBeenCalledWith(
      read,
      expect.objectContaining({ ok: true }),
    );
  });

  it('does not report a basis read when the JSON payload was clamped', async () => {
    const read = call('get_article');
    const executeRead = jest.fn(async () => ({
      ok: true as const,
      output: { id: 'article-id', revision: 7, truncated: false },
      payloadJson: JSON.stringify({ markdown: 'x'.repeat(5_000) }),
      summary: 'read',
    }));
    const { deps, input } = makeHarness(
      [
        { text: '', finishReason: 'tool_calls', toolCalls: [read] },
        { text: 'done', finishReason: 'stop', toolCalls: [] },
      ],
      { executeRead, contextWindowTokens: 1_000, maxOutputTokens: 900 },
    );
    await runToolLoop(deps, input);
    expect(deps.onReadResult).not.toHaveBeenCalled();
  });
});
