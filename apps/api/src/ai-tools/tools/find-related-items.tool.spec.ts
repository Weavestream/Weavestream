import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { FindRelatedItemsAiTool } from './find-related-items.tool.js';
import type { AiToolExecutionContext } from '../tool-registry.js';
import type { AuthedUser } from '../../common/current-user.decorator.js';

const SOURCE_ID = '4e8c7a52-88a1-4f5e-9b1e-1a2b3c4d5e6f';

function context(): AiToolExecutionContext {
  return {
    actor: { id: 'u-1', role: 'OPERATOR' } as AuthedUser,
    tenant: {} as never,
    correlationId: 'req-1',
    ip: '127.0.0.1',
    userAgent: 'jest',
    conversationId: 'conv-1',
    turnContext: { companyId: 'c-1' } as never,
  };
}

function makeTool(overrides: {
  items?: Array<{ kind: 'asset' | 'article' | 'password'; id: string; title: string; companyId: string }>;
  relationAllowed?: boolean;
} = {}) {
  const search = {
    search: jest.fn(async () => ({
      items: overrides.items ?? [
        { kind: 'asset' as const, id: SOURCE_ID, title: 'ACM-DB01', companyId: 'c-1' },
      ],
    })),
  };
  const related = {
    execute: jest.fn(async () => ({ sourceTitle: 'ACM-DB01', items: [], totalCount: 0 })),
  };
  const permissions = {
    can: jest.fn(async () => ({ allowed: overrides.relationAllowed ?? true })),
  };
  return {
    tool: new FindRelatedItemsAiTool(search as never, related as never, permissions as never),
    search,
    related,
    permissions,
  };
}

describe('FindRelatedItemsAiTool', () => {
  it('resolves the exact named hit and delegates relationship traversal using its own id', async () => {
    const { tool, search, related, permissions } = makeTool();
    const ctx = context();

    await expect(tool.execute(ctx, { query: ' acm-db01 ' })).resolves.toEqual({
      sourceTitle: 'ACM-DB01',
      items: [],
      totalCount: 0,
    });
    expect(search.search).toHaveBeenCalledWith(ctx.actor, {
      q: ' acm-db01 ',
      companyId: 'c-1',
      types: ['asset', 'article', 'password'],
      limit: 10,
    });
    expect(permissions.can).toHaveBeenCalledWith(ctx.actor, 'relation.read', {
      companyId: 'c-1',
    });
    expect(related.execute).toHaveBeenCalledWith(
      ctx,
      { entity_type: 'asset', entity_id: SOURCE_ID, entity_name: 'ACM-DB01' },
      'c-1',
    );
  });

  it('refuses a missing or ambiguous exact name instead of choosing a search hit', async () => {
    const { tool, related } = makeTool({
      items: [
        { kind: 'asset', id: SOURCE_ID, title: 'ACM-DB01', companyId: 'c-1' },
        {
          kind: 'article',
          id: '11111111-1111-4111-8111-111111111111',
          title: 'ACM-DB01',
          companyId: 'c-1',
        },
      ],
    });
    await expect(tool.execute(context(), { query: 'ACM-DB01' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(related.execute).not.toHaveBeenCalled();
  });

  it('requires relation.read before invoking the relationship tool', async () => {
    const { tool, related } = makeTool({ relationAllowed: false });
    await expect(tool.execute(context(), { query: 'ACM-DB01' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(related.execute).not.toHaveBeenCalled();
  });
});
