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
      prisma as never, {} as never, { get: jest.fn().mockReturnValue({ add }) } as never, {} as never,
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
  });
});
