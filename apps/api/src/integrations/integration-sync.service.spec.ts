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
      integrationSyncRun: {
        create: jest.fn(async ({ data }: { data: { dryRun: boolean; mode: 'incremental' | 'full' } }) => ({ ...run, dryRun: data.dryRun, mode: data.mode })),
        findFirst: jest.fn(),
      },
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
      { kind: 'manual', integrationId: 'integration', syncRunId: 'run-1', triggeredBy: 'actor-1', mode: 'incremental', dryRun },
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

  it('keeps manual incrementals explicit and independent from scheduled single-flight', async () => {
    const { service, prisma, add } = setup('ACTIVE');

    await expect(service.triggerManual(actor, 'integration', false, meta, 'incremental'))
      .resolves.toMatchObject({ kind: 'manual', mode: 'incremental' });

    expect(prisma.integrationSyncRun.findFirst).not.toHaveBeenCalled();
    expect(prisma.integrationSyncRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'manual', mode: 'incremental' }),
    });
    expect(add).toHaveBeenCalledWith(
      'manual',
      expect.objectContaining({ kind: 'manual', mode: 'incremental' }),
      expect.any(Object),
    );
  });

  it('rejects a manual full while scheduled work owns the durable integration flight', async () => {
    const collision = Object.assign(new Error('active scheduled run'), { code: 'P2002' });
    const { service, prisma, add } = setup('ACTIVE');
    prisma.integrationSyncRun.create.mockRejectedValueOnce(collision);

    await expect(service.triggerManual(actor, 'integration', false, meta, 'full'))
      .rejects.toThrow(/scheduled sync or full reconstruction sync is already queued or running/i);
    expect(add).not.toHaveBeenCalled();
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
  it.each([
    {
      label: 'no enabled mappings',
      mappings: [],
      resources: [{ id: 'devices', resourceKey: 'devices', dependsOnResourceKeys: [] }],
      expectedChildResults: 0,
    },
    {
      label: 'no eligible resources',
      mappings: [{ id: 'mapping-a', companyId: 'company-a' }],
      resources: [],
      expectedChildResults: 1,
    },
  ])('atomically succeeds a zero-work run with $label', async ({
    mappings,
    resources,
    expectedChildResults,
  }) => {
    const add = jest.fn();
    const tx = {
      integrationSyncRun: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      integrationSyncRunCompanyResult: { upsert: jest.fn() },
      integration: { update: jest.fn() },
    };
    const prisma = {
      integrationSyncRun: { findUnique: jest.fn().mockResolvedValue({
        id: 'run', integrationId: 'integration', mode: 'incremental', dryRun: false,
        status: 'queued', startedAt: null, triggeredBy: null,
        integration: { createdBy: 'creator' },
      }) },
      integrationCompanyMapping: { findMany: jest.fn().mockResolvedValue(mappings) },
      integrationResource: { findMany: jest.fn().mockResolvedValue(resources) },
      integrationSyncRunCompanyResult: { findMany: jest.fn() },
      $transaction: jest.fn(
        async (callback: (client: typeof tx) => Promise<boolean>) => callback(tx),
      ),
    };
    const audit = { log: jest.fn() };
    const service = new IntegrationSyncService(
      prisma as never, audit as never,
      { get: jest.fn().mockReturnValue({ add }) } as never, {} as never,
    );

    await expect(service.beginRun('run')).resolves.toMatchObject({ jobs: [] });

    expect(tx.integrationSyncRun.updateMany).toHaveBeenCalledWith({
      where: { id: 'run', status: { in: ['queued', 'running'] } },
      data: expect.objectContaining({
        status: 'succeeded', startedAt: expect.any(Date), finishedAt: expect.any(Date),
        totals: totals(0), error: null,
      }),
    });
    expect(tx.integrationSyncRunCompanyResult.upsert).toHaveBeenCalledTimes(
      expectedChildResults,
    );
    if (expectedChildResults > 0) {
      expect(tx.integrationSyncRunCompanyResult.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: 'succeeded', totals: totals(0) }),
        }),
      );
    }
    expect(tx.integration.update).toHaveBeenCalledWith({
      where: { id: 'integration' },
      data: expect.objectContaining({ lastRunAt: expect.any(Date), lastRunStatus: 'succeeded' }),
    });
    expect(prisma.integrationSyncRunCompanyResult.findMany).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      actorId: 'creator', action: 'integration.sync.finished', entityId: 'run',
      after: { totals: totals(0) },
    }));
  });

  it('enqueues one whole-DAG job per mapping with the scheduled integration actor', async () => {
    const add = jest.fn();
    const tx = {
      integrationSyncRun: { updateMany: jest.fn() },
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
      integrationSyncRunCompanyResult: { findMany: jest.fn().mockResolvedValue([
        { integrationCompanyMappingId: 'mapping-a', status: 'queued' },
        { integrationCompanyMappingId: 'mapping-b', status: 'queued' },
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

  it('preserves existing child progress and only refills queued fan-out jobs on retry', async () => {
    const add = jest.fn();
    const tx = {
      integrationSyncRun: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      integrationSyncRunCompanyResult: { upsert: jest.fn() },
    };
    const prisma = {
      integrationSyncRun: { findUnique: jest.fn().mockResolvedValue({
        id: 'run', integrationId: 'integration', mode: 'full', dryRun: false, status: 'running',
        triggeredBy: null, integration: { createdBy: 'creator' },
      }) },
      integrationCompanyMapping: { findMany: jest.fn().mockResolvedValue([
        { id: 'mapping-queued', companyId: 'company-a' },
        { id: 'mapping-complete', companyId: 'company-b' },
      ]) },
      integrationResource: { findMany: jest.fn().mockResolvedValue([
        { id: 'devices', resourceKey: 'devices', dependsOnResourceKeys: [] },
      ]) },
      integrationSyncRunCompanyResult: { findMany: jest.fn().mockResolvedValue([
        { integrationCompanyMappingId: 'mapping-queued', status: 'queued' },
        { integrationCompanyMappingId: 'mapping-complete', status: 'succeeded' },
      ]) },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    };
    const service = new IntegrationSyncService(
      prisma as never, {} as never, { get: jest.fn().mockReturnValue({ add }) } as never,
      {} as never,
    );

    await service.beginRun('run');

    expect(tx.integrationSyncRun.updateMany).toHaveBeenCalledWith({
      where: { id: 'run', status: 'queued' },
      data: { status: 'running', startedAt: expect.any(Date) },
    });
    for (const call of tx.integrationSyncRunCompanyResult.upsert.mock.calls) {
      expect(call[0].update).toEqual({});
    }
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith('sync-mapping', expect.objectContaining({
      integrationCompanyMappingId: 'mapping-queued', mode: 'full',
    }), expect.any(Object));
  });

  it('skips an upstream organization that has no persisted enabled company mapping', async () => {
    const add = jest.fn();
    const listSourceOrgs = jest.fn().mockResolvedValue([
      { externalId: 'mapped-org', name: 'Mapped' },
      { externalId: 'unmapped-org', name: 'Unmapped' },
    ]);
    const tx = {
      integrationSyncRun: { updateMany: jest.fn() },
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
      integrationSyncRunCompanyResult: { findMany: jest.fn().mockResolvedValue([
        { integrationCompanyMappingId: 'persisted-mapping', status: 'queued' },
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
    activeScheduled?: Record<string, unknown> | null;
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
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(options.activeScheduled ?? null),
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

  it.each(['queued', 'running'] as const)(
    'coalesces a distinct scheduler occurrence while the scheduled incremental is %s',
    async (status) => {
      const active = {
        id: `active-${status}`,
        integrationId: 'integration',
        kind: 'scheduled',
        mode: 'incremental',
        status,
        deliveryKey: 'scheduled:tick-1',
      };
      const { service, create } = setup({ activeScheduled: active });

      await expect(service.createScheduledRun(
        'integration', 'incremental', now, 'scheduled:tick-2',
      )).resolves.toMatchObject({
        id: `active-${status}`,
        deliveryKey: 'scheduled:tick-1',
        shouldBegin: false,
      });
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('coalesces a distinct occurrence when the database single-flight guard wins a race', async () => {
    const collision = Object.assign(new Error('scheduled single-flight race'), { code: 'P2002' });
    const { service, prisma, create } = setup({ createError: collision });
    prisma.integrationSyncRun.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'race-winner',
        integrationId: 'integration',
        kind: 'scheduled',
        mode: 'incremental',
        status: 'queued',
        deliveryKey: 'scheduled:tick-race-winner',
      });

    await expect(service.createScheduledRun(
      'integration', 'incremental', now, 'scheduled:tick-race-loser',
    )).resolves.toMatchObject({ id: 'race-winner', shouldBegin: false });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each(['succeeded', 'failed'] as const)(
    'creates the next scheduled occurrence after the prior run has %s',
    async (_terminalStatus) => {
      const { service, prisma, create } = setup({ activeScheduled: null });

      await expect(service.createScheduledRun(
        'integration', 'incremental', now, 'scheduled:next-tick',
      )).resolves.toMatchObject({
        id: 'scheduled-run',
        deliveryKey: 'scheduled:next-tick',
        shouldBegin: true,
      });
      expect(prisma.integrationSyncRun.findFirst).toHaveBeenCalledWith({
        where: {
          integrationId: 'integration',
          status: { in: ['queued', 'running'] },
          OR: [{ kind: 'scheduled' }, { mode: 'full' }],
        },
        orderBy: [{ mode: 'desc' }, { status: 'desc' }, { createdAt: 'asc' }],
      });
      expect(create).toHaveBeenCalledTimes(1);
    },
  );

  it('coalesces into an active scheduled full instead of creating an incremental backlog', async () => {
    const { service, create } = setup({
      activeFull: 1,
      activeScheduled: {
        id: 'active-full',
        integrationId: 'integration',
        kind: 'scheduled',
        mode: 'full',
        status: 'running',
        deliveryKey: 'scheduled:full-tick',
      },
    });

    await expect(service.createScheduledRun(
      'integration', 'full', now, 'scheduled:next-tick',
    )).resolves.toMatchObject({ id: 'active-full', mode: 'full', shouldBegin: false });
    expect(create).not.toHaveBeenCalled();
  });

  it('coalesces a scheduled occurrence behind an active manual full', async () => {
    const activeFull = {
      id: 'active-manual-full',
      integrationId: 'integration',
      kind: 'manual',
      mode: 'full',
      status: 'running',
      deliveryKey: null,
    };
    const { service, prisma, create } = setup({ activeScheduled: activeFull });

    await expect(service.createScheduledRun(
      'integration', 'incremental', now, 'scheduled:next-tick',
    )).resolves.toMatchObject({ id: 'active-manual-full', shouldBegin: false });
    expect(prisma.integrationSyncRun.findFirst).toHaveBeenCalledWith({
      where: {
        integrationId: 'integration',
        status: { in: ['queued', 'running'] },
        OR: [{ kind: 'scheduled' }, { mode: 'full' }],
      },
      orderBy: [{ mode: 'desc' }, { status: 'desc' }, { createdAt: 'asc' }],
    });
    expect(create).not.toHaveBeenCalled();
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

  it.each(['queued', 'running'] as const)(
    'returns the exact run already persisted for the same scheduled delivery key while %s',
    async (status) => {
      const { service, prisma, create } = setup();
      prisma.integrationSyncRun.findUnique.mockResolvedValueOnce({
        id: 'persisted-delivery-run', mode: 'full', status, deliveryKey: 'scheduled:tick-1',
      });

      await expect(service.createScheduledRun(
        'integration', undefined, now, 'scheduled:tick-1',
      )).resolves.toMatchObject({ id: 'persisted-delivery-run', mode: 'full', shouldBegin: true });
      expect(create).not.toHaveBeenCalled();
      expect(prisma.integrationSyncRun.count).not.toHaveBeenCalled();
    },
  );

  it.each(['succeeded', 'failed', 'cancelled'] as const)(
    'coalesces a replayed delivery whose run already %s instead of re-beginning it',
    async (status) => {
      const { service, prisma, create } = setup();
      prisma.integrationSyncRun.findUnique.mockResolvedValueOnce({
        id: 'settled-delivery-run', mode: 'full', status, deliveryKey: 'scheduled:tick-1',
      });

      await expect(service.createScheduledRun(
        'integration', undefined, now, 'scheduled:tick-1',
      )).resolves.toMatchObject({ id: 'settled-delivery-run', shouldBegin: false });
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('re-reads the exact scheduled delivery after a same-key create race', async () => {
    const collision = Object.assign(new Error('delivery key race'), { code: 'P2002' });
    const { service, prisma, create } = setup();
    create.mockReset().mockRejectedValueOnce(collision);
    prisma.integrationSyncRun.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'race-winner', mode: 'full', status: 'queued', deliveryKey: 'scheduled:tick-race',
      });

    await expect(service.createScheduledRun(
      'integration', 'full', now, 'scheduled:tick-race',
    )).resolves.toMatchObject({ id: 'race-winner', mode: 'full', shouldBegin: true });
    expect(create).toHaveBeenCalledTimes(1);
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

describe('IntegrationSyncService.failRun', () => {
  function setupFailRun(run: Record<string, unknown> | null, transitionCount: number) {
    const prisma = {
      integrationSyncRun: {
        findUnique: jest.fn().mockResolvedValue(run),
        updateMany: jest.fn().mockResolvedValue({ count: transitionCount }),
      },
    };
    const audit = { log: jest.fn() };
    const service = new IntegrationSyncService(
      prisma as never, audit as never, {} as never, {} as never,
    );
    return { service, prisma, audit };
  }

  it.each(['queued', 'running'] as const)('fails an active (%s) run and audits the transition', async (status) => {
    const { service, prisma, audit } = setupFailRun(
      { id: 'run-1', status, triggeredBy: 'actor-1' }, 1,
    );

    await service.failRun('run-1', 'fan-out exploded');

    expect(prisma.integrationSyncRun.updateMany).toHaveBeenCalledWith({
      where: { id: 'run-1', status: { in: ['queued', 'running'] } },
      data: expect.objectContaining({ status: 'failed', error: 'fan-out exploded' }),
    });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      actorId: 'actor-1', entityId: 'run-1',
    }));
  });

  it.each(['succeeded', 'cancelled', 'failed'] as const)(
    'never rewrites a %s run when a replayed delivery exhausts its retries',
    async (status) => {
      const { service, prisma, audit } = setupFailRun(
        { id: 'run-1', status, triggeredBy: 'actor-1' }, 0,
      );

      await service.failRun('run-1', 'late replay failure');

      expect(prisma.integrationSyncRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'run-1', status: { in: ['queued', 'running'] } },
      }));
      expect(audit.log).not.toHaveBeenCalled();
    },
  );
});
