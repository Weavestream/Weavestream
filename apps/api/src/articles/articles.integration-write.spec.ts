import { ArticlesService } from './articles.service.js';
import { ArticleTargetWriter } from '../integrations/reconstruction/article-target.writer.js';
import { transformBreezeRecord } from '../integrations/drivers/breeze/breeze.transforms.js';
import { IntegrationProvenanceService } from '../integrations/reconstruction/integration-provenance.service.js';

const ids = {
  company: '52000000-0000-0000-0000-000000000001',
  actor: '52000000-0000-0000-0000-000000000002',
  integration: '52000000-0000-0000-0000-000000000003',
  article: '52000000-0000-0000-0000-000000000004',
  mapping: '52000000-0000-0000-0000-000000000005',
  resource: '52000000-0000-0000-0000-000000000006',
  other: '52000000-0000-0000-0000-000000000007',
  folder: '52000000-0000-0000-0000-000000000008',
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
    companyMapping: { integrationId: ids.integration, externalOrgId: 'org' },
    resource: { integrationId: ids.integration, resourceKey: 'articles' },
    provenance: { integrationId: ids.integration, externalOrgId: 'org', resourceKey: 'articles', externalId: 'org:articles:runbook', ownership: 'breeze', state: 'active' }, ...overrides,
  };
}

function fullProvenance(state: 'active' | 'stale') {
  return {
    integrationId: ids.integration,
    externalOrgId: 'org',
    resourceKey: 'articles',
    externalId: 'org:articles:runbook',
    sourceRevision: null,
    sourceFingerprint: null,
    firstSeenAt: '2026-07-01T00:00:00.000Z',
    lastSeenAt: '2026-07-01T00:00:00.000Z',
    lastSyncedAt: '2026-07-01T00:00:00.000Z',
    ownership: 'breeze',
    state,
  };
}

function setup(options: { bound?: unknown; collision?: unknown; binding?: unknown; auditFails?: boolean } = {}) {
  let committed = false;
  let createdFolder: Record<string, unknown> | null = null;
  let savepointFolder: Record<string, unknown> | null = null;
  const created = article();
  const updated = article({ markdownSource: '# Updated', revision: 2 });
  const tx = {
    // Minimal savepoint semantics for the one piece of state the mock
    // tracks transactionally: the managed folder created by the service.
    // Tagged-template call, so the statement arrives as a strings array.
    $executeRaw: jest.fn(async (strings: readonly string[]) => {
      const sql = Array.isArray(strings) ? strings.join('') : String(strings);
      if (sql.startsWith('SAVEPOINT ')) savepointFolder = createdFolder;
      if (sql.startsWith('ROLLBACK TO SAVEPOINT ')) createdFolder = savepointFolder;
      return 0;
    }),
    folder: {
      findFirst: jest.fn(async () => createdFolder),
      create: jest.fn(async () => {
        createdFolder = { id: ids.folder, companyId: ids.company, parentId: null, name: 'Breeze Scripts', slug: 'breeze-scripts', archivedAt: null };
        return createdFolder;
      }),
    },
    article: {
      findUnique: jest.fn().mockResolvedValue(options.bound ?? null),
      findFirst: jest.fn().mockResolvedValue(options.collision ?? null),
      create: jest.fn().mockResolvedValue(created),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirstOrThrow: jest.fn().mockResolvedValue(updated),
    },
    articleVersion: {
      create: jest.fn().mockResolvedValue({ id: 'version-1' }),
      aggregate: jest.fn().mockResolvedValue({ _max: { version: 1 } }),
      deleteMany: jest.fn(),
    },
    upload: { updateMany: jest.fn(), deleteMany: jest.fn() },
    integrationSyncRecord: {
      findUnique: jest.fn().mockResolvedValue(options.binding ?? null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    auditLog: { create: jest.fn() },
    // Tagged-template call (strings array) = the scope watermark lock
    // probe; Prisma.sql-object call = the guarded stale transition,
    // which reports survivors via RETURNING.
    $queryRaw: jest.fn(async (query: readonly string[] | { values?: unknown[] }) => {
      if (Array.isArray(query)) return [{ id: 'watermark-row' }];
      if (!options.binding || typeof options.binding !== 'object') return [];
      const values = (query as { values?: unknown[] }).values;
      const staleSince = values?.find((value) => value instanceof Date) as Date | undefined;
      const current = options.binding as Record<string, any>;
      Object.assign(current, {
        state: 'stale',
        staleSince: staleSince ?? current.staleSince,
        provenance: { ...current.provenance, state: 'stale' },
      });
      return [{
        id: current.id ?? 'binding-row',
        targetKind: current.targetKind,
        assetId: current.assetId ?? null,
        subnetId: current.subnetId ?? null,
        ipReservationId: current.ipReservationId ?? null,
        articleId: current.articleId ?? null,
        relationId: current.relationId ?? null,
      }];
    }),
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
    {} as never, { isAutoSummariesEnabled: async () => false } as never, { enqueueArticleSummary: async () => 'job-1' } as never);
  return { service, prisma, audit, tx, wasCommitted: () => committed, pendingFolder: () => createdFolder };
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
  it('writes an exact Breeze script transform through the real article writer and service', async () => {
    const orgId = '11111111-1111-4111-8111-111111111111';
    const sourceId = '22222222-2222-4222-8222-222222222222';
    const [record] = transformBreezeRecord('scripts', {
      id: sourceId, orgId, siteId: null, sourceUpdatedAt: '2026-07-14T12:00:00.000Z', revision: 'a'.repeat(64),
      sourceScope: 'organization', name: 'Install database', description: 'Rebuild procedure',
      category: 'build', osTypes: ['linux'], language: 'bash', content: 'dnf install postgresql17',
      parameters: [{ name: 'cluster', required: true }], timeoutSeconds: 900, runAs: 'elevated',
      version: 4, exitCodeSeverityMapping: { '0': null, '1': 'high' },
    }) as Array<{ reconstructionInput: any }>;
    const { service, tx } = setup();
    const writer = new ArticleTargetWriter(service);
    const outcome = await writer.write({
      tx: tx as never, companyId: ids.company, integrationId: ids.integration,
      integrationCompanyMappingId: ids.mapping, resourceId: ids.resource, resourceKey: 'scripts',
      externalOrgId: orgId, auditActorId: ids.actor, now: new Date('2026-07-14T12:00:00.000Z'),
      dryRun: false, resolveBinding: jest.fn().mockResolvedValue(null),
    }, record!.reconstructionInput);
    expect(outcome).toMatchObject({ change: 'created', targetKind: 'article' });
    expect(tx.article.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        folderId: ids.folder,
        markdownSource: expect.stringContaining('dnf install postgresql17'),
      }),
    }));
    expect(tx.articleVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ version: 1, isDraft: false }),
    }));
  });

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
    const { service } = setup({ bound, binding: binding({ state, provenance: { integrationId: ids.integration, externalOrgId: 'org', resourceKey: 'articles', externalId: 'org:articles:runbook', ownership: 'breeze', state } }) });
    await expect(service.writeFromIntegration({
      ...input, existingTargetId: ids.article,
    })).resolves.toMatchObject({ targetId: ids.article, change });
  });

  it('restores the same archived article and preserves manual text outside managed markers', async () => {
    const oldManaged = '<!-- weavestream:breeze:managed:start -->\n# Old source\n<!-- weavestream:breeze:managed:end -->';
    const manual = '\n\n## Operator notes\nKeep this restore credential reference.';
    const { service, tx } = setup({
      bound: article({
        archivedAt: new Date('2026-07-02T00:00:00.000Z'),
        markdownSource: oldManaged + manual,
      }),
      binding: binding({
        state: 'stale',
        provenance: {
          integrationId: ids.integration, externalOrgId: 'org', resourceKey: 'articles',
          externalId: 'org:articles:runbook', ownership: 'breeze', state: 'stale',
        },
      }),
    });

    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.article,
      markdown: '<!-- weavestream:breeze:managed:start -->\n# New source\n<!-- weavestream:breeze:managed:end -->',
    })).resolves.toMatchObject({ targetId: ids.article, change: 'restored' });
    expect(tx.article.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: ids.article,
        companyId: ids.company,
        revision: 1,
        archivedAt: new Date('2026-07-02T00:00:00.000Z'),
        updatedAt: new Date('2026-07-01T00:00:00.000Z'),
      },
      data: expect.objectContaining({
        archivedAt: null,
        markdownSource: expect.stringContaining('## Operator notes'),
      }),
    }));
    expect(tx.articleVersion.create).toHaveBeenCalledTimes(1);
    expect(tx.articleVersion.deleteMany).not.toHaveBeenCalled();
  });

  it('preserves manual text, attachments, and version history across a real stale sweep and native restore', async () => {
    const oldManaged = '<!-- weavestream:breeze:managed:start -->\n# Old source\n<!-- weavestream:breeze:managed:end -->';
    const manual = '\n\n## Operator notes\nKeep [manual attachment](upload://manual-1).';
    const target = article({ markdownSource: oldManaged + manual });
    const persistedBinding = binding({
      id: 'binding-shared-article',
      staleSince: null,
      lastSeenAt: new Date('2026-07-01T00:00:00.000Z'),
      provenance: fullProvenance('active'),
    });
    const versionHistory = [{ id: 'version-existing', version: 1 }];
    const attachments = [{ id: 'manual-1', articleId: ids.article }];
    const { service, prisma, audit, tx } = setup({ bound: target, binding: persistedBinding });
    tx.integrationSyncRecord.findMany
      .mockResolvedValueOnce([persistedBinding])
      .mockResolvedValueOnce([]);
    tx.integrationSyncRecord.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(persistedBinding, data);
      return persistedBinding;
    });
    tx.article.updateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(target, data);
      return { count: 1 };
    });
    tx.articleVersion.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      const created = { id: 'version-restored', ...data };
      versionHistory.push(created as never);
      return created;
    });
    tx.upload.updateMany.mockImplementation(async () => {
      const count = attachments.length;
      attachments.splice(0);
      return { count };
    });
    tx.upload.deleteMany.mockImplementation(async () => {
      const count = attachments.length;
      attachments.splice(0);
      return { count };
    });

    const staleAt = new Date('2026-07-14T12:00:00.000Z');
    await expect(new IntegrationProvenanceService(prisma as never, audit as never).staleUnseen(
      tx as never,
      {
        companyId: ids.company,
        integrationId: ids.integration,
        integrationCompanyMappingId: ids.mapping,
        resourceId: ids.resource,
        targetKind: 'article',
        snapshotAt: staleAt,
        auditActorId: ids.actor,
      },
    )).resolves.toEqual({ stale: 1, archived: 1 });
    expect(target.archivedAt).toEqual(staleAt);

    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.article,
      markdown: '<!-- weavestream:breeze:managed:start -->\n# New source\n<!-- weavestream:breeze:managed:end -->',
    })).resolves.toMatchObject({ targetId: ids.article, change: 'restored' });

    expect(target.id).toBe(ids.article);
    expect(target.archivedAt).toBeNull();
    expect(target.markdownSource).toContain('# New source');
    expect(target.markdownSource).toContain('## Operator notes');
    expect(target.markdownSource).toContain('upload://manual-1');
    expect(attachments).toEqual([{ id: 'manual-1', articleId: ids.article }]);
    expect(versionHistory).toHaveLength(2);
    expect(tx.upload.updateMany).not.toHaveBeenCalled();
    expect(tx.upload.deleteMany).not.toHaveBeenCalled();
    expect(tx.articleVersion.deleteMany).not.toHaveBeenCalled();
  });

  it('re-reads and re-merges when an operator edit lands between read and write', async () => {
    const managed = (body: string) =>
      `<!-- weavestream:breeze:managed:start -->\n${body}\n<!-- weavestream:breeze:managed:end -->`;
    const first = article({ markdownSource: `${managed('# Old source')}\n\n## Notes v1`, revision: 4 });
    const reread = article({
      markdownSource: `${managed('# Old source')}\n\n## Notes v2`,
      revision: 5,
      updatedAt: new Date('2026-07-03T00:00:00.000Z'),
    });
    const { service, prisma, tx } = setup({ binding: binding() });
    prisma.article.findUnique.mockResolvedValueOnce(first).mockResolvedValueOnce(reread);
    const writes: Array<{ where: Record<string, unknown>; data: { markdownSource: string } }> = [];
    tx.article.updateMany.mockImplementation(async (args: { where: Record<string, unknown>; data: { markdownSource: string } }) => {
      writes.push(args);
      // First guarded attempt loses the race; the retry wins.
      return { count: writes.length === 1 ? 0 : 1 };
    });

    await expect(service.writeFromIntegration({
      ...input, existingTargetId: ids.article, markdown: managed('# New source'),
    })).resolves.toMatchObject({ targetId: ids.article, change: 'updated' });

    expect(writes).toHaveLength(2);
    expect(writes[0]!.where).toMatchObject({ revision: 4, archivedAt: null });
    expect(writes[1]!.where).toMatchObject({
      id: ids.article,
      companyId: ids.company,
      revision: 5,
      archivedAt: null,
      updatedAt: new Date('2026-07-03T00:00:00.000Z'),
    });
    expect(writes[1]!.data.markdownSource).toContain('# New source');
    expect(writes[1]!.data.markdownSource).toContain('## Notes v2');
    expect(writes[1]!.data.markdownSource).not.toContain('## Notes v1');
    expect(tx.articleVersion.create).toHaveBeenCalledTimes(1);
  });

  it('reports a synchronization gap when the guarded update keeps conflicting', async () => {
    const { service, prisma, audit, tx } = setup({ bound: article(), binding: binding() });
    tx.article.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.writeFromIntegration({
      ...input, existingTargetId: ids.article, markdown: '# Changed body',
    })).resolves.toMatchObject({
      targetId: ids.article,
      change: 'blocked',
      gap: {
        kind: 'synchronization_error',
        details: { reasonCode: 'target_revision_conflict' },
      },
    });

    expect(tx.article.updateMany).toHaveBeenCalledTimes(3);
    expect(prisma.article.findUnique).toHaveBeenCalledTimes(3);
    expect(tx.articleVersion.create).not.toHaveBeenCalled();
    expect(audit.logWithClient).not.toHaveBeenCalled();
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

  it('preserves manual notes and creates exactly one version for changed managed content', async () => {
    const oldManaged = '<!-- weavestream:breeze:managed:start -->\n# Old\n<!-- weavestream:breeze:managed:end -->';
    const manual = '\n\n## Operator notes\nKeep this note and [attachment](upload://manual-1).';
    const { service, tx } = setup({
      bound: article({ markdownSource: oldManaged + manual }),
      binding: binding(),
    });
    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.article,
      markdown: '<!-- weavestream:breeze:managed:start -->\n# New\n<!-- weavestream:breeze:managed:end -->',
      sourceFingerprintUnchanged: false,
    })).resolves.toMatchObject({ change: 'updated' });
    expect(tx.article.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ markdownSource: expect.stringContaining('## Operator notes') }),
    }));
    expect(tx.article.updateMany.mock.calls[0]![0].data.markdownSource).toContain('# New');
    expect(tx.article.updateMany.mock.calls[0]![0].data.markdownSource).toContain('upload://manual-1');
    expect(tx.articleVersion.create).toHaveBeenCalledTimes(1);
  });

  it('does not version an unchanged fingerprint merely because the exported date advanced', async () => {
    const current = '<!-- weavestream:breeze:managed:start -->\n# Runbook\nExported source date: 2026-07-13T00:00:00.000Z\n<!-- weavestream:breeze:managed:end -->\n\nManual note';
    const { service, tx } = setup({
      bound: article({ markdownSource: current }),
      binding: binding(),
    });
    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.article,
      markdown: current.replace('2026-07-13', '2026-07-14'),
      sourceFingerprintUnchanged: true,
    })).resolves.toMatchObject({ change: 'unchanged' });
    expect(tx.article.updateMany).not.toHaveBeenCalled();
    expect(tx.articleVersion.create).not.toHaveBeenCalled();
  });

  it('provisions a deterministic internal folder and writes the article into it', async () => {
    const { service, tx } = setup();
    await expect(service.writeFromIntegration({
      ...input,
      folderSlug: 'breeze-scripts',
      folderName: 'Breeze Scripts',
    })).resolves.toMatchObject({ change: 'created' });
    expect(tx.folder.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ companyId: ids.company, slug: 'breeze-scripts', name: 'Breeze Scripts' }),
    }));
    expect(tx.article.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ folderId: ids.folder }),
    }));
  });

  it('reuses the first uncommitted folder for two articles sharing one page transaction', async () => {
    const { service, tx } = setup();
    const shared = { ...input, tx: tx as never, folderSlug: 'breeze-scripts', folderName: 'Breeze Scripts' };
    await service.writeFromIntegration(shared);
    await service.writeFromIntegration({ ...shared, externalId: 'org:articles:second', slug: 'second' });
    expect(tx.folder.create).toHaveBeenCalledTimes(1);
    expect(tx.article.create).toHaveBeenCalledTimes(2);
  });

  it('creates the managed folder in the same transaction as the article so a failed create rolls both back', async () => {
    const { service, prisma, tx, wasCommitted } = setup();
    tx.article.create.mockRejectedValue(new Error('unique violation'));
    await expect(service.writeFromIntegration({
      ...input,
      folderSlug: 'breeze-scripts',
      folderName: 'Breeze Scripts',
    })).rejects.toThrow('unique violation');
    expect(tx.folder.create).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(wasCommitted()).toBe(false);
  });

  it('refuses a bound write before creating the managed folder', async () => {
    const { service, tx } = setup({ bound: article() });
    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.article,
      folderSlug: 'breeze-scripts',
      folderName: 'Breeze Scripts',
    })).resolves.toMatchObject({ change: 'blocked', gap: { details: { reasonCode: 'manual_ownership' } } });
    expect(tx.folder.create).not.toHaveBeenCalled();
    expect(tx.article.updateMany).not.toHaveBeenCalled();
  });

  it('writes no managed folder into a caller-supplied transaction for a refused bound write', async () => {
    const { service, prisma, tx } = setup({ bound: article() });
    await expect(service.writeFromIntegration({
      ...input,
      tx: tx as never,
      existingTargetId: ids.article,
      folderSlug: 'breeze-scripts',
      folderName: 'Breeze Scripts',
    })).resolves.toMatchObject({ change: 'blocked', gap: { details: { reasonCode: 'manual_ownership' } } });
    expect(tx.folder.create).not.toHaveBeenCalled();
    expect(tx.article.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rolls the pending folder back to its savepoint on every conflicted attempt in a caller-supplied transaction', async () => {
    const { service, prisma, tx, pendingFolder } = setup({ bound: article(), binding: binding() });
    tx.article.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.writeFromIntegration({
      ...input,
      tx: tx as never,
      existingTargetId: ids.article,
      markdown: '# Changed body',
      folderSlug: 'breeze-scripts',
      folderName: 'Breeze Scripts',
    })).resolves.toMatchObject({ change: 'blocked', gap: { details: { reasonCode: 'target_revision_conflict' } } });
    // Each attempt re-creates the folder inside its savepoint and discards
    // it on conflict; exhaustion leaves nothing for the page tx to commit.
    expect(tx.folder.create).toHaveBeenCalledTimes(3);
    expect(pendingFolder()).toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('leaves no pending folder when a conflict retry re-reads a blocked article in a caller-supplied transaction', async () => {
    const { service, tx, pendingFolder } = setup({ binding: binding() });
    tx.article.findUnique
      .mockResolvedValueOnce(article())
      .mockResolvedValueOnce(article({ editorMode: 'tiptap', content: { type: 'doc' }, markdownSource: null }));
    tx.article.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.writeFromIntegration({
      ...input,
      tx: tx as never,
      existingTargetId: ids.article,
      markdown: '# Changed body',
      folderSlug: 'breeze-scripts',
      folderName: 'Breeze Scripts',
    })).resolves.toMatchObject({ change: 'blocked', gap: { details: { reasonCode: 'managed_region_invalid' } } });
    expect(tx.folder.create).toHaveBeenCalledTimes(1);
    const executed = tx.$executeRaw.mock.calls.map(([strings]) => (Array.isArray(strings) ? strings.join('') : String(strings)));
    expect(executed).toContain('ROLLBACK TO SAVEPOINT weavestream_managed_folder');
    expect(pendingFolder()).toBeNull();
  });

  it.each([
    ['missing markers', '# Manual-only bound body'],
    ['end before start', '<!-- weavestream:breeze:managed:end -->\nmanual\n<!-- weavestream:breeze:managed:start -->'],
    ['duplicate markers', '<!-- weavestream:breeze:managed:start -->\nA\n<!-- weavestream:breeze:managed:start -->\n<!-- weavestream:breeze:managed:end -->'],
  ])('fails closed without mutation for %s in a bound source article', async (_label, malformed) => {
    const { service, tx } = setup({ bound: article({ markdownSource: malformed }), binding: binding() });
    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.article,
      markdown: '<!-- weavestream:breeze:managed:start -->\n# New\n<!-- weavestream:breeze:managed:end -->',
    })).resolves.toMatchObject({ change: 'blocked', gap: { details: { reasonCode: 'managed_region_invalid' } } });
    expect(tx.article.updateMany).not.toHaveBeenCalled();
    expect(tx.articleVersion.create).not.toHaveBeenCalled();
  });
});
