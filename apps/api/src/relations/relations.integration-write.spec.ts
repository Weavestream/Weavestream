import { RelationsService } from './relations.service.js';
import { RelationTargetWriter } from '../integrations/reconstruction/relation-target.writer.js';
import type { ReconstructionWriteContext } from '../integrations/reconstruction/reconstruction-target.js';
import { transformBreezeRecord } from '../integrations/drivers/breeze/breeze.transforms.js';

const ids = {
  company: '53000000-0000-0000-0000-000000000001',
  actor: '53000000-0000-0000-0000-000000000002',
  integration: '53000000-0000-0000-0000-000000000003',
  relation: '53000000-0000-0000-0000-000000000004',
  asset: '53000000-0000-0000-0000-000000000005',
  article: '53000000-0000-0000-0000-000000000006',
  mapping: '53000000-0000-0000-0000-000000000007',
  resource: '53000000-0000-0000-0000-000000000008',
  other: '53000000-0000-0000-0000-000000000009',
};

function relation(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.relation,
    companyId: ids.company,
    sourceType: 'Asset',
    sourceId: ids.asset,
    targetType: 'Article',
    targetId: ids.article,
    relationType: 'runbook',
    createdBy: ids.actor,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
    integrationCompanyMappingId: ids.mapping, resourceId: ids.resource, externalId: 'org:relations:runbook',
    companyId: ids.company, targetKind: 'relation', assetId: null, subnetId: null,
    ipReservationId: null, articleId: null, relationId: ids.relation, state: 'active',
    companyMapping: { integrationId: ids.integration, externalOrgId: 'org' },
    resource: { integrationId: ids.integration, resourceKey: 'relations' },
    provenance: { integrationId: ids.integration, externalOrgId: 'org', resourceKey: 'relations', externalId: 'org:relations:runbook', ownership: 'breeze', state: 'active' }, ...overrides,
  };
}

function setup(options: { bound?: unknown; composite?: unknown; binding?: unknown; auditFails?: boolean } = {}) {
  let committed = false;
  let relationWritten = false;
  const tx = {
    asset: { findFirst: jest.fn().mockResolvedValue({ id: ids.asset }) },
    article: { findFirst: jest.fn().mockResolvedValue({ id: ids.article }) },
    password: { findFirst: jest.fn() },
    relation: {
      findUnique: jest.fn().mockResolvedValue(options.bound ?? null),
      createMany: jest.fn().mockImplementation(async () => {
        relationWritten = true;
        return { count: 1 };
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockImplementation(async (args: { where: Record<string, unknown> }) => {
        if ('id' in args.where) return options.bound ?? relation();
        if (options.composite !== undefined) return options.composite;
        return relationWritten ? relation() : null;
      }),
    },
    integrationSyncRecord: { findUnique: jest.fn().mockResolvedValue(options.binding ?? null) },
    auditLog: { create: jest.fn() },
  };
  const prisma = {
    asset: { findFirst: jest.fn().mockResolvedValue({ id: ids.asset }) },
    article: { findFirst: jest.fn().mockResolvedValue({ id: ids.article }) },
    password: { findFirst: jest.fn() },
    relation: {
      findUnique: jest.fn().mockResolvedValue(options.bound ?? null),
      findFirst: jest.fn().mockResolvedValue(options.composite ?? null),
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
  const service = new RelationsService(prisma as never);
  (service as unknown as { audit: unknown }).audit = audit;
  return { service, prisma, audit, tx, wasCommitted: () => committed };
}

const input = {
  companyId: ids.company,
  integrationId: ids.integration,
  integrationCompanyMappingId: ids.mapping,
  resourceId: ids.resource,
  externalId: 'org:relations:runbook',
  auditActorId: ids.actor,
  dryRun: false,
  sourceType: 'Asset' as const,
  sourceId: ids.asset,
  targetType: 'Article' as const,
  targetId: ids.article,
  relationType: 'runbook',
};

describe('RelationsService integration system writes', () => {
  it('writes an assignment-to-site dependency from the separate Breeze relation resource', async () => {
    const orgId = '11111111-1111-4111-8111-111111111111';
    const siteId = '22222222-2222-4222-8222-222222222222';
    const assignmentId = '33333333-3333-4333-8333-333333333333';
    const policyId = '44444444-4444-4444-8444-444444444444';
    const records = transformBreezeRecord('configuration-assignment-relations', {
      id: assignmentId, orgId, siteId: null, sourceUpdatedAt: '2026-07-14T11:00:00.000Z',
      revision: 'a'.repeat(64), policyId, policyName: 'Baseline', sourceScope: 'organization',
      level: 'site', targetId: siteId, priority: 10, roleFilter: ['server'], osFilter: ['windows'],
    }) as Array<{ reconstructionInput: { relationType: string } }>;
    const appliesTo = records.find((record) => record.reconstructionInput.relationType === 'applies_to')!;
    const harness = setup();
    const resolveBinding = jest.fn(async (ref: { resourceKey: string }) => ({
      targetKind: ref.resourceKey === 'configuration-assignments' ? 'article' as const : 'asset' as const,
      targetId: ref.resourceKey === 'configuration-assignments' ? ids.article : ids.asset,
      companyId: ids.company,
    }));
    const out = await new RelationTargetWriter(harness.service).write({
      tx: harness.tx as never, companyId: ids.company, integrationId: ids.integration,
      integrationCompanyMappingId: ids.mapping, resourceId: ids.resource,
      resourceKey: 'configuration-assignment-relations', externalOrgId: orgId,
      auditActorId: ids.actor, now: new Date('2026-07-14T12:00:00.000Z'), dryRun: false,
      resolveBinding,
    }, appliesTo.reconstructionInput as never);
    expect(out).toMatchObject({ change: 'created', targetKind: 'relation' });
    expect(resolveBinding).toHaveBeenCalledWith({
      resourceKey: 'configuration-assignments',
      externalId: `${orgId}:configuration-assignments:${assignmentId}`,
    });
    expect(resolveBinding).toHaveBeenCalledWith({
      resourceKey: 'sites', externalId: `${orgId}:sites:${siteId}`,
    });
  });

  it.each(['automation', 'backup'] as const)(
    'writes %s article dependencies through the real relation service and safely gaps missing/cross-company endpoints',
    async (kind) => {
      const orgId = '11111111-1111-4111-8111-111111111111';
      const sourceId = '55555555-5555-4555-8555-555555555555';
      const dependencyId = '66666666-6666-4666-8666-666666666666';
      const baseRecord = {
        id: sourceId, orgId, siteId: null, sourceUpdatedAt: '2026-07-14T11:00:00.000Z',
        revision: 'a'.repeat(64), sourceScope: 'organization' as const,
      };
      const transformed = kind === 'automation'
        ? transformBreezeRecord('automation-relations', {
            ...baseRecord, name: 'Rebuild', description: null, enabled: true,
            trigger: { type: 'manual' }, conditions: null,
            actions: [{ type: 'run_script', scriptId: dependencyId }], onFailure: 'stop',
            notificationTargets: null, dependencies: [{ resource: 'scripts', id: dependencyId }],
          })
        : transformBreezeRecord('backup-configuration-relations', {
            ...baseRecord, kind: 'policy', name: 'Server backup', enabled: true,
            destinationId: dependencyId, targets: { roles: ['server'] }, schedule: null,
            retention: null, exclusions: [], restore: { types: ['full'], notes: null },
            gfs: null, legalHold: false, legalHoldReason: null, bandwidthLimitMbps: null,
            backupWindowStart: null, backupWindowEnd: null, priority: null,
          });
      const relationInput = transformed[0]!.reconstructionInput as never;
      const context = (
        harness: ReturnType<typeof setup>,
        resolveBinding: ReconstructionWriteContext['resolveBinding'],
      ): ReconstructionWriteContext => ({
        tx: harness.tx as never, companyId: ids.company, integrationId: ids.integration,
        integrationCompanyMappingId: ids.mapping, resourceId: ids.resource,
        resourceKey: kind === 'automation' ? 'automation-relations' : 'backup-configuration-relations',
        externalOrgId: orgId, auditActorId: ids.actor,
        now: new Date('2026-07-14T12:00:00.000Z'), dryRun: false, resolveBinding,
      });

      const success = setup();
      const successResolve = jest.fn()
        .mockResolvedValueOnce({ targetKind: 'article', targetId: ids.article, companyId: ids.company })
        .mockResolvedValueOnce({ targetKind: 'article', targetId: ids.other, companyId: ids.company });
      await expect(new RelationTargetWriter(success.service).write(
        context(success, successResolve), relationInput,
      )).resolves.toMatchObject({ change: 'created', targetKind: 'relation' });
      expect(success.tx.relation.createMany).toHaveBeenCalled();

      const missing = setup();
      const missingResolve = jest.fn()
        .mockResolvedValueOnce({ targetKind: 'article', targetId: ids.article, companyId: ids.company })
        .mockResolvedValueOnce(null);
      await expect(new RelationTargetWriter(missing.service).write(
        context(missing, missingResolve), relationInput,
      )).resolves.toMatchObject({
        change: 'blocked', gaps: [expect.objectContaining({ kind: 'missing_dependency' })],
      });
      expect(missing.tx.relation.createMany).not.toHaveBeenCalled();

      const crossCompany = setup();
      const crossResolve = jest.fn()
        .mockResolvedValueOnce({ targetKind: 'article', targetId: ids.article, companyId: ids.company })
        .mockResolvedValueOnce({ targetKind: 'article', targetId: ids.other, companyId: 'other-company' });
      await expect(new RelationTargetWriter(crossCompany.service).write(
        context(crossCompany, crossResolve), relationInput,
      )).resolves.toMatchObject({
        change: 'blocked', gaps: [expect.objectContaining({ kind: 'validation', details: { reasonCode: 'dependency_company_mismatch' } })],
      });
      expect(crossCompany.tx.relation.createMany).not.toHaveBeenCalled();
    },
  );


  it('writes an exported Breeze hierarchy edge through binding resolution and the real relation service', async () => {
    const orgId = '11111111-1111-4111-8111-111111111111';
    const siteId = '22222222-2222-4222-8222-222222222222';
    const deviceId = '33333333-3333-4333-8333-333333333333';
    const [record] = transformBreezeRecord('device-relationships', {
      id: deviceId,
      orgId,
      siteId,
      sourceUpdatedAt: '2026-07-14T11:00:00.000Z',
      revision: 'a'.repeat(64),
      subjectType: 'device',
      deviceId,
      edges: [
        {
          key: 'site-device-edge',
          type: 'site_device',
          from: { type: 'site', id: siteId },
          to: { type: 'device', id: deviceId },
          metadata: {},
        },
      ],
      collection: { total: 1, included: 1, complete: true, reason: null },
    });
    const harness = setup();
    const resolveBinding = jest.fn(async (ref: { resourceKey: string }) => ({
      targetKind: 'asset' as const,
      targetId: ref.resourceKey === 'sites' ? ids.asset : ids.article,
      companyId: ids.company,
    }));
    const context: ReconstructionWriteContext = {
      tx: harness.tx as never,
      companyId: ids.company,
      integrationId: ids.integration,
      integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource,
      resourceKey: 'device-relationships',
      externalOrgId: orgId,
      auditActorId: ids.actor,
      now: new Date('2026-07-14T12:00:00.000Z'),
      dryRun: false,
      resolveBinding,
    };

    const out = await new RelationTargetWriter(harness.service).write(
      context,
      record!.reconstructionInput as never,
    );

    expect(out).toMatchObject({
      targetKind: 'relation',
      targetId: ids.relation,
      change: 'created',
      provenance: { externalId: `${orgId}:device-relationships:site-device-edge` },
    });
    expect(resolveBinding).toHaveBeenCalledWith({
      resourceKey: 'sites',
      externalId: `${orgId}:sites:${siteId}`,
    });
    expect(resolveBinding).toHaveBeenCalledWith({
      resourceKey: 'devices',
      externalId: `${orgId}:devices:${deviceId}`,
    });
    expect(harness.tx.relation.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ relationType: 'site_device' })],
        skipDuplicates: true,
      }),
    );
    expect(harness.audit.logWithClient).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({ actorId: ids.actor, entityId: ids.relation }),
    );
  });

  it('creates and audits an idempotent relation in one transaction', async () => {
    const { service, audit, tx } = setup();
    await expect(service.writeFromIntegration(input)).resolves.toEqual({
      targetId: ids.relation,
      companyId: ids.company,
      change: 'created',
    });
    expect(tx.relation.createMany).toHaveBeenCalledTimes(1);
    expect(audit.logWithClient).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        actorId: ids.actor,
        entityId: ids.relation,
        after: { integrationId: ids.integration, change: 'created' },
      }),
    );
  });

  it('returns the exact existing target id without mutating an unchanged verified relation', async () => {
    const existing = relation();
    const { service, prisma, tx } = setup({ bound: existing, composite: existing, binding: binding() });
    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.relation,
    })).resolves.toEqual({ targetId: ids.relation, companyId: ids.company, change: 'unchanged' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.relation.createMany).not.toHaveBeenCalled();
  });

  it('rejects an arbitrary manual relation before mutation', async () => {
    const existing = relation();
    const { service, tx } = setup({ bound: existing, composite: existing });
    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.relation,
    })).resolves.toMatchObject({ change: 'blocked', gap: { details: { reasonCode: 'manual_ownership' } } });
    expect(tx.relation.deleteMany).not.toHaveBeenCalled();
  });

  it('updates a verified relation composite and preserves its exact target id', async () => {
    const existing = relation({ relationType: 'old-type' });
    const persistedBinding = binding({
      state: 'stale',
      provenance: {
        integrationId: ids.integration,
        externalOrgId: 'org',
        resourceKey: 'relations',
        externalId: 'org:relations:runbook',
        ownership: 'breeze',
        state: 'stale',
      },
    });
    const { service, audit, tx } = setup({
      bound: existing,
      binding: persistedBinding,
    });
    await expect(service.writeFromIntegration({
      ...input, existingTargetId: ids.relation,
    })).resolves.toEqual({ targetId: ids.relation, companyId: ids.company, change: 'updated' });
    expect(tx.relation.updateMany).toHaveBeenCalledWith({
      where: {
        id: ids.relation,
        companyId: ids.company,
        sourceType: 'Asset',
        sourceId: ids.asset,
        targetType: 'Article',
        targetId: ids.article,
        relationType: 'old-type',
      },
      data: {
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        targetType: input.targetType,
        targetId: input.targetId,
        relationType: input.relationType,
      },
    });
    expect(tx.relation.deleteMany).not.toHaveBeenCalled();
    expect(tx.relation.createMany).not.toHaveBeenCalled();
    expect(persistedBinding.relationId).toBe(ids.relation);
    expect(audit.logWithClient).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'integration.relation.updated',
        entityId: ids.relation,
      }),
    );
  });

  it('re-reads instead of resurrecting a relation deleted between read and write', async () => {
    const existing = relation({ relationType: 'old-type' });
    const { service, prisma, audit, tx } = setup({ binding: binding() });
    prisma.relation.findUnique.mockResolvedValueOnce(existing).mockResolvedValueOnce(null);
    // The guarded attempt loses the race (row deleted after the read);
    // the retry re-reads and reports the missing target cleanly.
    tx.relation.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.relation,
    })).resolves.toMatchObject({
      change: 'blocked',
      gap: { kind: 'missing_dependency', details: { reasonCode: 'target_not_found' } },
    });

    expect(tx.relation.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.relation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: ids.relation, relationType: 'old-type' }),
    }));
    expect(audit.logWithClient).not.toHaveBeenCalled();
  });

  it('reports a synchronization gap when the guarded update keeps conflicting', async () => {
    const existing = relation({ relationType: 'old-type' });
    const { service, prisma, audit, tx } = setup({ bound: existing, binding: binding() });
    tx.relation.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.relation,
    })).resolves.toMatchObject({
      targetId: ids.relation,
      change: 'blocked',
      gap: {
        kind: 'synchronization_error',
        details: { reasonCode: 'target_revision_conflict' },
      },
    });

    expect(tx.relation.updateMany).toHaveBeenCalledTimes(3);
    expect(prisma.relation.findUnique).toHaveBeenCalledTimes(3);
    expect(audit.logWithClient).not.toHaveBeenCalled();
  });

  it('does not claim a composite owner created between read and write', async () => {
    const { service, prisma, audit, tx } = setup();
    // Zero inserted rows: another writer claimed the composite key
    // after the pre-check; the retry re-reads and reports ownership.
    tx.relation.createMany.mockResolvedValue({ count: 0 });
    prisma.relation.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(relation({ createdBy: ids.other }));

    await expect(service.writeFromIntegration(input)).resolves.toMatchObject({
      change: 'blocked',
      gap: { kind: 'ambiguous', details: { reasonCode: 'manual_ownership' } },
    });

    expect(tx.relation.createMany).toHaveBeenCalledTimes(1);
    expect(audit.logWithClient).not.toHaveBeenCalled();
  });

  it('uses the caller page transaction for endpoint, target, composite, and binding reads', async () => {
    const existing = relation();
    const { service, prisma, tx } = setup({
      bound: existing,
      composite: existing,
      binding: binding(),
    });

    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.relation,
      tx: tx as never,
    })).resolves.toEqual({
      targetId: ids.relation,
      companyId: ids.company,
      change: 'unchanged',
    });

    expect(tx.asset.findFirst).toHaveBeenCalled();
    expect(tx.article.findFirst).toHaveBeenCalled();
    expect(tx.relation.findUnique).toHaveBeenCalledWith({ where: { id: ids.relation } });
    expect(tx.relation.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({ companyId: ids.company, relationType: input.relationType }),
    });
    expect(tx.integrationSyncRecord.findUnique).toHaveBeenCalled();
    expect(prisma.asset.findFirst).not.toHaveBeenCalled();
    expect(prisma.article.findFirst).not.toHaveBeenCalled();
    expect(prisma.relation.findUnique).not.toHaveBeenCalled();
    expect(prisma.relation.findFirst).not.toHaveBeenCalled();
    expect(prisma.integrationSyncRecord.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('creates with same-page endpoints and blocks same-page composite collisions', async () => {
    const created = setup();
    created.tx.relation.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(relation());

    await expect(created.service.writeFromIntegration({
      ...input,
      tx: created.tx as never,
    })).resolves.toEqual({
      targetId: ids.relation,
      companyId: ids.company,
      change: 'created',
    });
    expect(created.tx.relation.createMany).toHaveBeenCalledTimes(1);
    expect(created.prisma.asset.findFirst).not.toHaveBeenCalled();
    expect(created.prisma.article.findFirst).not.toHaveBeenCalled();
    expect(created.prisma.$transaction).not.toHaveBeenCalled();

    const collision = setup({ composite: relation() });
    await expect(collision.service.writeFromIntegration({
      ...input,
      tx: collision.tx as never,
    })).resolves.toMatchObject({
      change: 'blocked',
      gap: { details: { reasonCode: 'manual_ownership' } },
    });
    expect(collision.tx.relation.createMany).not.toHaveBeenCalled();
    expect(collision.prisma.relation.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null], ['wrong mapping', binding({ integrationCompanyMappingId: ids.other })],
    ['wrong resource', binding({ resourceId: ids.other })], ['wrong external id', binding({ externalId: 'wrong' })],
    ['wrong kind', binding({ targetKind: 'asset' })], ['wrong id', binding({ relationId: ids.other })],
    ['wrong company', binding({ companyId: 'other-company' })],
    ['blocked', binding({ state: 'blocked', provenance: { integrationId: ids.integration, ownership: 'breeze', state: 'blocked' } })],
    ['manual', binding({ provenance: { integrationId: ids.integration, ownership: 'weavestream', state: 'active' } })],
  ])('rejects a %s relation binding despite a forged legacy flag', async (_label, persistedBinding) => {
    const existing = relation({ relationType: 'old-type' });
    const { service, tx } = setup({ bound: existing, binding: persistedBinding });
    await expect(service.writeFromIntegration({ ...input, existingTargetId: ids.relation, ownershipVerified: true } as never))
      .resolves.toMatchObject({ change: 'blocked', gap: { details: { reasonCode: 'manual_ownership' } } });
    expect(tx.relation.deleteMany).not.toHaveBeenCalled();
  });

  it('keeps relation dry-run side-effect free', async () => {
    const { service, prisma, tx } = setup();
    await expect(service.writeFromIntegration({ ...input, dryRun: true })).resolves.toMatchObject({ change: 'created' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.relation.createMany).not.toHaveBeenCalled();
  });

  it('blocks wrong-company dependencies and unbound composite collisions', async () => {
    const wrong = setup();
    wrong.prisma.asset.findFirst.mockResolvedValue(null);
    await expect(wrong.service.writeFromIntegration(input)).resolves.toMatchObject({
      change: 'blocked', gap: { details: { reasonCode: 'dependency_not_found' } },
    });
    const collision = setup({ composite: relation() });
    await expect(collision.service.writeFromIntegration(input)).resolves.toMatchObject({
      change: 'blocked', gap: { details: { reasonCode: 'manual_ownership' } },
    });
  });

  it('does not commit a relation when its attributed audit fails', async () => {
    const { service, wasCommitted } = setup({ auditFails: true });
    await expect(service.writeFromIntegration(input)).rejects.toThrow('audit failed');
    expect(wasCommitted()).toBe(false);
  });
});
