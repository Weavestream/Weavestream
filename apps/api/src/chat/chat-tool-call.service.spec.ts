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

function makeService(opts: {
  toolCall: ChatToolCallDto;
  turnContext: ChatTurnContext | null;
  articleCompanyId?: string | null;
  canWrite?: boolean;
}) {
  const chat = {
    getMessageForActor: jest.fn().mockResolvedValue({
      id: 'msg-1',
      conversationId: 'conv-1',
      role: 'ASSISTANT',
      content: '',
      toolCalls: [opts.toolCall],
      turnContext: opts.turnContext,
    }),
    updateMessageToolCalls: jest.fn().mockResolvedValue(undefined),
  };
  const articles = {
    findCompanyIdForArticle: jest
      .fn()
      .mockResolvedValue(
        opts.articleCompanyId === undefined ? CO : opts.articleCompanyId,
      ),
    update: jest.fn().mockResolvedValue({ title: 'Hi' }),
    create: jest.fn().mockResolvedValue({ title: 'T' }),
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
  const svc = new ChatToolCallService(
    articles as never,
    chat as never,
    permissions as never,
  );
  return { svc, chat, articles, permissions };
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
    expect(articles.update).toHaveBeenCalledWith(
      ACTOR,
      CO,
      ART,
      expect.anything(),
      META,
    );
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
    expect(articles.update).toHaveBeenCalledWith(
      ACTOR,
      CO,
      ART,
      expect.anything(),
      META,
    );
  });
});
