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
      baseUrl: 'http://localhost:1',
      apiKey: null,
      defaultModel: 'test-model',
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
