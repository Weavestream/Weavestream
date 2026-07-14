import {
  IntegrationSyncService,
  buildResourceExecutionStages,
  mergeAggregate,
} from './integration-sync.service.js';

const totals = (created: number) => ({
  fetched: created, created, updated: 0, unchanged: 0, claimed: 0, archived: 0,
  skippedAmbiguous: 0, skippedManual: 0, skippedArchived: 0, stale: 0,
  restored: 0, blocked: 0, secretBlocked: 0, missingDependency: 0, errors: 0,
});

describe('mergeAggregate retry replacement', () => {
  it('replaces a resource contribution instead of double-counting it', () => {
    const first = mergeAggregate(null, 'devices', totals(3), 'failed');
    const retried = mergeAggregate(first, 'devices', totals(1), 'succeeded');
    expect(retried).toMatchObject({
      fetched: 1,
      created: 1,
      byResource: { devices: { created: 1, status: 'succeeded' } },
    });
  });
});

describe('buildResourceExecutionStages', () => {
  it('puts reservations after both subnets and devices', () => {
    const stages = buildResourceExecutionStages([
      { id: 'reservation', resourceKey: 'reservations', dependsOnResourceKeys: ['subnets', 'devices'] },
      { id: 'device', resourceKey: 'devices', dependsOnResourceKeys: [] },
      { id: 'subnet', resourceKey: 'subnets', dependsOnResourceKeys: [] },
    ]);
    expect(stages).toEqual([
      expect.arrayContaining([expect.objectContaining({ resourceKey: 'devices' }), expect.objectContaining({ resourceKey: 'subnets' })]),
      [expect.objectContaining({ resourceKey: 'reservations' })],
    ]);
  });

  it('puts relations after every declared entity dependency and rejects cycles', () => {
    const stages = buildResourceExecutionStages([
      { id: 'device', resourceKey: 'devices', dependsOnResourceKeys: [] },
      { id: 'article', resourceKey: 'articles', dependsOnResourceKeys: [] },
      { id: 'relation', resourceKey: 'relations', dependsOnResourceKeys: ['devices', 'articles'] },
    ]);
    expect(stages[1]).toEqual([expect.objectContaining({ resourceKey: 'relations' })]);
    expect(() => buildResourceExecutionStages([
      { id: 'a', resourceKey: 'a', dependsOnResourceKeys: ['b'] },
      { id: 'b', resourceKey: 'b', dependsOnResourceKeys: ['a'] },
    ])).toThrow(/cycle/i);
  });
});

describe('IntegrationSyncService.triggerManual', () => {
  const actor = { id: 'actor-1' } as never;
  const meta = { ip: '127.0.0.1', userAgent: 'jest' };

  function setup(status: 'ACTIVE' | 'PAUSED' | 'DISABLED') {
    const run = {
      id: 'run-1', integrationId: 'integration', kind: 'manual' as const,
      status: 'queued' as const, mode: 'incremental' as const, dryRun: false, triggeredBy: 'actor-1',
      startedAt: null, finishedAt: null, totals: null, error: null,
      createdAt: new Date('2026-07-14T00:00:00.000Z'),
    };
    const prisma = {
      integration: { findUnique: jest.fn().mockResolvedValue({ id: 'integration', driver: 'breeze', status }) },
      integrationCompanyMapping: { count: jest.fn().mockResolvedValue(1) },
      integrationResource: { count: jest.fn().mockResolvedValue(2) },
      integrationSyncRun: { create: jest.fn(async ({ data }: { data: { dryRun: boolean; mode: 'incremental' | 'full' } }) => ({ ...run, dryRun: data.dryRun, mode: data.mode })) },
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'actor-1', name: 'Actor', email: 'actor@example.com' }]) },
    };
    const add = jest.fn().mockResolvedValue(undefined);
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new IntegrationSyncService(
      prisma as never,
      audit as never,
      { get: jest.fn().mockReturnValue({ add }) } as never,
      { has: jest.fn().mockReturnValue(true), kindOf: jest.fn().mockReturnValue('pull') } as never,
    );
    return { service, prisma, add, audit };
  }

  it.each([
    ['ACTIVE', false],
    ['PAUSED', true],
  ] as const)('allows %s manual runs and propagates dryRun=%s through persistence, queue, and audit', async (status, dryRun) => {
    const { service, prisma, add, audit } = setup(status);

    await expect(service.triggerManual(actor, 'integration', dryRun, meta)).resolves.toMatchObject({
      id: 'run-1', kind: 'manual', mode: 'incremental', dryRun, triggeredBy: 'actor-1',
    });
    expect(prisma.integrationSyncRun.create).toHaveBeenCalledWith({
      data: { integrationId: 'integration', kind: 'manual', mode: 'incremental', status: 'queued', dryRun, triggeredBy: 'actor-1' },
    });
    expect(add).toHaveBeenCalledWith(
      'manual',
      { kind: 'manual', integrationId: 'integration', triggeredBy: 'actor-1', mode: 'incremental', dryRun },
      expect.objectContaining({ jobId: 'manual-run-1', attempts: 2 }),
    );
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      actorId: 'actor-1', entityId: 'run-1', ip: meta.ip, userAgent: meta.userAgent,
      after: { kind: 'manual', mode: 'incremental', dryRun, mappings: 1 },
    }));
  });

  it('persists and queues an explicitly requested full manual run', async () => {
    const { service, prisma, add } = setup('ACTIVE');

    await expect(service.triggerManual(actor, 'integration', false, meta, 'full')).resolves.toMatchObject({
      mode: 'full',
    });
    expect(prisma.integrationSyncRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ mode: 'full' }),
    }));
    expect(add).toHaveBeenCalledWith(
      'manual',
      expect.objectContaining({ mode: 'full' }),
      expect.any(Object),
    );
  });

  it('rejects DISABLED before persistence, queueing, or audit', async () => {
    const { service, prisma, add, audit } = setup('DISABLED');

    await expect(service.triggerManual(actor, 'integration', true, meta)).rejects.toThrow(/DISABLED/i);
    expect(prisma.integrationCompanyMapping.count).not.toHaveBeenCalled();
    expect(prisma.integrationSyncRun.create).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
});

describe('IntegrationSyncService.beginRun', () => {
  it('enqueues one whole-DAG job per mapping with the scheduled integration actor', async () => {
    const add = jest.fn();
    const tx = {
      integrationSyncRun: { update: jest.fn() },
      integrationSyncRunCompanyResult: { upsert: jest.fn() },
    };
    const prisma = {
      integrationSyncRun: { findUnique: jest.fn().mockResolvedValue({
        id: 'run', integrationId: 'integration', mode: 'full', dryRun: false, status: 'queued',
        triggeredBy: null, integration: { createdBy: 'creator' },
      }) },
      integrationCompanyMapping: { findMany: jest.fn().mockResolvedValue([
        { id: 'mapping-a', companyId: 'company-a' },
        { id: 'mapping-b', companyId: 'company-b' },
      ]) },
      integrationResource: { findMany: jest.fn().mockResolvedValue([
        { id: 'reservation', resourceKey: 'reservations', dependsOnResourceKeys: ['subnets'] },
        { id: 'subnet', resourceKey: 'subnets', dependsOnResourceKeys: [] },
      ]) },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    };
    const service = new IntegrationSyncService(
      prisma as never, {} as never, { get: jest.fn().mockReturnValue({ add }) } as never,
      { get: jest.fn().mockReturnValue({ listSourceOrgs: jest.fn() }) } as never,
    );
    const result = await service.beginRun('run');
    expect(result.jobs).toHaveLength(2);
    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledWith(
      'sync-mapping',
      expect.objectContaining({
        integrationCompanyMappingId: 'mapping-a', resourceId: 'subnet',
        resourceIds: ['subnet', 'reservation'], auditActorId: 'creator', mode: 'full',
      }),
      expect.objectContaining({ attempts: 3 }),
    );
    expect(prisma.integrationCompanyMapping.findMany).toHaveBeenCalledWith({
      where: { integrationId: 'integration', enabled: true },
      select: { id: true, companyId: true },
    });
  });

  it('skips an upstream organization that has no persisted enabled company mapping', async () => {
    const add = jest.fn();
    const listSourceOrgs = jest.fn().mockResolvedValue([
      { externalId: 'mapped-org', name: 'Mapped' },
      { externalId: 'unmapped-org', name: 'Unmapped' },
    ]);
    const tx = {
      integrationSyncRun: { update: jest.fn() },
      integrationSyncRunCompanyResult: { upsert: jest.fn() },
    };
    const prisma = {
      integrationSyncRun: { findUnique: jest.fn().mockResolvedValue({
        id: 'run', integrationId: 'integration', mode: 'incremental', dryRun: false, status: 'queued',
        triggeredBy: 'actor', integration: { createdBy: 'creator' },
      }) },
      integrationCompanyMapping: { findMany: jest.fn().mockResolvedValue([
        { id: 'persisted-mapping', companyId: 'company-a' },
      ]) },
      integrationResource: { findMany: jest.fn().mockResolvedValue([
        { id: 'sites', resourceKey: 'sites', dependsOnResourceKeys: [] },
      ]) },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    };
    const service = new IntegrationSyncService(
      prisma as never, {} as never, { get: jest.fn().mockReturnValue({ add }) } as never,
      { get: jest.fn().mockReturnValue({ listSourceOrgs }) } as never,
    );

    const result = await service.beginRun('run');

    expect(result.jobs.map((job) => job.mappingId)).toEqual(['persisted-mapping']);
    expect(add).toHaveBeenCalledTimes(1);
    expect(listSourceOrgs).not.toHaveBeenCalled();
  });
});

describe('IntegrationSyncService scheduled reconstruction mode', () => {
  const now = new Date('2026-07-14T12:00:00.000Z');

  function setup(options: {
    activeFull?: number;
    mappings?: number;
    resources?: number;
    recentFullCheckpoints?: number;
    createError?: unknown;
  } = {}) {
    const create = jest.fn()
      .mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => {
        if (options.createError) throw options.createError;
        return { id: 'scheduled-run', ...data };
      })
      .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'fallback-run', ...data,
      }));
    const prisma = {
      integrationSyncRun: {
        count: jest.fn().mockResolvedValue(options.activeFull ?? 0),
        create,
      },
      integrationCompanyMapping: { count: jest.fn().mockResolvedValue(options.mappings ?? 2) },
      integrationResource: { count: jest.fn().mockResolvedValue(options.resources ?? 3) },
      integrationSyncCheckpoint: { count: jest.fn().mockResolvedValue(options.recentFullCheckpoints ?? 6) },
    };
    const service = new IntegrationSyncService(
      prisma as never, {} as never, {} as never, {} as never,
    );
    return { service, prisma, create };
  }

  it('selects full when any relevant mapping/resource checkpoint is missing or older than 24 hours', async () => {
    const { service, prisma } = setup({ recentFullCheckpoints: 5 });

    await expect(service.selectScheduledMode('integration', now)).resolves.toBe('full');
    expect(prisma.integrationSyncCheckpoint.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        mode: 'full',
        lastFullCompletedAt: { gte: new Date('2026-07-13T12:00:00.000Z') },
      }),
    });
  });

  it('selects incremental only when every relevant scope completed a full run within 24 hours', async () => {
    const { service } = setup({ recentFullCheckpoints: 6 });
    await expect(service.selectScheduledMode('integration', now)).resolves.toBe('incremental');
  });

  it('suppresses an overlapping full sweep even when full was explicitly requested', async () => {
    const { service, create } = setup({ activeFull: 1 });

    await expect(service.createScheduledRun('integration', 'full', now)).resolves.toMatchObject({
      mode: 'incremental',
    });
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ mode: 'incremental' }) });
  });

  it('falls back to incremental when the database full-run uniqueness guard wins a race', async () => {
    const collision = Object.assign(new Error('unique constraint'), { code: 'P2002' });
    const { service, create } = setup({ recentFullCheckpoints: 0, createError: collision });

    await expect(service.createScheduledRun('integration', undefined, now)).resolves.toMatchObject({
      id: 'fallback-run', mode: 'incremental',
    });
    expect(create).toHaveBeenNthCalledWith(1, { data: expect.objectContaining({ mode: 'full' }) });
    expect(create).toHaveBeenNthCalledWith(2, { data: expect.objectContaining({ mode: 'incremental' }) });
  });
});

describe('IntegrationSyncService.closeRun cancellation', () => {
  it('never overwrites a cancelled parent with a child-derived terminal status', async () => {
    const tx = {
      integrationSyncRun: { updateMany: jest.fn() },
      integration: { update: jest.fn() },
    };
    const prisma = {
      integrationSyncRun: { findUnique: jest.fn().mockResolvedValue({
        id: 'cancelled-run', integrationId: 'integration', status: 'cancelled',
        companyResults: [{ status: 'succeeded', totals: {}, error: null }],
      }) },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    };
    const audit = { log: jest.fn() };
    const service = new IntegrationSyncService(
      prisma as never, audit as never, {} as never, {} as never,
    );

    await service.closeRun('cancelled-run', 'actor');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.integrationSyncRun.updateMany).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('does not revive a run cancelled between the aggregate read and terminal transaction', async () => {
    const tx = {
      integrationSyncRun: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      integration: { update: jest.fn() },
    };
    const prisma = {
      integrationSyncRun: { findUnique: jest.fn().mockResolvedValue({
        id: 'racing-run', integrationId: 'integration', status: 'running',
        companyResults: [{ status: 'succeeded', totals: {}, error: null }],
      }) },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<boolean>) => callback(tx)),
    };
    const audit = { log: jest.fn() };
    const service = new IntegrationSyncService(
      prisma as never, audit as never, {} as never, {} as never,
    );

    await service.closeRun('racing-run', 'actor');

    expect(tx.integrationSyncRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'racing-run', status: { in: ['queued', 'running'] } },
    }));
    expect(tx.integration.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
});
