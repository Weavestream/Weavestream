import { ArticlesService } from './articles.service.js';

const ids = {
  company: '52000000-0000-0000-0000-000000000001',
  actor: '52000000-0000-0000-0000-000000000002',
  integration: '52000000-0000-0000-0000-000000000003',
  article: '52000000-0000-0000-0000-000000000004',
  mapping: '52000000-0000-0000-0000-000000000005',
  resource: '52000000-0000-0000-0000-000000000006',
  other: '52000000-0000-0000-0000-000000000007',
};

function article(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.article,
    companyId: ids.company,
    folderId: null,
    title: 'Runbook',
    slug: 'runbook',
    editorMode: 'markdown',
    content: null,
    markdownSource: '# Runbook',
    contentPlaintext: 'Runbook',
    excerpt: 'Runbook',
    visibleToClients: false,
    revision: 1,
    archivedAt: null,
    createdBy: ids.actor,
    updatedBy: ids.actor,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
    integrationCompanyMappingId: ids.mapping, resourceId: ids.resource, externalId: 'org:articles:runbook',
    companyId: ids.company, targetKind: 'article', assetId: null, subnetId: null,
    ipReservationId: null, articleId: ids.article, relationId: null, state: 'active',
    provenance: { integrationId: ids.integration, ownership: 'breeze', state: 'active' }, ...overrides,
  };
}

function setup(options: { bound?: unknown; collision?: unknown; binding?: unknown; auditFails?: boolean } = {}) {
  let committed = false;
  const created = article();
  const updated = article({ markdownSource: '# Updated', revision: 2 });
  const tx = {
    article: {
      create: jest.fn().mockResolvedValue(created),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirstOrThrow: jest.fn().mockResolvedValue(updated),
    },
    articleVersion: {
      create: jest.fn().mockResolvedValue({ id: 'version-1' }),
      aggregate: jest.fn().mockResolvedValue({ _max: { version: 1 } }),
    },
    integrationSyncRecord: { findUnique: jest.fn().mockResolvedValue(options.binding ?? null) },
    auditLog: { create: jest.fn() },
  };
  const prisma = {
    folder: { findFirst: jest.fn().mockResolvedValue(null) },
    article: {
      findUnique: jest.fn().mockResolvedValue(options.bound ?? null),
      findFirst: jest.fn().mockResolvedValue(options.collision ?? null),
    },
    integrationSyncRecord: { findUnique: jest.fn().mockResolvedValue(options.binding ?? null) },
    $transaction: jest.fn(async (callback: (client: unknown) => Promise<unknown>) => {
      const result = await callback(tx);
      committed = true;
      return result;
    }),
  };
  const audit = {
    assertIntegrationActor: jest.fn().mockResolvedValue(undefined),
    logWithClient: options.auditFails
      ? jest.fn().mockRejectedValue(new Error('audit failed'))
      : jest.fn().mockResolvedValue(undefined),
  };
  const service = new ArticlesService(
    prisma as never,
    audit as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, prisma, audit, tx, wasCommitted: () => committed };
}

const input = {
  companyId: ids.company,
  integrationId: ids.integration,
  integrationCompanyMappingId: ids.mapping,
  resourceId: ids.resource,
  externalId: 'org:articles:runbook',
  auditActorId: ids.actor,
  dryRun: false,
  title: 'Runbook',
  slug: 'runbook',
  folderId: null,
  markdown: '# Runbook',
  visibleToClients: false,
};

describe('ArticlesService integration system writes', () => {
  it('creates a source article, published version, and audit in one transaction', async () => {
    const { service, audit, tx } = setup();
    await expect(service.writeFromIntegration(input)).resolves.toEqual({
      targetId: ids.article,
      companyId: ids.company,
      change: 'created',
    });
    expect(tx.articleVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ articleId: ids.article, isDraft: false, changeReason: `integration:${ids.integration}` }) }),
    );
    expect(audit.logWithClient).toHaveBeenCalledWith(tx, expect.objectContaining({ entityId: ids.article }));
  });

  it('creates a new published version when a verified source article changes', async () => {
    const { service, tx } = setup({ bound: article(), binding: binding() });
    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.article,
      markdown: '# Updated',
    })).resolves.toMatchObject({ targetId: ids.article, change: 'updated' });
    expect(tx.articleVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ version: 2, changedBy: ids.actor }) }),
    );
  });

  it('rejects an arbitrary manual existing article before mutation', async () => {
    const { service, tx } = setup({ bound: article() });
    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.article,
    })).resolves.toMatchObject({ change: 'blocked', gap: { details: { reasonCode: 'manual_ownership' } } });
    expect(tx.article.updateMany).not.toHaveBeenCalled();
  });

  it('does not commit article/version state when audit fails', async () => {
    const { service, wasCommitted } = setup({ auditFails: true });
    await expect(service.writeFromIntegration(input)).rejects.toThrow('audit failed');
    expect(wasCommitted()).toBe(false);
  });

  it.each([
    ['unchanged', article()],
    ['restored', article({ archivedAt: new Date('2026-07-02T00:00:00.000Z') })],
  ] as const)('classifies a verified source article as %s', async (change, bound) => {
    const state = change === 'restored' ? 'stale' : 'active';
    const { service } = setup({ bound, binding: binding({ state, provenance: { integrationId: ids.integration, ownership: 'breeze', state } }) });
    await expect(service.writeFromIntegration({
      ...input, existingTargetId: ids.article,
    })).resolves.toMatchObject({ targetId: ids.article, change });
  });

  it.each([
    ['missing', null], ['wrong mapping', binding({ integrationCompanyMappingId: ids.other })],
    ['wrong resource', binding({ resourceId: ids.other })], ['wrong external id', binding({ externalId: 'wrong' })],
    ['wrong kind', binding({ targetKind: 'asset' })], ['wrong id', binding({ articleId: ids.other })],
    ['wrong company', binding({ companyId: 'other-company' })],
    ['blocked', binding({ state: 'blocked', provenance: { integrationId: ids.integration, ownership: 'breeze', state: 'blocked' } })],
    ['manual', binding({ provenance: { integrationId: ids.integration, ownership: 'weavestream', state: 'active' } })],
  ])('rejects a %s article binding despite a forged legacy flag', async (_label, persistedBinding) => {
    const { service, tx } = setup({ bound: article(), binding: persistedBinding });
    await expect(service.writeFromIntegration({ ...input, existingTargetId: ids.article, ownershipVerified: true } as never))
      .resolves.toMatchObject({ change: 'blocked', gap: { details: { reasonCode: 'manual_ownership' } } });
    expect(tx.article.updateMany).not.toHaveBeenCalled();
  });

  it('blocks wrong-company and unbound slug collisions', async () => {
    const wrong = setup({ bound: article({ companyId: 'other-company' }) }).service;
    await expect(wrong.writeFromIntegration({
      ...input, existingTargetId: ids.article,
    })).resolves.toMatchObject({ companyId: 'other-company', change: 'blocked' });
    const collision = setup({ collision: { id: ids.article } }).service;
    await expect(collision.writeFromIntegration(input)).resolves.toMatchObject({
      change: 'blocked', gap: { details: { reasonCode: 'manual_ownership' } },
    });
  });

  it('keeps article dry-run side-effect free', async () => {
    const { service, prisma, audit } = setup();
    await expect(service.writeFromIntegration({ ...input, dryRun: true })).resolves.toMatchObject({ change: 'created' });
    expect(audit.assertIntegrationActor).toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
