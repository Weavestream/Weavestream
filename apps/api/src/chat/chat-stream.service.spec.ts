import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import type { SendChatMessageInput } from '@weavestream/shared';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { AiCompletionService } from '../ai/ai-completion.service.js';
import { ChatStreamService } from './chat-stream.service.js';
import { runToolLoop } from './chat-loop.js';

/**
 * `stream()`'s early-disconnect handling (mobile Phase 3 fix). SSE
 * headers flush at `initSse`, but the client-disconnect listener used
 * to attach only after prompt preparation — so an abort landing during
 * the ownership checks, the user-message persist, or prompt prep ran
 * the full LLM loop into a closed socket. The listener now installs
 * immediately after `initSse`, and the turn is checked before every
 * LLM entry point.
 *
 * The user-message persist deliberately still lands (history
 * correctness); only the completion work is skipped.
 */

jest.mock('./chat-loop.js', () => ({
  ...jest.requireActual('./chat-loop.js'),
  runToolLoop: jest.fn(),
}));
const runToolLoopMock = runToolLoop as jest.Mock;

jest.mock('../common/egress/safe-fetch.js', () => ({
  ...jest.requireActual('../common/egress/safe-fetch.js'),
  safeFetch: jest.fn(),
}));
import { safeFetch } from '../common/egress/safe-fetch.js';
const safeFetchMock = safeFetch as jest.Mock;

jest.mock('@weavestream/shared/server', () => ({
  ...jest.requireActual('@weavestream/shared/server'),
  requireTenantContext: () => ({
    requestId: 'req-1',
    ip: '127.0.0.1',
    userAgent: 'jest',
    allowedCompanyIds: [],
    isSuperAdmin: true,
    globalAccess: 'FULL',
  }),
}));

class FakeRes extends EventEmitter {
  statusCode = 0;
  writableEnded = false;
  chunks: string[] = [];
  setHeader(): void {}
  flushHeaders(): void {}
  write(chunk: unknown): boolean {
    this.chunks.push(String(chunk));
    return true;
  }
  end(): void {
    this.writableEnded = true;
  }
  frames(): string[] {
    return this.chunks
      .join('')
      .split('\n\n')
      .map((b) => /event: (\w+)/.exec(b)?.[1])
      .filter((e): e is string => !!e);
  }
}

const ACTOR = {
  id: 'user-1',
  email: 'tech@example.com',
  name: 'Tech',
  role: 'SUPER_ADMIN',
} as unknown as AuthedUser;

const INPUT = { content: 'how do I reboot the switch?' } as SendChatMessageInput;

function makeHarness() {
  const prisma = {
    chatConversation: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'conv-1',
        userId: ACTOR.id,
        // Not a first turn, so the title-generation upstream call never
        // enters these tests.
        title: 'Existing chat',
        messages: [
          { role: 'USER', content: 'earlier question', toolCalls: null },
        ],
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    chatMessage: {
      create: jest.fn().mockResolvedValue({
        id: 'um-1',
        content: INPUT.content,
        createdAt: new Date('2026-07-27T00:00:00Z'),
      }),
    },
    article: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn().mockResolvedValue([]),
  };
  const aiSettings = {
    getConfig: jest.fn().mockResolvedValue({
      enabled: true,
      provider: 'openai_compatible',
      baseUrl: 'http://localhost:1',
      apiKey: null,
      anthropicWorkspaceId: null,
      defaultModel: 'test-model',
      backgroundModel: 'test-model',
      reasoningEffort: 'off',
      maxOutputTokens: 1_000,
      contextWindowTokens: 8_000,
      allowPrivateNetwork: true,
    }),
  };
  const service = new ChatStreamService(
    prisma as never,
    aiSettings as never,
    {} as never,
    {} as never,
    // Real instance, mocked egress: the prelude-disconnect test below
    // asserts the client abort reaches the upstream fetch signal
    // through `complete()`'s own controller chain.
    new AiCompletionService(),
  );
  return { prisma, service };
}

beforeEach(() => {
  jest.clearAllMocks();
  runToolLoopMock.mockResolvedValue({
    text: 'the answer',
    finishReason: 'stop',
    settledCalls: [],
    proposals: [],
  });
});

describe('ChatStreamService.stream — early disconnect', () => {
  it('a disconnect during the user-message persist skips the LLM loop and the assistant row', async () => {
    const { prisma, service } = makeHarness();
    const res = new FakeRes();

    // The disconnect lands exactly in the persist window: after the
    // ownership/config checks, before `meta`.
    prisma.chatMessage.create.mockImplementation(async () => {
      res.emit('close');
      return {
        id: 'um-1',
        content: INPUT.content,
        createdAt: new Date('2026-07-27T00:00:00Z'),
      };
    });

    await service.stream(ACTOR, 'conv-1', INPUT, res as unknown as Response);

    // The user turn persisted — by design (history correctness).
    expect(prisma.chatMessage.create).toHaveBeenCalledTimes(1);
    // No completion loop, no assistant row, no done frame.
    expect(runToolLoopMock).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(res.frames()).not.toContain('done');
    expect(res.frames()).not.toContain('error');
    expect(res.writableEnded).toBe(true);
  });

  it('a disconnect before any write still ends the turn before LLM work', async () => {
    const { prisma, service } = makeHarness();
    const res = new FakeRes();

    prisma.chatConversation.findUnique.mockImplementation(async () => {
      res.emit('close');
      return {
        id: 'conv-1',
        userId: ACTOR.id,
        title: 'Existing chat',
        messages: [],
      };
    });

    await service.stream(ACTOR, 'conv-1', INPUT, res as unknown as Response);

    expect(runToolLoopMock).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(res.writableEnded).toBe(true);
  });

  it('a disconnect during prelude generation cancels the upstream call', async () => {
    const { prisma, service } = makeHarness();
    const res = new FakeRes();

    // `intent: 'create'` + a company context forces the tool-intent
    // prelude — the first upstream LLM call of the turn.
    const input = {
      content: 'document the reboot procedure',
      intent: 'create',
      context: { companyId: '22222222-2222-2222-2222-222222222222' },
    } as unknown as SendChatMessageInput;

    let preludeSignal: AbortSignal | undefined;
    safeFetchMock.mockImplementation(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          preludeSignal = opts.signal;
          // Listener FIRST (as real fetch wires internally), then the
          // client vanishes — the chained abort fires synchronously.
          opts.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
          res.emit('close');
        }),
    );

    await service.stream(ACTOR, 'conv-1', input, res as unknown as Response);

    // The upstream call was made once and its OWN signal was aborted by
    // the chained client disconnect — not left to the 15s timeout.
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(preludeSignal?.aborted).toBe(true);
    // And the turn ended before the completion loop.
    expect(runToolLoopMock).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(res.writableEnded).toBe(true);
  });

  it('an undisturbed turn still runs the loop, persists, and emits done', async () => {
    const { prisma, service } = makeHarness();
    const res = new FakeRes();

    await service.stream(ACTOR, 'conv-1', INPUT, res as unknown as Response);

    expect(runToolLoopMock).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(res.frames()).toContain('meta');
    expect(res.frames()).toContain('done');
    expect(res.writableEnded).toBe(true);
  });
});

type RoundOut = {
  text: string;
  finishReason: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: unknown; status: string }>;
  providerBlocks?: unknown[];
};

describe('ChatStreamService.stream — prelude, then a failed completion', () => {
  const input = {
    content: 'document the reboot procedure',
    intent: 'create',
    context: { companyId: '22222222-2222-2222-2222-222222222222' },
  } as unknown as SendChatMessageInput;

  function preludeOk() {
    safeFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'I will draft a reboot runbook for this company.' } }],
      }),
    });
  }

  function errorMessage(res: FakeRes): string | undefined {
    const frame = res.chunks
      .join('')
      .split('\n\n')
      .find((b) => b.includes('event: error'));
    const data = frame && /data: (.*)/.exec(frame)?.[1];
    return data ? (JSON.parse(data) as { message: string }).message : undefined;
  }

  it.each([
    ['length', /whole output budget/],
    ['refusal', /declined this request/],
  ])(
    'a "%s" finish with no completion text is an error, even though the prelude streamed',
    async (finishReason, message) => {
      const { prisma, service } = makeHarness();
      const res = new FakeRes();
      preludeOk();
      runToolLoopMock.mockResolvedValue({
        text: '',
        finishReason,
        settledCalls: [],
        proposals: [],
      });

      await service.stream(ACTOR, 'conv-1', input, res as unknown as Response);

      // The prelude reached the client first.
      expect(res.chunks.join('')).toContain('I will draft a reboot runbook');
      expect(errorMessage(res)).toMatch(message);
      // Nothing persisted as a successful reply.
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(res.frames()).not.toContain('done');
    },
  );

  it('a prelude plus real completion text still persists', async () => {
    const { prisma, service } = makeHarness();
    const res = new FakeRes();
    preludeOk();
    runToolLoopMock.mockResolvedValue({
      text: '# Reboot\n\nSteps.',
      finishReason: 'stop',
      settledCalls: [],
      proposals: [],
    });

    await service.stream(ACTOR, 'conv-1', input, res as unknown as Response);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(res.frames()).toContain('done');
  });
});

describe('ChatStreamService.runCompletionRound — rejected-feature fallbacks', () => {
  const SSE =
    'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n' +
    'data: [DONE]\n\n';
  const sse = () => new globalThis.Response(SSE, { status: 200 });
  const rejected = (msg: string) =>
    new globalThis.Response(JSON.stringify({ error: { message: msg } }), { status: 400 });

  function round(
    service: ChatStreamService,
    model: string,
    extra: {
      tools?: unknown;
      toolChoice?: unknown;
      messages?: unknown;
      config?: Record<string, unknown>;
      turn?: unknown;
    } = {},
  ) {
    return (service as unknown as {
      runCompletionRound: (o: unknown) => Promise<RoundOut>;
    }).runCompletionRound({
      config: {
        provider: 'openai_compatible',
        baseUrl: 'http://localhost:1',
        apiKey: null,
        anthropicWorkspaceId: null,
        defaultModel: model,
        reasoningEffort: 'off',
        maxOutputTokens: 1_000,
        allowPrivateNetwork: true,
        ...extra.config,
      },
      ...(extra.turn ? { turn: extra.turn } : {}),
      messages: extra.messages ?? [{ role: 'user', content: 'hi' }],
      tools: extra.tools ?? null,
      toolChoice: extra.toolChoice ?? null,
      res: new FakeRes(),
      abort: new AbortController(),
      deadline: Date.now() + 60_000,
      leadingSeparator: false,
    });
  }
  const sentBody = (call: number) =>
    JSON.parse((safeFetchMock.mock.calls[call]![1] as { body: string }).body) as Record<string, unknown>;

  it('retries once without temperature, then remembers the model', async () => {
    const { service } = makeHarness();
    safeFetchMock
      .mockResolvedValueOnce(rejected('`temperature` is deprecated for this model.'))
      .mockResolvedValueOnce(sse())
      .mockResolvedValueOnce(sse());

    await expect(round(service, 'future-model-9')).resolves.toMatchObject({ text: 'hi' });
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(0)).toHaveProperty('temperature', 0.2);
    expect(sentBody(1)).not.toHaveProperty('temperature');

    // Next round for the same model: no wasted first request.
    await round(service, 'future-model-9');
    expect(safeFetchMock).toHaveBeenCalledTimes(3);
    expect(sentBody(2)).not.toHaveProperty('temperature');
  });

  it('surfaces any other 400 without a retry', async () => {
    const { service } = makeHarness();
    safeFetchMock.mockResolvedValueOnce(rejected('messages: field required'));

    await expect(round(service, 'gpt-4o')).rejects.toThrow(/returned 400 — .*field required/);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  const TOOLS = [{ type: 'function', function: { name: 'create_article', parameters: {} } }];
  const FORCED = { type: 'function', function: { name: 'create_article' } };
  const MESSAGES = [
    { role: 'system', content: 'You are Ask anything.' },
    { role: 'user', content: 'write it up' },
  ];
  const forcedRejected = () =>
    rejected('tool_choice: type "tool" and "any" are not supported for this model.');

  it('downgrades a rejected forced tool_choice to auto plus an instruction', async () => {
    const { service } = makeHarness();
    safeFetchMock
      .mockResolvedValueOnce(forcedRejected())
      .mockResolvedValueOnce(sse())
      .mockResolvedValueOnce(sse());
    const extra = { tools: TOOLS, toolChoice: FORCED, messages: MESSAGES };

    await round(service, 'claude-opus-5-5', extra);
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(0).tool_choice).toEqual(FORCED);
    expect(sentBody(1).tool_choice).toBe('auto');
    expect(sentBody(1).tools).toEqual(TOOLS);
    const msgs = sentBody(1).messages as Array<{ role: string; content: string }>;
    // Instruction joins the FIRST system message; no trailing system turn.
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.content).toMatch(/You are Ask anything\.\n\nRespond by calling the `create_article` tool\./);

    // Remembered: the next round goes straight to auto.
    await round(service, 'claude-opus-5-5', extra);
    expect(safeFetchMock).toHaveBeenCalledTimes(3);
    expect(sentBody(2).tool_choice).toBe('auto');
  });

  it('handles both rejections in one round, one retry each', async () => {
    const { service } = makeHarness();
    safeFetchMock
      .mockResolvedValueOnce(rejected('`temperature` is deprecated for this model.'))
      .mockResolvedValueOnce(forcedRejected())
      .mockResolvedValueOnce(sse());

    await round(service, 'future-model-9', { tools: TOOLS, toolChoice: FORCED, messages: MESSAGES });
    expect(safeFetchMock).toHaveBeenCalledTimes(3);
    expect(sentBody(2)).not.toHaveProperty('temperature');
    expect(sentBody(2).tool_choice).toBe('auto');
  });

  it('does not downgrade auto tool_choice or retry a repeated rejection', async () => {
    const { service } = makeHarness();
    safeFetchMock.mockResolvedValueOnce(forcedRejected());

    await expect(
      round(service, 'gpt-4o', { tools: TOOLS, toolChoice: 'auto', messages: MESSAGES }),
    ).rejects.toThrow(/returned 400/);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it('never retries for a model already sent without temperature', async () => {
    const { service } = makeHarness();
    safeFetchMock.mockResolvedValueOnce(rejected('temperature: unsupported'));

    await expect(round(service, 'claude-opus-4-7')).rejects.toThrow(/returned 400/);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(sentBody(0)).not.toHaveProperty('temperature');
  });

  describe('reasoning parameters on an OpenAI-compatible server', () => {
    const FLAGS = ['enable_thinking', 'chat_template_kwargs', 'reasoning'];

    it("the 'default' setting sends no reasoning parameters (the pre-0088 shape)", async () => {
      const { service } = makeHarness();
      safeFetchMock.mockResolvedValueOnce(sse());
      await round(service, 'qwen3', { config: { reasoningEffort: 'default' } });
      for (const k of FLAGS) expect(sentBody(0)).not.toHaveProperty(k);
    });

    it.each([
      ['a named flag', '{"detail":"enable_thinking: Extra inputs are not permitted"}'],
      ['a generic unknown-field message', 'Unrecognized request argument supplied: x'],
    ])("'off' on a strict server: one retry without the flags after %s, then remembered", async (_label, msg) => {
      const { service } = makeHarness();
      safeFetchMock
        .mockResolvedValueOnce(rejected(msg))
        .mockResolvedValueOnce(sse())
        .mockResolvedValueOnce(sse());

      await expect(round(service, 'strict-model')).resolves.toMatchObject({ text: 'hi' });
      expect(safeFetchMock).toHaveBeenCalledTimes(2);
      expect(sentBody(0)).toHaveProperty('enable_thinking', false);
      for (const k of FLAGS) expect(sentBody(1)).not.toHaveProperty(k);

      await round(service, 'strict-model');
      expect(safeFetchMock).toHaveBeenCalledTimes(3);
      for (const k of FLAGS) expect(sentBody(2)).not.toHaveProperty(k);
    });

    it('a repeated rejection after the retry surfaces, with no loop', async () => {
      const { service } = makeHarness();
      safeFetchMock.mockResolvedValue(rejected('Unrecognized request argument supplied: x'));
      await expect(round(service, 'strict-model-2')).rejects.toThrow(/returned 400/);
      expect(safeFetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('provider anthropic (native Messages API)', () => {
    const ANTHROPIC = {
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      reasoningEffort: 'off',
    };
    const event = (name: string, data: Record<string, unknown>) =>
      `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
    const stream = (...frames: string[]) =>
      new globalThis.Response(frames.join(''), { status: 200 });
    const textReply = () =>
      stream(
        event('message_start', { message: { id: 'm', content: [] } }),
        event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
        event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Done.' } }),
        event('message_delta', { delta: { stop_reason: 'end_turn' } }),
        event('message_stop', {}),
      );
    const SEARCH = [
      {
        type: 'function',
        function: {
          name: 'search',
          description: 'Search.',
          parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
        },
      },
    ];

    it('streams text and tool calls, and returns the blocks for replay', async () => {
      const { service } = makeHarness();
      safeFetchMock.mockResolvedValueOnce(
        stream(
          event('message_start', { message: { id: 'm', content: [] } }),
          event('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
          event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } }),
          event('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'S1' } }),
          event('content_block_stop', { index: 0 }),
          event('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
          event('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Looking.' } }),
          event('content_block_stop', { index: 1 }),
          event('content_block_start', {
            index: 2,
            content_block: { type: 'tool_use', id: 'toolu_1', name: 'search', input: {} },
          }),
          event('content_block_delta', {
            index: 2,
            delta: { type: 'input_json_delta', partial_json: '{"query":"vpn"}' },
          }),
          event('content_block_stop', { index: 2 }),
          event('message_delta', { delta: { stop_reason: 'tool_use' } }),
          event('message_stop', {}),
        ),
      );

      const out = await round(service, 'claude-opus-5-5', {
        config: ANTHROPIC,
        tools: SEARCH,
        toolChoice: 'auto',
        messages: MESSAGES,
      });

      const [url, init] = safeFetchMock.mock.calls[0]! as [string, { headers: Record<string, string> }];
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect(init.headers['x-api-key']).toBe('sk-ant-test');
      expect(init.headers).not.toHaveProperty('Authorization');
      const body = sentBody(0);
      expect(body).not.toHaveProperty('temperature');
      expect(body.system).toEqual([
        { type: 'text', text: 'You are Ask anything.', cache_control: { type: 'ephemeral' } },
      ]);
      expect(body.tool_choice).toEqual({ type: 'auto' });
      expect(body.output_config).toEqual({ effort: 'low' });

      expect(out.text).toBe('Looking.');
      expect(out.finishReason).toBe('tool_calls');
      expect(out.toolCalls).toMatchObject([
        { id: 'toolu_1', name: 'search', arguments: { query: 'vpn' }, status: 'pending' },
      ]);
      expect(out.providerBlocks).toEqual([
        { type: 'thinking', thinking: 'hm', signature: 'S1' },
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', id: 'toolu_1', name: 'search', input: { query: 'vpn' } },
      ]);
    });

    it('sends auto plus the instruction where a forced tool is not accepted — no wasted 400', async () => {
      const { service } = makeHarness();
      safeFetchMock.mockResolvedValueOnce(textReply());
      await round(service, 'claude-opus-5-5', {
        config: ANTHROPIC,
        tools: TOOLS,
        toolChoice: FORCED,
        messages: MESSAGES,
      });
      expect(safeFetchMock).toHaveBeenCalledTimes(1);
      const body = sentBody(0);
      expect(body.tool_choice).toEqual({ type: 'auto' });
      expect((body.system as Array<{ text: string }>)[0]!.text).toMatch(
        /Respond by calling the `create_article` tool\./,
      );
    });

    it('forces the tool where the model accepts it (thinking off)', async () => {
      const { service } = makeHarness();
      safeFetchMock.mockResolvedValueOnce(textReply());
      await round(service, 'claude-opus-5', {
        config: ANTHROPIC,
        tools: TOOLS,
        toolChoice: FORCED,
        messages: MESSAGES,
      });
      expect(sentBody(0).tool_choice).toEqual({ type: 'tool', name: 'create_article' });
      expect(sentBody(0).thinking).toEqual({ type: 'disabled' });
    });

    const HISTORY = [
      ...MESSAGES,
      {
        role: 'assistant',
        content: null,
        providerBlocks: [
          { type: 'thinking', thinking: 'hm', signature: 'S1' },
          { type: 'tool_use', id: 'toolu_1', name: 'search', input: {} },
        ],
        tool_calls: [
          { id: 'toolu_1', type: 'function', function: { name: 'search', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'result' },
    ];

    it('retries once without replayed thinking when the API rejects it', async () => {
      const { service } = makeHarness();
      safeFetchMock
        .mockResolvedValueOnce(
          rejected(
            'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.',
          ),
        )
        .mockResolvedValueOnce(textReply());
      const turn = { sentTools: SEARCH };
      const out = await round(service, 'claude-opus-5-5', {
        config: ANTHROPIC,
        messages: HISTORY,
        turn,
      });
      expect(out.text).toBe('Done.');
      expect(safeFetchMock).toHaveBeenCalledTimes(2);
      const first = sentBody(0).messages as Array<{ content: Array<{ type: string }> }>;
      const second = sentBody(1).messages as Array<{ content: Array<{ type: string }> }>;
      expect(first[1]!.content.map((b) => b.type)).toEqual(['thinking', 'tool_use']);
      expect(second[1]!.content.map((b) => b.type)).toEqual(['tool_use']);
    });

    it('forced-final round: sends the turn tools with tool_choice none', async () => {
      const { service } = makeHarness();
      safeFetchMock.mockResolvedValueOnce(textReply());
      await round(service, 'claude-opus-5-5', {
        config: ANTHROPIC,
        messages: HISTORY,
        turn: { sentTools: SEARCH },
      });
      expect(sentBody(0).tool_choice).toEqual({ type: 'none' });
      expect((sentBody(0).tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['search']);
    });

    it('keeps earlier tools on the menu when a later round offers fewer', async () => {
      const { service } = makeHarness();
      safeFetchMock.mockResolvedValueOnce(textReply());
      const turn = { sentTools: SEARCH };
      await round(service, 'claude-opus-5-5', {
        config: ANTHROPIC,
        tools: TOOLS,
        toolChoice: 'auto',
        messages: HISTORY,
        turn,
      });
      expect((sentBody(0).tools as Array<{ name: string }>).map((t) => t.name)).toEqual([
        'search',
        'create_article',
      ]);
      expect(turn.sentTools.map((t) => t.function.name)).toEqual(['search', 'create_article']);
    });

    it('reports a refusal as its own finish reason', async () => {
      const { service } = makeHarness();
      safeFetchMock.mockResolvedValueOnce(
        stream(
          event('message_start', { message: { id: 'm', content: [] } }),
          event('message_delta', { delta: { stop_reason: 'refusal' } }),
          event('message_stop', {}),
        ),
      );
      const out = await round(service, 'claude-opus-5-5', { config: ANTHROPIC, messages: MESSAGES });
      expect(out.finishReason).toBe('refusal');
    });

    it('an interrupted stream is an error, never a finished round with pending tool calls', async () => {
      const { service } = makeHarness();
      safeFetchMock.mockResolvedValueOnce(
        stream(
          event('message_start', { message: { id: 'm', content: [] } }),
          event('content_block_start', {
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_1', name: 'search', input: {} },
          }),
          event('content_block_delta', {
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"query":"v' },
          }),
        ),
      );
      await expect(
        round(service, 'claude-opus-5-5', {
          config: ANTHROPIC,
          tools: SEARCH,
          toolChoice: 'auto',
          messages: MESSAGES,
        }),
      ).rejects.toThrow('stopped before it finished');
    });

    it('maps a mid-stream error event to a bounded error', async () => {
      const { service } = makeHarness();
      safeFetchMock.mockResolvedValueOnce(
        stream(
          event('message_start', { message: { id: 'm', content: [] } }),
          event('error', { error: { type: 'overloaded_error', message: 'busy' } }),
        ),
      );
      await expect(
        round(service, 'claude-opus-5-5', { config: ANTHROPIC, messages: MESSAGES }),
      ).rejects.toThrow('LLM endpoint stream error — overloaded_error');
    });
  });
});
