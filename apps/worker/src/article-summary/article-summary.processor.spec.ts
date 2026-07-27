import { AiCompletionHttpError } from '../../../api/src/ai/ai-completion.service.js';
import { AiNotConfiguredError } from '../../../api/src/ai/ai-settings.service.js';
import { articleSummaryJobId } from '@weavestream/shared';
import { ArticleSummaryWorker } from './article-summary.processor.js';

interface FakeArticle {
  id: string;
  companyId: string;
  revision: number;
  title: string;
  contentPlaintext: string;
  archivedAt: Date | null;
  aiSummary: string | null;
  aiSummaryModel: string | null;
  aiSummaryAt: Date | null;
  updatedAt: Date;
  /** An in-progress autosave draft exists (ArticleVersion isDraft row). */
  hasDraft: boolean;
}

function makeRow(over: Partial<FakeArticle> = {}): FakeArticle {
  return {
    id: 'a0000000-0000-4000-8000-0000000000a1',
    companyId: 'c0000000-0000-4000-8000-0000000000c1',
    revision: 3,
    title: 'Switch replacement runbook',
    contentPlaintext: 'Step one: photograph the patch panel. '.repeat(40),
    archivedAt: null,
    aiSummary: null,
    aiSummaryModel: null,
    aiSummaryAt: null,
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    hasDraft: false,
    ...over,
  };
}

/** Emulate the Prisma relation filter `versions: { none: { isDraft: true } }`. */
function passesDraftFilter(
  row: FakeArticle,
  where: { versions?: { none?: { isDraft?: boolean } } },
): boolean {
  if (where.versions?.none?.isDraft !== true) return true;
  return !row.hasDraft;
}

function makeWorker(opts: {
  rows?: FakeArticle[];
  gateOn?: boolean;
  config?: Partial<{
    baseUrl: string;
    apiKey: string | null;
    defaultModel: string | null;
    maxOutputTokens: number;
    contextWindowTokens: number;
    allowPrivateNetwork: boolean;
  }> | null;
  completeImpl?: jest.Mock;
  /** jobId → BullMQ-ish job stub for the sweep's getJob. */
  existingJobs?: Record<string, { isFailed: () => Promise<boolean>; retry: jest.Mock }>;
}) {
  const rows = opts.rows ?? [];

  const findFirst = jest.fn(
    async (args: {
      where: {
        id: string;
        companyId: string;
        archivedAt: null;
        aiSummaryAt: null;
        versions?: { none?: { isDraft?: boolean } };
      };
    }) => {
      const r = rows.find(
        (x) =>
          x.id === args.where.id &&
          x.companyId === args.where.companyId &&
          x.archivedAt === null &&
          x.aiSummaryAt === null &&
          passesDraftFilter(x, args.where),
      );
      return r
        ? {
            revision: r.revision,
            title: r.title,
            contentPlaintext: r.contentPlaintext,
          }
        : null;
    },
  );

  const findMany = jest.fn(
    async (args: {
      take: number;
      where: { versions?: { none?: { isDraft?: boolean } } };
    }) =>
      rows
        .filter(
          (r) =>
            r.aiSummaryAt === null &&
            r.archivedAt === null &&
            passesDraftFilter(r, args.where),
        )
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
        .slice(0, args.take)
        .map((r) => ({ id: r.id, companyId: r.companyId, revision: r.revision })),
  );

  const updateMany = jest.fn(
    async (args: {
      where: {
        id: string;
        companyId: string;
        revision: number;
        archivedAt: null;
        aiSummaryAt: null;
      };
      data: { aiSummary: string | null; aiSummaryModel: string | null; aiSummaryAt: Date };
    }) => {
      const targets = rows.filter(
        (r) =>
          r.id === args.where.id &&
          r.companyId === args.where.companyId &&
          r.revision === args.where.revision &&
          r.archivedAt === null &&
          r.aiSummaryAt === null,
      );
      for (const r of targets) {
        r.aiSummary = args.data.aiSummary;
        r.aiSummaryModel = args.data.aiSummaryModel;
        r.aiSummaryAt = args.data.aiSummaryAt;
      }
      return { count: targets.length };
    },
  );

  const prisma = { article: { findFirst, findMany, updateMany } };

  const config =
    opts.config === null
      ? null
      : {
          baseUrl: 'http://ollama.lan:11434/v1',
          apiKey: null,
          defaultModel: 'llama3',
          maxOutputTokens: 8192,
          contextWindowTokens: 32768,
          allowPrivateNetwork: true,
          ...opts.config,
        };
  const aiSettings = {
    isAutoSummariesEnabled: jest.fn().mockResolvedValue(opts.gateOn ?? true),
    getConfig: jest.fn(async () => {
      if (!config) throw new AiNotConfiguredError('AI integration is disabled.');
      return config;
    }),
  };

  const complete =
    opts.completeImpl ?? jest.fn().mockResolvedValue('A concise summary.');
  const completion = { complete };

  const getJob = jest.fn(async (jobId: string) => opts.existingJobs?.[jobId] ?? null);
  const enqueueArticleSummary = jest.fn().mockResolvedValue('job-1');
  const queues = {
    get: jest.fn(() => ({ getJob })),
    enqueueArticleSummary,
  };

  const worker = new ArticleSummaryWorker(
    { bullmqConnection: () => ({}) } as never,
    prisma as never,
    aiSettings as never,
    completion as never,
    queues as never,
  );

  return {
    worker,
    rows,
    findFirst,
    findMany,
    updateMany,
    complete,
    getJob,
    enqueueArticleSummary,
    aiSettings,
  };
}

function payloadFor(row: FakeArticle, revision = row.revision) {
  return {
    kind: 'generate' as const,
    articleId: row.id,
    companyId: row.companyId,
    revision,
  };
}

/** Extract what the worker actually sent as article content. */
function sentContent(complete: jest.Mock, call = 0): string {
  const user: string = complete.mock.calls[call]![1].user;
  const m = /<article_content>([\s\S]*)<\/article_content>/.exec(user);
  return m?.[1] ?? '';
}

describe('ArticleSummaryWorker.generate', () => {
  it('skips before any read or egress when the gate is off', async () => {
    const row = makeRow();
    const ctx = makeWorker({ rows: [row], gateOn: false });
    const out = await ctx.worker.generate(payloadFor(row));
    expect(out.outcome).toBe('ai_disabled');
    expect(ctx.findFirst).not.toHaveBeenCalled();
    expect(ctx.complete).not.toHaveBeenCalled();
  });

  it('a stray job against a settled row skips without reading content or egressing', async () => {
    const row = makeRow({ aiSummaryAt: new Date() });
    const ctx = makeWorker({ rows: [row] });
    const out = await ctx.worker.generate(payloadFor(row));
    expect(out.outcome).toBe('not_pending');
    expect(ctx.complete).not.toHaveBeenCalled();
    // The pending predicate lives in the READ, not app code.
    expect(ctx.findFirst.mock.calls[0]![0].where.aiSummaryAt).toBeNull();
  });

  it('a draft-held row is ineligible in the READ predicate: no content, no egress, no stamp', async () => {
    // Autosave wrote the draft body into the live columns and bumped
    // revision while the row was still pending — summarizing now would
    // egress and store never-published text.
    const row = makeRow({ hasDraft: true });
    const ctx = makeWorker({ rows: [row] });
    const out = await ctx.worker.generate(payloadFor(row));
    expect(out.outcome).toBe('not_pending');
    expect(ctx.complete).not.toHaveBeenCalled();
    // Stays pending: Save-promote re-arms it, discard hands it back to
    // the sweep with the published body restored.
    expect(row.aiSummaryAt).toBeNull();
    expect(ctx.findFirst.mock.calls[0]![0].where.versions).toEqual({
      none: { isDraft: true },
    });
  });

  it('skips superseded revisions before egress', async () => {
    const row = makeRow({ revision: 5 });
    const ctx = makeWorker({ rows: [row] });
    const out = await ctx.worker.generate(payloadFor(row, 4));
    expect(out.outcome).toBe('superseded');
    expect(ctx.complete).not.toHaveBeenCalled();
    // Superseded rows are the newer job's business — no stamp.
    expect(row.aiSummaryAt).toBeNull();
  });

  it('stores a sanitized summary via the fully-guarded predicate', async () => {
    const row = makeRow();
    const ctx = makeWorker({
      rows: [row],
      completeImpl: jest
        .fn()
        .mockResolvedValue('<think>secret plan</think>**Photograph** the panel first.'),
    });
    const out = await ctx.worker.generate(payloadFor(row));
    expect(out.outcome).toBe('stored');

    const where = ctx.updateMany.mock.calls[0]![0].where;
    expect(where).toEqual({
      id: row.id,
      companyId: row.companyId,
      revision: row.revision,
      archivedAt: null,
      aiSummaryAt: null,
    });
    expect(row.aiSummary).toBe('Photograph the panel first.');
    expect(row.aiSummary).not.toContain('think');
    expect(row.aiSummaryModel).toBe('llama3');
    expect(row.aiSummaryAt).toBeInstanceOf(Date);
  });

  it('the prompt never names an output language (gpt-5-mini language-lottery regression)', async () => {
    // Any language-choice clause ("in the article's own language", "in
    // the same language as the text") made gpt-5.4-mini answer English
    // articles in random languages; silence makes it mirror the input.
    const row = makeRow();
    const ctx = makeWorker({ rows: [row] });
    await ctx.worker.generate(payloadFor(row));
    const { system, user } = ctx.complete.mock.calls[0]![1];
    expect(system).not.toMatch(/language|translat/i);
    expect(user).not.toMatch(/language|translat/i);
  });

  it('stamps settled-without-summary when content is empty', async () => {
    const row = makeRow({ contentPlaintext: '   ' });
    const ctx = makeWorker({ rows: [row] });
    const out = await ctx.worker.generate(payloadFor(row));
    expect(out.outcome).toBe('stamped_empty');
    expect(ctx.complete).not.toHaveBeenCalled();
    expect(row.aiSummary).toBeNull();
    expect(row.aiSummaryAt).toBeInstanceOf(Date);
  });

  it('budgets input at 1 char/token: a 4K window sends at most 2816 chars', async () => {
    const row = makeRow({ contentPlaintext: 'x'.repeat(10_000) });
    const ctx = makeWorker({ rows: [row], config: { contextWindowTokens: 4096 } });
    await ctx.worker.generate(payloadFor(row));
    expect(sentContent(ctx.complete).length).toBe(4096 - 1024 - 256);
  });

  it('the minimum allowed 1024-token window skips-with-stamp instead of sending garbage', async () => {
    const row = makeRow();
    const ctx = makeWorker({ rows: [row], config: { contextWindowTokens: 1024 } });
    const out = await ctx.worker.generate(payloadFor(row));
    expect(out.outcome).toBe('window_too_small');
    expect(ctx.complete).not.toHaveBeenCalled();
    expect(row.aiSummaryAt).toBeInstanceOf(Date);
  });

  it('a context-length rejection retries once at half the input, then stamps terminal', async () => {
    const row = makeRow({ contentPlaintext: 'y'.repeat(8_000) });
    const complete = jest
      .fn()
      .mockRejectedValue(
        new AiCompletionHttpError(400, 'maximum context length exceeded'),
      );
    const ctx = makeWorker({ rows: [row], completeImpl: complete });
    const out = await ctx.worker.generate(payloadFor(row));

    expect(out.outcome).toBe('context_rejected');
    expect(complete).toHaveBeenCalledTimes(2);
    const first = sentContent(complete, 0).length;
    const second = sentContent(complete, 1).length;
    expect(second).toBe(Math.floor(first / 2));
    expect(row.aiSummaryAt).toBeInstanceOf(Date);
    expect(row.aiSummary).toBeNull();
  });

  it('transport/5xx errors rethrow for BullMQ retries and leave the row pending', async () => {
    const row = makeRow();
    const ctx = makeWorker({
      rows: [row],
      completeImpl: jest
        .fn()
        .mockRejectedValue(new AiCompletionHttpError(503, 'upstream busy')),
    });
    await expect(ctx.worker.generate(payloadFor(row))).rejects.toBeInstanceOf(
      AiCompletionHttpError,
    );
    expect(row.aiSummaryAt).toBeNull();
  });

  it('reports stale when a concurrent edit re-cleared the row mid-flight', async () => {
    const row = makeRow();
    const ctx = makeWorker({ rows: [row] });
    // Simulate the concurrent edit landing between the read and the
    // write-back: revision moves on, so the guarded predicate matches 0.
    ctx.complete.mockImplementation(async () => {
      row.revision += 1;
      return 'Summary of an old body.';
    });
    const out = await ctx.worker.generate(payloadFor(row));
    expect(out.outcome).toBe('stale');
    expect(row.aiSummary).toBeNull();
  });
});

describe('ArticleSummaryWorker.sweep', () => {
  it('no-ops entirely while the gate is off', async () => {
    const ctx = makeWorker({ rows: [makeRow()], gateOn: false });
    const out = await ctx.worker.sweep();
    expect(out).toEqual({ enqueued: 0, recovered: 0, skipped: 0 });
    expect(ctx.findMany).not.toHaveBeenCalled();
  });

  it('drains pending rows with colon-free deterministic job ids, capped at the batch size', async () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      makeRow({
        id: `a0000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`,
        updatedAt: new Date(2026, 0, 1 + i),
      }),
    );
    const ctx = makeWorker({ rows });
    const out = await ctx.worker.sweep();

    expect(out.enqueued).toBe(25);
    expect(ctx.findMany.mock.calls[0]![0].take).toBe(25);
    for (const [jobId] of ctx.getJob.mock.calls) {
      expect(jobId).not.toContain(':');
      expect(jobId).toMatch(/^article-summary-a0000000-.*-3$/);
    }
  });

  it('never enqueues a draft-held row — the hold rides the sweep WHERE, not batch slots', async () => {
    const held = makeRow({
      id: 'a0000000-0000-4000-8000-00000000d4a1',
      hasDraft: true,
    });
    const fresh = makeRow({ id: 'a0000000-0000-4000-8000-00000000c1ea' });
    const ctx = makeWorker({ rows: [held, fresh] });
    const out = await ctx.worker.sweep();
    expect(out.enqueued).toBe(1);
    expect(ctx.enqueueArticleSummary).toHaveBeenCalledTimes(1);
    expect(ctx.enqueueArticleSummary).toHaveBeenCalledWith(
      expect.objectContaining({ articleId: fresh.id }),
    );
    expect(ctx.findMany.mock.calls[0]![0].where.versions).toEqual({
      none: { isDraft: true },
    });
  });

  it('recovers a retained FAILED job via retry() instead of a deduped re-add, and leaves queued jobs alone', async () => {
    const failedRow = makeRow({ id: 'a0000000-0000-4000-8000-00000000fa11' });
    const queuedRow = makeRow({ id: 'a0000000-0000-4000-8000-00000000dead' });
    const freshRow = makeRow({ id: 'a0000000-0000-4000-8000-00000000f0e5' });
    const retry = jest.fn().mockResolvedValue(undefined);
    const ctx = makeWorker({
      rows: [failedRow, queuedRow, freshRow],
      existingJobs: {
        [articleSummaryJobId(failedRow.id, failedRow.revision)]: {
          isFailed: async () => true,
          retry,
        },
        [articleSummaryJobId(queuedRow.id, queuedRow.revision)]: {
          isFailed: async () => false,
          retry: jest.fn(),
        },
      },
    });

    const out = await ctx.worker.sweep();
    expect(out).toEqual({ enqueued: 1, recovered: 1, skipped: 1 });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(ctx.enqueueArticleSummary).toHaveBeenCalledTimes(1);
    expect(ctx.enqueueArticleSummary).toHaveBeenCalledWith({
      kind: 'generate',
      articleId: freshRow.id,
      companyId: freshRow.companyId,
      revision: freshRow.revision,
    });
  });
});

describe('ArticleSummaryWorker payload boundary', () => {
  it('throws on an invalid payload', async () => {
    const ctx = makeWorker({});
    const handle = (
      ctx.worker as unknown as {
        handle: (job: { data: unknown }) => Promise<unknown>;
      }
    ).handle.bind(ctx.worker);
    await expect(handle({ data: { kind: 'nonsense' } })).rejects.toThrow(
      /invalid article-summary payload/,
    );
  });
});
