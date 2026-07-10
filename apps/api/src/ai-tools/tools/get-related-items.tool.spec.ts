import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { GetRelatedItemsAiTool } from './get-related-items.tool.js';
import type { AiToolExecutionContext } from '../tool-registry.js';
import type { AuthedUser } from '../../common/current-user.decorator.js';

const SOURCE_ID = '4e8c7a52-88a1-4f5e-9b1e-1a2b3c4d5e6f';
const REL_ASSET_ID = '11111111-1111-4111-8111-111111111111';
const REL_PASSWORD_ID = '22222222-2222-4222-8222-222222222222';

function relatedResult() {
  const assetItem = {
    relationId: 'r-1',
    kind: 'asset' as const,
    id: REL_ASSET_ID,
    title: 'web-1',
    subtitle: null,
    href: `/admin/companies/c-1/assets/${REL_ASSET_ID}`,
    icon: null,
    color: null,
    relationType: 'manual',
    direction: 'outgoing' as const,
    isFieldManaged: false,
    createdAt: new Date(),
  };
  const passwordItem = {
    ...assetItem,
    relationId: 'r-2',
    kind: 'password' as const,
    id: REL_PASSWORD_ID,
    title: 'root cred',
  };
  return {
    items: [assetItem, passwordItem],
    groups: { asset: [assetItem], article: [], password: [passwordItem] },
    totalCount: 2,
  };
}

function makeTool(overrides: {
  role?: string;
  allowedActions?: string[];
  sourceRow?: { id: string; name?: string; title?: string } | null;
} = {}) {
  const allowed = overrides.allowedActions ?? [
    'asset.read',
    'article.read',
    'password.read',
  ];
  const permissions = {
    can: jest.fn(async (_actor: unknown, action: string) => ({
      allowed: allowed.includes(action),
    })),
  };
  const relations = { listRelated: jest.fn(async () => relatedResult()) };
  const sourceRow = 'sourceRow' in overrides
    ? overrides.sourceRow
    : { id: SOURCE_ID, name: 'ACM-DB01', title: 'ACM-DB01' };
  const prisma = {
    asset: {
      findFirst: jest.fn(async () => sourceRow),
      findMany: jest.fn(async () => []),
    },
    article: {
      findFirst: jest.fn(async () => sourceRow),
      findMany: jest.fn(async () => []),
    },
    password: { findFirst: jest.fn(async () => sourceRow) },
    company: { findFirst: jest.fn(async () => ({ slug: 'acme' })) },
  };
  const entityScope = { resolveEntityCompany: jest.fn(async () => 'c-1') };
  const tool = new GetRelatedItemsAiTool(
     
    relations as any,
     
    permissions as any,
     
    prisma as any,
     
    entityScope as any,
  );
  const ctx: AiToolExecutionContext = {
    actor: { id: 'u-1', role: overrides.role ?? 'OPERATOR' } as AuthedUser,
    tenant: {} as never,
    correlationId: 'req-1',
    ip: '127.0.0.1',
    userAgent: 'jest',
    conversationId: 'conv-1',
    turnContext: null,
  };
  return { tool, ctx, permissions, relations, prisma };
}

describe('GetRelatedItemsAiTool', () => {
  it('requires the source kind’s own read permission before any traversal', async () => {
    const { tool, ctx, relations, prisma } = makeTool({
      allowedActions: ['asset.read', 'article.read'], // no password.read
    });
    await expect(
      tool.execute(
        ctx,
        { entity_type: 'password', entity_id: SOURCE_ID, entity_name: 'ACM-DB01' },
        'c-1',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(relations.listRelated).not.toHaveBeenCalled();
    expect(prisma.password.findFirst).not.toHaveBeenCalled();
  });

  it.each(['asset', 'article', 'password'] as const)(
    'refuses an unreadable %s source (archived/hidden/restricted) with NO relation query issued',
    async (kind) => {
      const { tool, ctx, relations } = makeTool({ sourceRow: null });
      await expect(
        tool.execute(
          ctx,
          { entity_type: kind, entity_id: SOURCE_ID, entity_name: 'ACM-DB01' },
          'c-1',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(relations.listRelated).not.toHaveBeenCalled();
    },
  );

  it('applies client visibility to the article source-row read', async () => {
    const { tool, ctx, prisma } = makeTool({ role: 'CLIENT_USER' });
    await tool.execute(
      ctx,
      { entity_type: 'article', entity_id: SOURCE_ID, entity_name: 'ACM-DB01' },
      'c-1',
    );
    expect(prisma.article.findFirst).toHaveBeenCalledWith({
      where: {
        id: SOURCE_ID,
        companyId: 'c-1',
        archivedAt: null,
        visibleToClients: true,
      },
      select: { id: true, title: true },
    });
  });

  it('applies the password restriction policy to a password source-row read', async () => {
    const { tool, ctx, prisma } = makeTool();
    await tool.execute(
      ctx,
      { entity_type: 'password', entity_id: SOURCE_ID, entity_name: 'ACM-DB01' },
      'c-1',
    );
    expect(prisma.password.findFirst).toHaveBeenCalledWith({
      where: {
        id: SOURCE_ID,
        companyId: 'c-1',
        archivedAt: null,
        OR: [
          { restrictedToUserIds: { isEmpty: true } },
          { restrictedToUserIds: { has: 'u-1' } },
        ],
      },
      select: { id: true, name: true },
    });
  });

  it('drops entire counterpart kinds the actor may not read', async () => {
    const { tool, ctx } = makeTool({
      allowedActions: ['asset.read', 'article.read'], // no password.read
    });
    const out = await tool.execute(
      ctx,
      { entity_type: 'asset', entity_id: SOURCE_ID, entity_name: 'ACM-DB01' },
      'c-1',
    );
    expect(out.items.map((i) => i.kind)).toEqual(['asset']);
    expect(out.sourceTitle).toBe('ACM-DB01');
    expect(out.totalCount).toBe(1);
  });

  it('returns role-aware hrefs and relation types for permitted items', async () => {
    const { tool, ctx } = makeTool();
    const out = await tool.execute(
      ctx,
      { entity_type: 'asset', entity_id: SOURCE_ID, entity_name: 'ACM-DB01' },
      'c-1',
    );
    expect(out.items).toEqual([
      {
        kind: 'asset',
        id: REL_ASSET_ID,
        title: 'web-1',
        href: `/admin/companies/c-1/assets/${REL_ASSET_ID}`,
        relationType: 'manual',
      },
      {
        kind: 'password',
        id: REL_PASSWORD_ID,
        title: 'root cred',
        href: `/admin/companies/c-1/passwords/${REL_PASSWORD_ID}`,
        relationType: 'manual',
      },
    ]);
    expect(out.sourceTitle).toBe('ACM-DB01');
  });

  it('refuses a UUID whose server title does not match the requested entity name', async () => {
    const { tool, ctx, relations } = makeTool();
    await expect(
      tool.execute(
        ctx,
        { entity_type: 'asset', entity_id: SOURCE_ID, entity_name: 'ACM-DC01' },
        'c-1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(relations.listRelated).not.toHaveBeenCalled();
  });
});
