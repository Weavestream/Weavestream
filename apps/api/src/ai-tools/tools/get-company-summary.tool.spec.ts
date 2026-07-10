import { NotFoundException } from '@nestjs/common';
import { GetCompanySummaryAiTool } from './get-company-summary.tool.js';
import type { AiToolExecutionContext } from '../tool-registry.js';
import type { AuthedUser } from '../../common/current-user.decorator.js';

function makeTool(overrides: {
  role?: string;
  allowedActions?: string[];
  company?: { id: string; name: string; slug: string } | null;
} = {}) {
  const allowed = overrides.allowedActions ?? [
    'asset.read',
    'article.read',
    'domain.read',
    'password.read',
    'upload.read',
  ];
  const permissions = {
    can: jest.fn(async (_actor: unknown, action: string) => ({
      allowed: allowed.includes(action),
    })),
  };
  const company =
    'company' in overrides
      ? overrides.company
      : { id: 'c-1', name: 'Acme', slug: 'acme' };
  const prisma = {
    company: { findFirst: jest.fn(async () => company) },
    asset: { count: jest.fn(async () => 12) },
    article: { count: jest.fn(async () => 8) },
    monitoredDomain: { count: jest.fn(async () => 3) },
    password: { count: jest.fn(async () => 20) },
    upload: { count: jest.fn(async () => 5) },
    auditLog: { count: jest.fn(async () => 44) },
  };
   
  const tool = new GetCompanySummaryAiTool(permissions as any, prisma as any);
  const ctx: AiToolExecutionContext = {
    actor: { id: 'u-1', role: overrides.role ?? 'OPERATOR' } as AuthedUser,
    tenant: {} as never,
    correlationId: 'req-1',
    ip: '127.0.0.1',
    userAgent: 'jest',
    conversationId: 'conv-1',
    turnContext: { companyId: 'c-1' } as never,
  };
  return { tool, ctx, permissions, prisma };
}

describe('GetCompanySummaryAiTool', () => {
  it('takes the company exclusively from the turn context', async () => {
    const { tool, ctx } = makeTool();
    await expect(tool.resolveCompanyId(ctx)).resolves.toBe('c-1');
    await expect(
      tool.resolveCompanyId({ ...ctx, turnContext: null }),
    ).resolves.toBeNull();
  });

  it('summarizes permitted sections with per-model active predicates', async () => {
    const { tool, ctx, prisma } = makeTool();
    const out = await tool.execute(ctx, {}, 'c-1');
    expect(out).toEqual({
      companyId: 'c-1',
      companyName: 'Acme',
      href: '/admin/companies/c-1',
      assets: 12,
      articles: 8,
      domains: 3,
      passwords: 20,
      uploads: 5,
      // audit.read not granted in the default fixture → omitted.
    });
    // Uploads have no archivedAt — the active predicate is deletedAt.
    expect(prisma.upload.count).toHaveBeenCalledWith({
      where: { companyId: 'c-1', deletedAt: null },
    });
    expect(prisma.asset.count).toHaveBeenCalledWith({
      where: { companyId: 'c-1', archivedAt: null },
    });
    // Internal non-SA actors never count restricted credentials.
    expect(prisma.password.count).toHaveBeenCalledWith({
      where: {
        companyId: 'c-1',
        archivedAt: null,
        OR: [
          { restrictedToUserIds: { isEmpty: true } },
          { restrictedToUserIds: { has: 'u-1' } },
        ],
      },
    });
  });

  it('OMITS unauthorized sections instead of zeroing them (no presence side channel)', async () => {
    const { tool, ctx, prisma } = makeTool({
      allowedActions: ['asset.read', 'article.read'],
    });
    const out = await tool.execute(ctx, {}, 'c-1');
    expect(out).toEqual({
      companyId: 'c-1',
      companyName: 'Acme',
      href: '/admin/companies/c-1',
      assets: 12,
      articles: 8,
    });
    expect('passwords' in out).toBe(false);
    expect('domains' in out).toBe(false);
    expect(prisma.password.count).not.toHaveBeenCalled();
    expect(prisma.monitoredDomain.count).not.toHaveBeenCalled();
  });

  it('includes the audit segment only under audit.read', async () => {
    const { tool, ctx } = makeTool({
      allowedActions: ['asset.read', 'audit.read'],
    });
    const out = await tool.execute(ctx, {}, 'c-1');
    expect(out.auditEventsLast30d).toBe(44);
    expect(out.articles).toBeUndefined();
  });

  it('applies client visibility to article/domain counts and portal href for clients', async () => {
    const { tool, ctx, prisma } = makeTool({ role: 'CLIENT_USER' });
    const out = await tool.execute(ctx, {}, 'c-1');
    expect(out.href).toBe('/portal/acme');
    expect(prisma.article.count).toHaveBeenCalledWith({
      where: { companyId: 'c-1', archivedAt: null, visibleToClients: true },
    });
    expect(prisma.monitoredDomain.count).toHaveBeenCalledWith({
      where: { companyId: 'c-1', archivedAt: null, visibleToClients: true },
    });
    // Client password counts are governed by visibleToClients.
    expect(prisma.password.count).toHaveBeenCalledWith({
      where: { companyId: 'c-1', archivedAt: null, visibleToClients: true },
    });
  });

  it('refuses when the turn has no company or the company is archived/gone', async () => {
    const { tool, ctx } = makeTool({ company: null });
    await expect(tool.execute(ctx, {}, 'c-1')).rejects.toBeInstanceOf(NotFoundException);
    const { tool: tool2, ctx: ctx2 } = makeTool();
    await expect(tool2.execute(ctx2, {}, null)).rejects.toBeInstanceOf(NotFoundException);
  });
});
