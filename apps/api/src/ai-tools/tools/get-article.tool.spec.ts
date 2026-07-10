import { NotFoundException } from '@nestjs/common';
import { GetArticleAiTool } from './get-article.tool.js';
import type { AiToolExecutionContext } from '../tool-registry.js';
import type { AuthedUser } from '../../common/current-user.decorator.js';

const ARTICLE_ID = '4e8c7a52-88a1-4f5e-9b1e-1a2b3c4d5e6f';

function article(overrides: Record<string, unknown> = {}) {
  return {
    id: ARTICLE_ID,
    title: 'VPN Setup',
    slug: 'vpn-setup',
    editorMode: 'markdown',
    markdownSource: '# VPN Setup\n\nSteps…',
    content: null,
    contentPlaintext: 'VPN Setup Steps…',
    revision: 7,
    visibleToClients: true,
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

function makeTool(overrides: {
  article?: Record<string, unknown>;
  role?: string;
} = {}) {
  const articles = {
    getById: jest.fn(async () => article(overrides.article)),
  };
  const entityScope = {
    resolveEntityCompany: jest.fn(async () => 'c-1'),
  };
  const prisma = {
    company: { findFirst: jest.fn(async () => ({ slug: 'acme' })) },
  };
   
  const tool = new GetArticleAiTool(articles as any, entityScope as any, prisma as any);
  const ctx: AiToolExecutionContext = {
    actor: { id: 'u-1', role: overrides.role ?? 'OPERATOR' } as AuthedUser,
    tenant: {} as never,
    correlationId: 'req-1',
    ip: '127.0.0.1',
    userAgent: 'jest',
    conversationId: 'conv-1',
    turnContext: null,
  };
  return { tool, ctx, articles, entityScope };
}

function forgeCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

describe('GetArticleAiTool', () => {
  it('resolves the company scope-safely from the article row', async () => {
    const { tool, ctx, entityScope } = makeTool();
    await tool.resolveCompanyId(ctx, { article_id: ARTICLE_ID });
    expect(entityScope.resolveEntityCompany).toHaveBeenCalledWith(
      ctx.tenant,
      'article',
      ARTICLE_ID,
    );
  });

  it('returns a markdown article verbatim with revision, admin href and no truncation', async () => {
    const { tool, ctx } = makeTool();
    const out = await tool.execute(ctx, { article_id: ARTICLE_ID }, 'c-1');
    expect(out).toEqual({
      id: ARTICLE_ID,
      title: 'VPN Setup',
      markdown: '# VPN Setup\n\nSteps…',
      revision: 7,
      href: `/admin/companies/c-1/articles/${ARTICLE_ID}`,
      visibleToClients: true,
      updatedAt: '2026-07-01T00:00:00.000Z',
      truncated: false,
      nextCursor: null,
    });
  });

  it('converts Tiptap articles through the shared walker (structure preserved)', async () => {
    const { tool, ctx } = makeTool({
      article: {
        editorMode: 'tiptap',
        markdownSource: null,
        content: {
          type: 'doc',
          content: [
            { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Steps' }] },
            {
              type: 'bulletList',
              content: [
                {
                  type: 'listItem',
                  content: [
                    { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
    const out = await tool.execute(ctx, { article_id: ARTICLE_ID }, 'c-1');
    expect(out.markdown).toBe('## Steps\n\n- first');
  });

  it('builds portal hrefs with the article slug for client users', async () => {
    const { tool, ctx } = makeTool({ role: 'CLIENT_USER' });
    const out = await tool.execute(ctx, { article_id: ARTICLE_ID }, 'c-1');
    expect(out.href).toBe('/portal/acme/articles/vpn-setup');
  });

  it('chunks long bodies and resumes exactly from its own cursor', async () => {
    const body = 'a'.repeat(45_000);
    const { tool, ctx } = makeTool({ article: { markdownSource: body } });
    const first = await tool.execute(ctx, { article_id: ARTICLE_ID }, 'c-1');
    expect(first.truncated).toBe(true);
    expect(first.markdown).toHaveLength(20_000);
    expect(first.nextCursor).not.toBeNull();

    const second = await tool.execute(
      ctx,
      { article_id: ARTICLE_ID, cursor: first.nextCursor! },
      'c-1',
    );
    expect(second.markdown).toHaveLength(20_000);
    expect(second.truncated).toBe(true);

    const third = await tool.execute(
      ctx,
      { article_id: ARTICLE_ID, cursor: second.nextCursor! },
      'c-1',
    );
    expect(third.markdown).toHaveLength(5_000);
    expect(third.truncated).toBe(false);
    expect(third.nextCursor).toBeNull();
    expect(first.markdown + second.markdown + third.markdown).toBe(body);
  });

  describe('cursor is untrusted input', () => {
    const OTHER_ID = '99999999-9999-4999-9999-999999999999';

    it.each([
      ['garbage', 'not-base64-json'],
      ['wrong article id', forgeCursor({ articleId: OTHER_ID, offset: 0, revision: 7 })],
      [
        'out-of-bounds offset',
        forgeCursor({ articleId: ARTICLE_ID, offset: 1_000_000, revision: 7 }),
      ],
      [
        'revision mismatch (article changed mid-read)',
        forgeCursor({ articleId: ARTICLE_ID, offset: 0, revision: 6 }),
      ],
      [
        'schema violation',
        forgeCursor({ articleId: ARTICLE_ID, offset: -1, revision: 7 }),
      ],
    ])('rejects %s generically', async (_label, cursor) => {
      const { tool, ctx } = makeTool();
      await expect(
        tool.execute(ctx, { article_id: ARTICLE_ID, cursor }, 'c-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('never decodes the cursor before authorization: an unresolved company fails first', async () => {
      const { tool, ctx, articles } = makeTool();
      await expect(
        tool.execute(ctx, { article_id: ARTICLE_ID, cursor: 'garbage' }, null),
      ).rejects.toBeInstanceOf(NotFoundException);
      // The article was never even loaded — nothing to decode against.
      expect(articles.getById).not.toHaveBeenCalled();
    });
  });
});
