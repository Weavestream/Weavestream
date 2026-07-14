import { RelationsService } from './relations.service.js';

const ids = {
  company: '53000000-0000-0000-0000-000000000001',
  actor: '53000000-0000-0000-0000-000000000002',
  integration: '53000000-0000-0000-0000-000000000003',
  relation: '53000000-0000-0000-0000-000000000004',
  asset: '53000000-0000-0000-0000-000000000005',
  article: '53000000-0000-0000-0000-000000000006',
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

function setup(options: { bound?: unknown; composite?: unknown; auditFails?: boolean } = {}) {
  let committed = false;
  const tx = {
    relation: {
      upsert: jest.fn().mockResolvedValue(relation()),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue(relation()),
    },
    auditLog: { create: jest.fn() },
  };
  const prisma = {
    asset: { findFirst: jest.fn().mockResolvedValue({ id: ids.asset }) },
    article: { findFirst: jest.fn().mockResolvedValue({ id: ids.article }) },
    password: { findFirst: jest.fn() },
    relation: {
      findUnique: jest.fn().mockResolvedValue(options.bound ?? null),
      findFirst: jest.fn().mockResolvedValue(options.composite ?? null),
      upsert: tx.relation.upsert,
    },
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
  auditActorId: ids.actor,
  dryRun: false,
  ownershipVerified: false,
  sourceType: 'Asset' as const,
  sourceId: ids.asset,
  targetType: 'Article' as const,
  targetId: ids.article,
  relationType: 'runbook',
};

describe('RelationsService integration system writes', () => {
  it('creates and audits an idempotent relation in one transaction', async () => {
    const { service, audit, tx } = setup();
    await expect(service.writeFromIntegration(input)).resolves.toEqual({
      targetId: ids.relation,
      companyId: ids.company,
      change: 'created',
    });
    expect(tx.relation.upsert).toHaveBeenCalledTimes(1);
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
    const { service, prisma, tx } = setup({ bound: existing, composite: existing });
    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.relation,
      ownershipVerified: true,
    })).resolves.toEqual({ targetId: ids.relation, companyId: ids.company, change: 'unchanged' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.relation.upsert).not.toHaveBeenCalled();
  });

  it('rejects an arbitrary manual relation before mutation', async () => {
    const existing = relation();
    const { service, tx } = setup({ bound: existing, composite: existing });
    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.relation,
      ownershipVerified: false,
    })).resolves.toMatchObject({ change: 'blocked', gap: { details: { reasonCode: 'manual_ownership' } } });
    expect(tx.relation.deleteMany).not.toHaveBeenCalled();
  });

  it('updates a verified relation composite and preserves its exact target id', async () => {
    const existing = relation({ relationType: 'old-type' });
    const { service } = setup({ bound: existing });
    await expect(service.writeFromIntegration({
      ...input, existingTargetId: ids.relation, ownershipVerified: true,
    })).resolves.toEqual({ targetId: ids.relation, companyId: ids.company, change: 'updated' });
  });

  it('keeps relation dry-run side-effect free', async () => {
    const { service, prisma, tx } = setup();
    await expect(service.writeFromIntegration({ ...input, dryRun: true })).resolves.toMatchObject({ change: 'created' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.relation.upsert).not.toHaveBeenCalled();
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
