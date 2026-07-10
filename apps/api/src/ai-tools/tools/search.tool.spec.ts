import { SearchAiTool } from './search.tool.js';
import type { AiToolExecutionContext } from '../tool-registry.js';
import type { AuthedUser } from '../../common/current-user.decorator.js';

const HIT = {
  kind: 'article' as const,
  id: '4e8c7a52-88a1-4f5e-9b1e-1a2b3c4d5e6f',
  title: 'Backup rotation',
  snippet: 'rotate the &lt;tape&gt; <mark>backup</mark> &amp; verify',
  companyId: 'c-1',
  companyName: 'Acme',
  companySlug: 'acme',
  updatedAt: '2026-07-01T00:00:00.000Z',
  archivedAt: null,
  href: '/admin/companies/c-1/articles/4e8c7a52-88a1-4f5e-9b1e-1a2b3c4d5e6f',
  layoutIcon: null,
  layoutColor: null,
  layoutName: null,
  folderId: null,
  slug: 'backup-rotation',
  thumbnailUrl: null,
  mimeType: null,
  score: 1.0,
};

function ctx(turnCompanyId?: string): AiToolExecutionContext {
  return {
    actor: { id: 'u-1', role: 'OPERATOR' } as AuthedUser,
    tenant: {} as never,
    correlationId: 'req-1',
    ip: '127.0.0.1',
    userAgent: 'jest',
    conversationId: 'conv-1',
    turnContext: turnCompanyId ? ({ companyId: turnCompanyId } as never) : null,
  };
}

describe('SearchAiTool', () => {
  it('is self-scoped (SearchService owns tenant scoping at the query layer)', async () => {
    const tool = new SearchAiTool({ search: jest.fn() } as never);
    await expect(tool.resolveCompanyId()).resolves.toBe('self-scoped');
  });

  it('narrows to the turn company, clamps the limit, and strips snippet markup', async () => {
    const search = jest.fn(async () => ({
      items: [HIT],
      total: 1,
      companyId: 'c-1',
      comprehensive: false,
      includeArchived: false,
    }));
    const tool = new SearchAiTool({ search } as never);
    const out = await tool.execute(ctx('c-1'), {
      query: 'backup',
      types: ['article'],
      limit: 99,
    });
    expect(search).toHaveBeenCalledWith(expect.anything(), {
      q: 'backup',
      companyId: 'c-1',
      types: ['article'],
      limit: 10,
    });
    expect(out.results).toEqual([
      {
        kind: 'article',
        id: HIT.id,
        title: 'Backup rotation',
        // <mark> dropped, entities unescaped, nothing else leaks.
        snippet: 'rotate the <tape> backup & verify',
        companyName: 'Acme',
        href: HIT.href,
        updatedAt: HIT.updatedAt,
      },
    ]);
  });

  it('defaults the limit to 5 and searches the full allowed scope without a turn company', async () => {
    const search = jest.fn(async () => ({
      items: [],
      total: 0,
      companyId: null,
      comprehensive: false,
      includeArchived: false,
    }));
    const tool = new SearchAiTool({ search } as never);
    await tool.execute(ctx(), { query: 'anything' });
    expect(search).toHaveBeenCalledWith(expect.anything(), {
      q: 'anything',
      companyId: undefined,
      types: undefined,
      limit: 5,
    });
  });
});
