import { randomUUID } from 'node:crypto';
import type { ChatToolCallDto, CreateArticleInput } from '@weavestream/shared';
import { ChatToolCallService } from './chat-tool-call.service.js';
import { ChatService } from './chat.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuditMeta } from '../articles/articles.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * DB-backed proof of the Phase 5b settle claim (W0.4): concurrent
 * apply/reject on one pending tool call must fully serialize on the
 * ownership-constrained `FOR UPDATE` lock, and the `pendingCreate`
 * idempotency marker must survive a crash between article creation and
 * tool-call settlement so a retry can NEVER create a second article —
 * nor relocate the create under newer client input.
 *
 * The unit suite (`chat-tool-call.service.spec.ts`) covers the service
 * wiring against mocks; only a real Postgres can prove the lock
 * serialization and the marker's durability across failed transactions.
 *
 * The articles collaborator here is a thin prisma-backed stub: `create`
 * inserts a REAL row (honoring the explicit-id opts), which is all the
 * claim/idempotency machinery under test touches. The full
 * ArticlesService lifecycle (version row, audit, summary gate) is
 * deliberately out of scope — its wiring is covered by its own suite
 * and by `chat-tool-call.service.spec.ts`.
 *
 * Opt-in via `WEAVESTREAM_RUN_DB_INTEGRATION_TESTS=1` (same gating
 * rationale as `assets.pagination.db.spec.ts`: importing @prisma/client
 * loads the workspace .env, so DATABASE_URL alone would mutate the
 * development database on a bare `pnpm test`). Run locally with:
 *   WEAVESTREAM_RUN_DB_INTEGRATION_TESTS=1 pnpm --filter @weavestream/api test
 */
const describeIfDb =
  process.env.WEAVESTREAM_RUN_DB_INTEGRATION_TESTS === '1' ? describe : describe.skip;

const USER = '5bc00000-0000-4000-8000-00000000a001';
const CO_A = '5bc00000-0000-4000-8000-00000000c001';
const CO_B = '5bc00000-0000-4000-8000-00000000c002';
const CONV = '5bc00000-0000-4000-8000-00000000e001';
const META: AuditMeta = { ip: '127.0.0.1', userAgent: 'db-spec' };

const ACTOR: AuthedUser = {
  id: USER,
  email: 'chat-concurrency-spec@example.com',
  role: 'OPERATOR',
  globalAccess: 'FULL',
  platformCapabilities: [],
  sessionId: '5bc00000-0000-4000-8000-00000000f001',
  mfaEnforcementCompletedAt: null,
  mfaPending: false,
};

const OVERRIDES_A = { title: 'Confirmed title', folderId: null, visibleToClients: true };
const OVERRIDES_B = { title: 'Different title', folderId: null, visibleToClients: false };

function createCall(id: string): ChatToolCallDto {
  return {
    id,
    name: 'create_article',
    arguments: { title: 'Drafted title', markdown: '# Drafted title\n\nBody' },
    status: 'pending',
    result: null,
    error: null,
    errorCode: null,
  };
}

function siblingPatch(id: string): ChatToolCallDto {
  return {
    id,
    name: 'patch_article',
    arguments: {
      article_id: '5bc00000-0000-4000-8000-00000000d0ff',
      edits: [{ old_text: 'a', new_text: 'b' }],
    },
    status: 'pending',
    result: null,
    error: null,
    errorCode: null,
    baseRevision: 3,
    targetCompanyId: CO_A,
  };
}

describeIfDb('chat tool-call settle concurrency (DB integration)', () => {
  const prisma = new PrismaService();
  const chat = new ChatService(prisma);

  // Prisma-backed create: a real row, the explicit id honored — the
  // pieces the marker/recovery contract depends on.
  const articles = {
    findCompanyIdForArticle: async (id: string) => {
      const row = await prisma.article.findUnique({ where: { id }, select: { companyId: true } });
      return row?.companyId ?? null;
    },
    create: jest.fn(
      async (
        _actor: AuthedUser,
        companyId: string,
        input: CreateArticleInput,
        _meta: AuditMeta,
        opts?: { id?: string },
      ) => {
        const id = opts?.id ?? randomUUID();
        return prisma.article.create({
          data: {
            id,
            companyId,
            title: input.title,
            slug: `chat-conc-${id.slice(0, 13)}`,
            editorMode: 'markdown',
            markdownSource: (input as { markdownSource?: string }).markdownSource ?? '',
            contentPlaintext: 'body',
            createdBy: USER,
            updatedBy: USER,
            visibleToClients:
              (input as { visibleToClients?: boolean }).visibleToClients ?? true,
          },
          select: { id: true, title: true },
        });
      },
    ),
    update: jest.fn(),
    getById: jest.fn(),
  };
  const permissions = { can: async () => ({ allowed: true }) };
  const svc = new ChatToolCallService(
    articles as never,
    chat,
    permissions as never,
    prisma,
  );

  let messageSeq = 0;

  /** Seed a fresh assistant message (global turn: turnContext null). */
  async function seedMessage(calls: ChatToolCallDto[]): Promise<string> {
    const id = `5bc00000-0000-4000-8000-0000000${(++messageSeq).toString().padStart(5, '0')}`;
    await prisma.chatMessage.create({
      data: {
        id,
        conversationId: CONV,
        role: 'ASSISTANT',
        content: 'drafted',
        toolCalls: calls as never,
      },
    });
    return id;
  }

  function applyOn(messageId: string, toolCallId: string, companyId: string, overrides = OVERRIDES_A) {
    return svc.apply(ACTOR, {
      conversationId: CONV,
      messageId,
      toolCallId,
      requestCompanyId: companyId,
      createOverrides: overrides,
      auditMeta: META,
    });
  }

  async function loadCalls(messageId: string): Promise<ChatToolCallDto[]> {
    const msg = await chat.getMessageForActor(ACTOR, CONV, messageId);
    return msg.toolCalls ?? [];
  }

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.user.create({
      data: {
        id: USER,
        email: ACTOR.email,
        name: 'Chat Concurrency Spec',
        passwordHash: 'x',
        role: 'OPERATOR',
        globalAccess: 'FULL',
      },
    });
    await prisma.company.createMany({
      data: [
        { id: CO_A, name: 'Chat Conc Spec A', slug: 'chat-conc-spec-a' },
        { id: CO_B, name: 'Chat Conc Spec B', slug: 'chat-conc-spec-b' },
      ],
    });
    await prisma.chatConversation.create({ data: { id: CONV, userId: USER } });
  });

  afterAll(async () => {
    await prisma.article.deleteMany({ where: { companyId: { in: [CO_A, CO_B] } } });
    await prisma.chatConversation.deleteMany({ where: { id: CONV } });
    await prisma.company.deleteMany({ where: { id: { in: [CO_A, CO_B] } } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.$disconnect();
  });

  beforeEach(() => {
    articles.create.mockClear();
  });

  it('two parallel create-applies yield exactly one article and one already-settled 400', async () => {
    const msgId = await seedMessage([createCall('call_par_1')]);

    const results = await Promise.allSettled([
      applyOn(msgId, 'call_par_1', CO_A),
      applyOn(msgId, 'call_par_1', CO_A),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 400 });

    const calls = await loadCalls(msgId);
    expect(calls[0]).toMatchObject({ status: 'applied' });
    const articleId = calls[0]!.pendingCreate!.articleId;
    expect(await prisma.article.count({ where: { id: articleId } })).toBe(1);
    expect(await prisma.article.count({ where: { companyId: CO_A } })).toBe(1);
  });

  it('parallel apply + reject settle exactly once and never clobber a sibling', async () => {
    await prisma.article.deleteMany({ where: { companyId: { in: [CO_A, CO_B] } } });
    const msgId = await seedMessage([createCall('call_ar_1'), siblingPatch('call_ar_2')]);

    const results = await Promise.allSettled([
      applyOn(msgId, 'call_ar_1', CO_A),
      svc.reject(ACTOR, { conversationId: CONV, messageId: msgId, toolCallId: 'call_ar_1' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);

    const calls = await loadCalls(msgId);
    const settled = calls.find((c) => c.id === 'call_ar_1')!;
    expect(['applied', 'rejected']).toContain(settled.status);
    // Reject winning means the apply's main tx saw non-pending BEFORE
    // creating — so no orphan article.
    const expectedArticles = settled.status === 'applied' ? 1 : 0;
    expect(await prisma.article.count({ where: { companyId: CO_A } })).toBe(expectedArticles);

    // The sibling survives both whole-array writes intact (A3 + claim).
    const sibling = calls.find((c) => c.id === 'call_ar_2')!;
    expect(sibling).toMatchObject({
      status: 'pending',
      baseRevision: 3,
      targetCompanyId: CO_A,
    });
  });

  it('failure-injection: a crash between create and settle recovers without a duplicate or relocation', async () => {
    await prisma.article.deleteMany({ where: { companyId: { in: [CO_A, CO_B] } } });
    const msgId = await seedMessage([createCall('call_fi_1')]);

    // Injected crash: the settle write (the SECOND updateMessageToolCalls
    // call — the first is the marker tx) throws after the article row
    // landed.
    const realUpdate = chat.updateMessageToolCalls.bind(chat);
    const spy = jest
      .spyOn(chat, 'updateMessageToolCalls')
      .mockImplementationOnce(realUpdate) // marker write
      .mockImplementationOnce(async () => {
        throw new Error('injected settle crash');
      });

    await expect(applyOn(msgId, 'call_fi_1', CO_A)).rejects.toThrow('injected settle crash');
    spy.mockRestore();

    // The call is still pending, the marker is durable, the article exists.
    let calls = await loadCalls(msgId);
    expect(calls[0]).toMatchObject({ status: 'pending' });
    const marker = calls[0]!.pendingCreate!;
    expect(marker).toMatchObject({ companyId: CO_A, title: OVERRIDES_A.title });
    expect(await prisma.article.count({ where: { id: marker.articleId } })).toBe(1);

    // (b) A retry that picks a DIFFERENT company + overrides is rejected
    // with the stable recovery code — never a second/relocated article.
    await expect(applyOn(msgId, 'call_fi_1', CO_B, OVERRIDES_B)).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: 'article_create_recovery_pending' }),
    });
    expect(await prisma.article.count({ where: { companyId: CO_B } })).toBe(0);
    expect(await prisma.article.count({ where: { companyId: CO_A } })).toBe(1);

    // (c) The marker-locked retry (original confirmation) completes:
    // applied, still exactly one article, no second create call.
    const before = articles.create.mock.calls.length;
    const { toolCall } = await applyOn(msgId, 'call_fi_1', CO_A, OVERRIDES_A);
    expect(toolCall.status).toBe('applied');
    expect(articles.create.mock.calls.length).toBe(before); // recovery, not re-create
    expect(await prisma.article.count({ where: { companyId: CO_A } })).toBe(1);

    calls = await loadCalls(msgId);
    expect(calls[0]).toMatchObject({ status: 'applied' });
  });

  it('a crash BEFORE the create (seeded marker, no article) still pins the intent for the retry', async () => {
    // A process death between the marker tx and the article insert
    // leaves exactly this state: pending call, durable marker, no row.
    // Seed it directly — a thrown create error is a different path (it
    // settles the call as terminal `failed` via the catch-all).
    await prisma.article.deleteMany({ where: { companyId: { in: [CO_A, CO_B] } } });
    const marker = {
      articleId: '5bc00000-0000-4000-8000-00000000d0aa',
      companyId: CO_A,
      title: OVERRIDES_A.title,
      folderId: null,
      visibleToClients: OVERRIDES_A.visibleToClients,
    };
    const msgId = await seedMessage([{ ...createCall('call_pre_1'), pendingCreate: marker }]);

    // (d1) A mismatched retry is rejected — the newer input never wins.
    await expect(applyOn(msgId, 'call_pre_1', CO_B, OVERRIDES_B)).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: 'article_create_recovery_pending' }),
    });
    expect(await prisma.article.count({ where: { companyId: { in: [CO_A, CO_B] } } })).toBe(0);

    // (d2) The marker-locked retry creates under the MARKER's company
    // and values, with the pre-generated id.
    const { toolCall } = await applyOn(msgId, 'call_pre_1', CO_A, OVERRIDES_A);
    expect(toolCall.status).toBe('applied');
    const created = await prisma.article.findUnique({
      where: { id: marker.articleId },
      select: { companyId: true, title: true },
    });
    expect(created).toEqual({ companyId: CO_A, title: OVERRIDES_A.title });
  });
});
