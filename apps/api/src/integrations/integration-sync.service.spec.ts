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
      status: 'queued' as const, dryRun: false, triggeredBy: 'actor-1',
      startedAt: null, finishedAt: null, totals: null, error: null,
      createdAt: new Date('2026-07-14T00:00:00.000Z'),
    };
    const prisma = {
      integration: { findUnique: jest.fn().mockResolvedValue({ id: 'integration', driver: 'breeze', status }) },
      integrationCompanyMapping: { count: jest.fn().mockResolvedValue(1) },
      integrationResource: { count: jest.fn().mockResolvedValue(2) },
      integrationSyncRun: { create: jest.fn(async ({ data }: { data: { dryRun: boolean } }) => ({ ...run, dryRun: data.dryRun })) },
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
      id: 'run-1', kind: 'manual', dryRun, triggeredBy: 'actor-1',
    });
    expect(prisma.integrationSyncRun.create).toHaveBeenCalledWith({
      data: { integrationId: 'integration', kind: 'manual', status: 'queued', dryRun, triggeredBy: 'actor-1' },
    });
    expect(add).toHaveBeenCalledWith(
      'manual',
      { kind: 'manual', integrationId: 'integration', triggeredBy: 'actor-1', dryRun },
      expect.objectContaining({ jobId: 'manual-run-1', attempts: 2 }),
    );
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      actorId: 'actor-1', entityId: 'run-1', ip: meta.ip, userAgent: meta.userAgent,
      after: { kind: 'manual', dryRun, mappings: 1 },
    }));
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
        id: 'run', integrationId: 'integration', dryRun: false, status: 'queued',
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
        resourceIds: ['subnet', 'reservation'], auditActorId: 'creator',
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
        id: 'run', integrationId: 'integration', dryRun: false, status: 'queued',
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
