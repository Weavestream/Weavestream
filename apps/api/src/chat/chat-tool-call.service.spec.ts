import { ChatToolCallService } from './chat-tool-call.service.js';
import type { ChatToolCallDto, ChatTurnContext } from '@weavestream/shared';
import type { AuthedUser } from '../common/current-user.decorator.js';

const ACTOR: AuthedUser = {
  id: 'actor-1',
  role: 'OPERATOR',
  globalAccess: null,
  platformCapabilities: [],
  email: 'a@example.com',
  sessionId: 's-1',
  mfaEnforcementCompletedAt: new Date(),
  mfaPending: false,
};
const META = { ip: '127.0.0.1', userAgent: 'jest' };
const CO = 'co-1';
const CO_OTHER = 'co-2';
const ART = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function pendingCall(overrides: Partial<ChatToolCallDto> = {}): ChatToolCallDto {
  return {
    id: 'tc-1',
    name: 'update_article',
    arguments: { article_id: ART, markdown: '# Hi\n\nBody' },
    status: 'pending',
    result: null,
    error: null,
    ...overrides,
  };
}

function pendingPatchCall(overrides: Partial<ChatToolCallDto> = {}): ChatToolCallDto {
  return {
    id: 'tc-1',
    name: 'patch_article',
    arguments: {
      article_id: ART,
      edits: [{ old_text: 'Old text', new_text: 'New text' }],
    },
    status: 'pending',
    result: null,
    error: null,
    baseRevision: 7,
    ...overrides,
  };
}

function makeService(opts: {
  toolCall: ChatToolCallDto | ChatToolCallDto[];
  turnContext: ChatTurnContext | null;
  articleCompanyId?: string | null;
  canWrite?: boolean;
  article?: Record<string, unknown>;
  /** Rows the ownership lock returns; [] simulates a guessed/foreign id. */
  lockRows?: Array<{ id: string }>;
  /** Static claim re-read override — simulates a concurrent settle. */
  claimToolCalls?: unknown[];
  /** Row the pendingCreate recovery lookup finds. */
  recoveredArticle?: { id: string; title: string } | null;
}) {
  // Mutable persisted state: `updateMessageToolCalls` writes land here so
  // the marker tx's write is visible to the subsequent claim, mirroring
  // the real JSONB column.
  const state = {
    toolCalls: (Array.isArray(opts.toolCall)
      ? opts.toolCall
      : [opts.toolCall]) as unknown[],
  };
  const chat = {
    getMessageForActor: jest.fn().mockImplementation(async () => ({
      id: 'msg-1',
      conversationId: 'conv-1',
      role: 'ASSISTANT',
      content: '',
      toolCalls: state.toolCalls,
      turnContext: opts.turnContext,
    })),
    updateMessageToolCalls: jest
      .fn()
      .mockImplementation(async (_id: string, calls: ChatToolCallDto[]) => {
        state.toolCalls = calls;
      }),
  };
  const articles = {
    findCompanyIdForArticle: jest
      .fn()
      .mockResolvedValue(opts.articleCompanyId === undefined ? CO : opts.articleCompanyId),
    update: jest.fn().mockResolvedValue({ title: 'Hi' }),
    create: jest.fn().mockResolvedValue({ title: 'T' }),
    getById: jest.fn().mockResolvedValue(
      opts.article ?? {
        revision: 7,
        editorMode: 'markdown',
        markdownSource: 'Before\n\nOld text\n\nAfter',
        content: null,
      },
    ),
  };
  const permissions = {
    can: jest
      .fn()
      .mockResolvedValue(
        opts.canWrite === false
          ? { allowed: false, reason: 'Missing article.write permission.' }
          : { allowed: true },
      ),
  };
  const txClient = {
    $queryRaw: jest.fn(async () => opts.lockRows ?? [{ id: 'msg-1' }]),
    chatMessage: {
      findFirst: jest.fn(async () => ({
        toolCalls: opts.claimToolCalls ?? state.toolCalls,
      })),
      update: jest.fn(),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txClient)),
    article: {
      findFirst: jest.fn(async () => opts.recoveredArticle ?? null),
    },
  };
  const svc = new ChatToolCallService(
    articles as never,
    chat as never,
    permissions as never,
    prisma as never,
  );
  return { svc, chat, articles, permissions, prisma, txClient, state };
}

function apply(svc: ChatToolCallService, requestCompanyId: string | undefined) {
  return svc.apply(ACTOR, {
    conversationId: 'conv-1',
    messageId: 'msg-1',
    toolCallId: 'tc-1',
    requestCompanyId,
    auditMeta: META,
  });
}

describe('ChatToolCallService.apply', () => {
  it('normalizes strict-mode nulls so the apply does not fail validation', async () => {
    const { svc, articles } = makeService({
      toolCall: pendingCall({
        arguments: { article_id: ART, title: null, markdown: '# Hi\n\nBody', summary: null },
      }),
      turnContext: { companyId: CO },
    });

    const { toolCall } = await apply(svc, CO);

    expect(toolCall.status).toBe('applied');
    expect(articles.update).toHaveBeenCalledTimes(1);
    // Writable company derived from the article row, not the client.
    expect(articles.update).toHaveBeenCalledWith(
      ACTOR,
      CO,
      ART,
      expect.objectContaining({ editorMode: 'markdown' }),
      META,
      { expectedRevision: undefined },
    );
  });

  it('binds to persisted turnContext and ignores a mismatched client companyId', async () => {
    const { svc, articles } = makeService({
      toolCall: pendingCall(),
      turnContext: { companyId: CO },
      articleCompanyId: CO,
    });

    // Client claims a different company than the turn was bound to.
    const { toolCall } = await apply(svc, CO_OTHER);

    // turnContext (CO) wins, matches the article row (CO) → applies.
    expect(toolCall.status).toBe('applied');
    expect(articles.update).toHaveBeenCalledWith(ACTOR, CO, ART, expect.anything(), META, {
      expectedRevision: undefined,
    });
  });

  it('rejects when bound company differs from the article’s real company (IDOR guard)', async () => {
    const { svc, articles } = makeService({
      toolCall: pendingCall(),
      turnContext: { companyId: CO_OTHER }, // forged/stale
      articleCompanyId: CO, // article actually belongs to CO
    });

    const { toolCall } = await apply(svc, CO);

    expect(toolCall.status).toBe('failed');
    expect(toolCall.error).toMatch(/different company/i);
    expect(articles.update).not.toHaveBeenCalled();
  });

  it('still re-checks article.write for create_article (stored scope cannot bypass permission)', async () => {
    const { svc, articles } = makeService({
      toolCall: pendingCall({
        name: 'create_article',
        arguments: { title: 'T', markdown: 'B' },
      }),
      turnContext: { companyId: CO },
      canWrite: false,
    });

    const { toolCall } = await apply(svc, CO);

    expect(toolCall.status).toBe('failed');
    expect(toolCall.error).toMatch(/permission/i);
    expect(articles.create).not.toHaveBeenCalled();
  });

  it('denies an update when article.write was revoked between propose and apply', async () => {
    const { svc, articles } = makeService({
      toolCall: pendingCall(),
      turnContext: { companyId: CO },
      articleCompanyId: CO,
      canWrite: false,
    });

    const { toolCall } = await apply(svc, CO);

    expect(toolCall.status).toBe('failed');
    expect(articles.update).not.toHaveBeenCalled();
  });

  it('falls back to the client companyId for legacy rows without turnContext', async () => {
    const { svc, articles } = makeService({
      toolCall: pendingCall(),
      turnContext: null, // legacy message
      articleCompanyId: CO,
    });

    const { toolCall } = await apply(svc, CO);

    expect(toolCall.status).toBe('applied');
    expect(articles.update).toHaveBeenCalledWith(ACTOR, CO, ART, expect.anything(), META, {
      expectedRevision: undefined,
    });
  });
});

describe('ChatToolCallService.apply — exact article patches', () => {
  it('applies the complete transformed markdown through the guarded update path', async () => {
    const { svc, articles } = makeService({
      toolCall: pendingPatchCall(),
      turnContext: { companyId: CO },
    });

    const { toolCall } = await apply(svc, CO);

    expect(toolCall).toMatchObject({
      status: 'applied',
      result: 'Edited article "Hi".',
    });
    expect(articles.update).toHaveBeenCalledWith(
      ACTOR,
      CO,
      ART,
      {
        editorMode: 'markdown',
        markdownSource: 'Before\n\nNew text\n\nAfter',
      },
      META,
      { expectedRevision: 7 },
    );
  });

  it('supports a title-only patch without converting the article body', async () => {
    const { svc, articles } = makeService({
      toolCall: pendingPatchCall({
        arguments: { article_id: ART, title: 'Renamed', edits: null },
      }),
      turnContext: { companyId: CO },
    });

    const { toolCall } = await apply(svc, CO);

    expect(toolCall.status).toBe('applied');
    expect(articles.update).toHaveBeenCalledWith(ACTOR, CO, ART, { title: 'Renamed' }, META, {
      expectedRevision: 7,
    });
  });

  it('converts a Tiptap article to markdown before applying exact edits', async () => {
    const { svc, articles } = makeService({
      toolCall: pendingPatchCall({
        arguments: {
          article_id: ART,
          edits: [{ old_text: 'Old text', new_text: 'Updated' }],
        },
      }),
      turnContext: { companyId: CO },
      article: {
        revision: 7,
        editorMode: 'tiptap',
        markdownSource: null,
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Old text' }],
            },
          ],
        },
      },
    });

    const { toolCall } = await apply(svc, CO);

    expect(toolCall.status).toBe('applied');
    expect(articles.update).toHaveBeenCalledWith(
      ACTOR,
      CO,
      ART,
      expect.objectContaining({
        editorMode: 'markdown',
        markdownSource: 'Updated',
      }),
      META,
      { expectedRevision: 7 },
    );
  });

  it.each([
    {
      label: 'missing',
      markdown: 'Different text',
      errorCode: 'patch_missing',
    },
    {
      label: 'ambiguous',
      markdown: 'Old text\nOld text',
      errorCode: 'patch_ambiguous',
    },
  ])('rejects $label text without a partial write', async ({ markdown, errorCode }) => {
    const { svc, articles, chat } = makeService({
      toolCall: pendingPatchCall(),
      turnContext: { companyId: CO },
      article: {
        revision: 7,
        editorMode: 'markdown',
        markdownSource: markdown,
        content: null,
      },
    });

    const { toolCall } = await apply(svc, CO);

    expect(toolCall).toMatchObject({ status: 'failed', errorCode });
    expect(articles.update).not.toHaveBeenCalled();
    expect(chat.updateMessageToolCalls).toHaveBeenCalledWith(
      'msg-1',
      expect.arrayContaining([expect.objectContaining({ errorCode })]),
      expect.anything(), // settle writes go through the claim tx
    );
  });

  it('rejects a stale base before attempting the text replacement', async () => {
    const { svc, articles } = makeService({
      toolCall: pendingPatchCall(),
      turnContext: { companyId: CO },
      article: {
        revision: 8,
        editorMode: 'markdown',
        markdownSource: 'Old text',
        content: null,
      },
    });

    const { toolCall } = await apply(svc, CO);

    expect(toolCall).toMatchObject({ status: 'failed', errorCode: 'stale' });
    expect(articles.update).not.toHaveBeenCalled();
  });

  it('never promotes a missing patch target into a new article', async () => {
    const { svc, articles } = makeService({
      toolCall: pendingPatchCall(),
      turnContext: { companyId: CO },
      articleCompanyId: null,
    });

    const { toolCall } = await apply(svc, CO);

    expect(toolCall.status).toBe('failed');
    expect(articles.create).not.toHaveBeenCalled();
    expect(articles.update).not.toHaveBeenCalled();
  });
});

describe('ChatToolCallService.apply — revision guard (WS-030)', () => {
  it('passes a numeric baseRevision through as expectedRevision', async () => {
    const { svc, articles } = makeService({
      toolCall: pendingCall({ baseRevision: 7 }),
      turnContext: { companyId: CO },
    });

    const { toolCall } = await apply(svc, CO);

    expect(toolCall.status).toBe('applied');
    expect(articles.update).toHaveBeenCalledWith(ACTOR, CO, ART, expect.anything(), META, {
      expectedRevision: 7,
    });
  });

  it('maps StaleArticleError to failed/stale with a truthful message', async () => {
    const { svc, articles, chat } = makeService({
      toolCall: pendingCall({ baseRevision: 7 }),
      turnContext: { companyId: CO },
    });
    const { StaleArticleError } = await import('../articles/articles.service.js');
    articles.update.mockRejectedValueOnce(new StaleArticleError());

    const { toolCall } = await apply(svc, CO);

    expect(toolCall.status).toBe('failed');
    expect(toolCall.errorCode).toBe('stale');
    expect(toolCall.error).toMatch(/edited after the proposal/i);
    // The failure is persisted so the card reflects reality.
    expect(chat.updateMessageToolCalls).toHaveBeenCalledWith(
      'msg-1',
      expect.arrayContaining([expect.objectContaining({ errorCode: 'stale' })]),
      expect.anything(), // settle writes go through the claim tx
    );
  });

  it('refuses a null baseRevision when the article now resolves (no_base, never a blind update)', async () => {
    const { svc, articles } = makeService({
      toolCall: pendingCall({ baseRevision: null }),
      turnContext: { companyId: CO },
      articleCompanyId: CO, // article exists now
    });

    const { toolCall } = await apply(svc, CO);

    expect(toolCall.status).toBe('failed');
    expect(toolCall.errorCode).toBe('no_base');
    expect(toolCall.error).toMatch(/not based on the article/i);
    expect(articles.update).not.toHaveBeenCalled();
  });

  it('null baseRevision still serves the Save-as-article promotion when the article is gone', async () => {
    const { svc, articles } = makeService({
      toolCall: pendingCall({ baseRevision: null }),
      turnContext: { companyId: CO },
      articleCompanyId: null, // hallucinated id — not found
    });

    const { toolCall } = await svc.apply(ACTOR, {
      conversationId: 'conv-1',
      messageId: 'msg-1',
      toolCallId: 'tc-1',
      requestCompanyId: CO,
      createOverrides: { title: 'Chosen', folderId: null, visibleToClients: true },
      auditMeta: META,
    });

    expect(toolCall.status).toBe('applied');
    expect(articles.create).toHaveBeenCalledTimes(1);
    expect(articles.update).not.toHaveBeenCalled();
  });

  it('legacy rows without the baseRevision field apply unguarded, exactly as before', async () => {
    const { svc, articles } = makeService({
      toolCall: pendingCall(), // field absent
      turnContext: { companyId: CO },
    });

    const { toolCall } = await apply(svc, CO);

    expect(toolCall.status).toBe('applied');
    expect(articles.update).toHaveBeenCalledWith(ACTOR, CO, ART, expect.anything(), META, {
      expectedRevision: undefined,
    });
  });

  it('a missing update target WITHOUT a confirmed create settles failed, never a silent create', async () => {
    const { svc, articles } = makeService({
      toolCall: pendingCall({ baseRevision: null }),
      turnContext: { companyId: CO },
      articleCompanyId: null, // hallucinated id — not found
    });

    const { toolCall } = await apply(svc, CO); // no createOverrides

    expect(toolCall.status).toBe('failed');
    expect(toolCall.error).toMatch(/not found/i);
    expect(articles.create).not.toHaveBeenCalled();
    expect(articles.update).not.toHaveBeenCalled();
  });
});

describe('ChatToolCallService — ownership-constrained settle claim (5b W0.4)', () => {
  // The marker round-trips through the zod-validated parser, so these
  // tests need a REAL uuid company scope (unlike the legacy 'co-1'
  // shorthand above, which never crosses the parser).
  const CO_UUID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const MARKER = {
    articleId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    companyId: CO_UUID,
    title: 'Chosen',
    folderId: null,
    visibleToClients: true,
  };

  function createCall(overrides: Partial<ChatToolCallDto> = {}): ChatToolCallDto {
    return pendingCall({
      name: 'create_article',
      arguments: { title: 'Drafted title', markdown: '# Drafted title\n\nBody' },
      ...overrides,
    });
  }

  function applyCreate(
    svc: ChatToolCallService,
    overrides: { title: string; folderId: string | null; visibleToClients: boolean } | undefined,
  ) {
    return svc.apply(ACTOR, {
      conversationId: 'conv-1',
      messageId: 'msg-1',
      toolCallId: 'tc-1',
      requestCompanyId: CO_UUID,
      ...(overrides ? { createOverrides: overrides } : {}),
      auditMeta: META,
    });
  }

  it('locks through one statement carrying message + conversation + owning user', async () => {
    const { svc, txClient } = makeService({
      toolCall: pendingCall(),
      turnContext: { companyId: CO },
    });

    await apply(svc, CO);

    const sqlArg = (txClient.$queryRaw.mock.calls[0] as unknown[])[0] as {
      sql: string;
      values: unknown[];
    };
    expect(sqlArg.sql).toContain('FOR UPDATE OF m');
    expect(sqlArg.sql).toContain('c.user_id');
    expect(sqlArg.sql).toContain('m.conversation_id');
    expect(sqlArg.values).toEqual(expect.arrayContaining(['msg-1', 'conv-1', ACTOR.id]));
  });

  it('a zero-row lock (guessed/foreign id) 404s without doing any work', async () => {
    const { svc, articles, chat } = makeService({
      toolCall: pendingCall(),
      turnContext: { companyId: CO },
      lockRows: [],
    });

    await expect(apply(svc, CO)).rejects.toMatchObject({ status: 404 });
    expect(articles.update).not.toHaveBeenCalled();
    expect(chat.updateMessageToolCalls).not.toHaveBeenCalled();
  });

  it('the claim loser sees the committed settle and gets the already-settled 400', async () => {
    const { svc, articles, chat } = makeService({
      toolCall: pendingCall(),
      turnContext: { companyId: CO },
      // The pre-check read still sees pending; the locked re-read sees
      // the concurrent winner's committed apply.
      claimToolCalls: [pendingCall({ status: 'applied' })],
    });

    await expect(apply(svc, CO)).rejects.toMatchObject({ status: 400 });
    expect(articles.update).not.toHaveBeenCalled();
    expect(chat.updateMessageToolCalls).not.toHaveBeenCalled();
  });

  it('reject also claims: loser gets 400, winner persists rejected through the tx', async () => {
    const { svc, chat, txClient } = makeService({
      toolCall: pendingCall(),
      turnContext: { companyId: CO },
    });

    const { toolCall } = await svc.reject(ACTOR, {
      conversationId: 'conv-1',
      messageId: 'msg-1',
      toolCallId: 'tc-1',
    });

    expect(toolCall.status).toBe('rejected');
    expect(chat.updateMessageToolCalls).toHaveBeenCalledWith(
      'msg-1',
      expect.arrayContaining([expect.objectContaining({ status: 'rejected' })]),
      txClient,
    );

    const { svc: loser } = makeService({
      toolCall: pendingCall(),
      turnContext: { companyId: CO },
      claimToolCalls: [pendingCall({ status: 'rejected' })],
    });
    await expect(
      loser.reject(ACTOR, { conversationId: 'conv-1', messageId: 'msg-1', toolCallId: 'tc-1' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('apply/reject persist a targetCompanyId-bearing sibling without stripping it', async () => {
    const sibling = pendingCall({
      id: 'tc-2',
      status: 'pending',
      baseRevision: 4,
      targetCompanyId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    });
    const { svc, chat } = makeService({
      toolCall: [pendingCall(), sibling],
      turnContext: { companyId: CO },
    });

    await apply(svc, CO);

    const written = chat.updateMessageToolCalls.mock.calls[0]![1] as ChatToolCallDto[];
    const persistedSibling = written.find((c) => c.id === 'tc-2');
    expect(persistedSibling).toMatchObject({
      targetCompanyId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      baseRevision: 4,
      status: 'pending',
    });
  });

  it('stamps pendingCreate from the resolved intent BEFORE creating, then creates with its id', async () => {
    const { svc, articles, chat } = makeService({
      toolCall: createCall(),
      turnContext: { companyId: CO_UUID },
    });

    const { toolCall } = await applyCreate(svc, {
      title: 'Chosen',
      folderId: null,
      visibleToClients: false,
    });

    expect(toolCall.status).toBe('applied');
    // First write = the marker tx, before any article work.
    const markerWrite = chat.updateMessageToolCalls.mock.calls[0]![1] as ChatToolCallDto[];
    const marker = markerWrite.find((c) => c.id === 'tc-1')?.pendingCreate;
    expect(marker).toMatchObject({
      companyId: CO_UUID,
      title: 'Chosen',
      folderId: null,
      visibleToClients: false,
    });
    expect(articles.create).toHaveBeenCalledWith(
      ACTOR,
      CO_UUID,
      expect.objectContaining({ title: 'Chosen', visibleToClients: false }),
      META,
      { id: marker!.articleId },
    );
    // The marker-tx write happened strictly before the create.
    expect(chat.updateMessageToolCalls.mock.invocationCallOrder[0]!).toBeLessThan(
      articles.create.mock.invocationCallOrder[0]!,
    );
  });

  it('rejects a mismatched retry with the stable recovery code and does no article work', async () => {
    const { svc, articles } = makeService({
      toolCall: createCall({ pendingCreate: MARKER }),
      turnContext: { companyId: CO_UUID },
    });

    const attempt = applyCreate(svc, {
      title: 'Different title',
      folderId: null,
      visibleToClients: true,
    });
    await expect(attempt).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: 'article_create_recovery_pending' }),
    });
    expect(articles.create).not.toHaveBeenCalled();
  });

  it('a matching retry reuses the existing marker id instead of minting a new one', async () => {
    const { svc, articles } = makeService({
      toolCall: createCall({ pendingCreate: MARKER }),
      turnContext: { companyId: CO_UUID },
    });

    const { toolCall } = await applyCreate(svc, {
      title: 'Chosen',
      folderId: null,
      visibleToClients: true,
    });

    expect(toolCall.status).toBe('applied');
    expect(articles.create).toHaveBeenCalledWith(
      ACTOR,
      CO_UUID,
      expect.anything(),
      META,
      { id: MARKER.articleId },
    );
  });

  it('recovery: an already-created marker article settles applied without a second create', async () => {
    const { svc, articles, prisma } = makeService({
      toolCall: createCall({ pendingCreate: MARKER }),
      turnContext: { companyId: CO_UUID },
      recoveredArticle: { id: MARKER.articleId, title: 'Chosen' },
    });

    const { toolCall } = await applyCreate(svc, {
      title: 'Chosen',
      folderId: null,
      visibleToClients: true,
    });

    expect(toolCall.status).toBe('applied');
    expect(toolCall.result).toBe('Created article "Chosen".');
    expect(articles.create).not.toHaveBeenCalled();
    // Lookup is actor/company-scoped — never a bare findUnique by id.
    expect(prisma.article.findFirst).toHaveBeenCalledWith({
      where: { id: MARKER.articleId, companyId: CO_UUID, createdBy: ACTOR.id },
      select: { id: true, title: true },
    });
  });

  it('reject on a marker whose article EXISTS settles the truth: applied, never hidden', async () => {
    // The crash-recovery state: a prior apply created the article but
    // died before settling. Rejecting must not report "rejected" while
    // the created (possibly client-visible) article stands.
    const { svc, prisma, chat } = makeService({
      toolCall: createCall({ pendingCreate: MARKER }),
      turnContext: { companyId: CO_UUID },
      recoveredArticle: { id: MARKER.articleId, title: 'Chosen' },
    });

    const { toolCall } = await svc.reject(ACTOR, {
      conversationId: 'conv-1',
      messageId: 'msg-1',
      toolCallId: 'tc-1',
    });

    expect(toolCall.status).toBe('applied');
    expect(toolCall.result).toBe('Created article "Chosen".');
    expect(prisma.article.findFirst).toHaveBeenCalledWith({
      where: { id: MARKER.articleId, companyId: CO_UUID, createdBy: ACTOR.id },
      select: { id: true, title: true },
    });
    expect(chat.updateMessageToolCalls).toHaveBeenCalledWith(
      'msg-1',
      expect.arrayContaining([expect.objectContaining({ status: 'applied' })]),
      expect.anything(),
    );
  });

  it('reject on a marker whose article does NOT exist rejects normally (pre-create crash)', async () => {
    const { svc, articles } = makeService({
      toolCall: createCall({ pendingCreate: MARKER }),
      turnContext: { companyId: CO_UUID },
      recoveredArticle: null,
    });

    const { toolCall } = await svc.reject(ACTOR, {
      conversationId: 'conv-1',
      messageId: 'msg-1',
      toolCallId: 'tc-1',
    });

    expect(toolCall.status).toBe('rejected');
    expect(articles.create).not.toHaveBeenCalled();
  });

  it('the update create-promotion also runs through the marker path', async () => {
    const { svc, articles, chat } = makeService({
      toolCall: pendingCall({ baseRevision: null }),
      turnContext: { companyId: CO_UUID },
      articleCompanyId: null, // hallucinated target
    });

    const { toolCall } = await svc.apply(ACTOR, {
      conversationId: 'conv-1',
      messageId: 'msg-1',
      toolCallId: 'tc-1',
      requestCompanyId: CO_UUID,
      createOverrides: { title: 'Promoted', folderId: null, visibleToClients: true },
      auditMeta: META,
    });

    expect(toolCall.status).toBe('applied');
    const markerWrite = chat.updateMessageToolCalls.mock.calls[0]![1] as ChatToolCallDto[];
    const marker = markerWrite.find((c) => c.id === 'tc-1')?.pendingCreate;
    expect(marker).toMatchObject({ companyId: CO_UUID, title: 'Promoted' });
    expect(articles.create).toHaveBeenCalledWith(
      ACTOR,
      CO_UUID,
      expect.objectContaining({ title: 'Promoted' }),
      META,
      { id: marker!.articleId },
    );
  });
});
