import {
  IntegrationSyncMappingWorker,
  dependencySkipOutcome,
} from './integration-sync-mapping.processor.js';

describe('dependencySkipOutcome', () => {
  it('visibly skips a downstream resource without erasing prior totals', () => {
    expect(dependencySkipOutcome('relations', ['devices'])).toMatchObject({
      status: 'failed', resourceKey: 'relations', totals: { missingDependency: 1, blocked: 1 },
      conflicts: [expect.objectContaining({ kind: 'validation_error', message: expect.stringMatching(/devices/) })],
    });
  });
});

describe('IntegrationSyncMappingWorker DAG execution', () => {
  it('runs reservations after subnets/devices and relations after all entity resources', async () => {
    const ids = {
      run: '00000000-0000-0000-0000-000000000001',
      mapping: '00000000-0000-0000-0000-000000000002',
      device: '00000000-0000-0000-0000-000000000003',
      subnet: '00000000-0000-0000-0000-000000000004',
      reservation: '00000000-0000-0000-0000-000000000005',
      article: '00000000-0000-0000-0000-000000000006',
      relation: '00000000-0000-0000-0000-000000000007',
      actor: '00000000-0000-0000-0000-000000000008',
    };
    const resources = [
      { id: ids.reservation, resourceKey: 'reservations', dependsOnResourceKeys: ['subnets', 'devices'] },
      { id: ids.relation, resourceKey: 'relations', dependsOnResourceKeys: ['devices', 'subnets', 'reservations', 'articles'] },
      { id: ids.device, resourceKey: 'devices', dependsOnResourceKeys: [] },
      { id: ids.subnet, resourceKey: 'subnets', dependsOnResourceKeys: [] },
      { id: ids.article, resourceKey: 'articles', dependsOnResourceKeys: [] },
    ];
    const calls: string[] = [];
    const runner = { runMapping: jest.fn(async ({ resourceId }: { resourceId: string }) => {
      calls.push(resourceId);
      const resource = resources.find((candidate) => candidate.id === resourceId)!;
      return {
        status: 'succeeded' as const, resourceKey: resource.resourceKey, companyId: 'company',
        totals: { fetched: 0, created: 0, updated: 0, unchanged: 0, claimed: 0, archived: 0,
          skippedAmbiguous: 0, skippedManual: 0, skippedArchived: 0, stale: 0, restored: 0,
          blocked: 0, secretBlocked: 0, missingDependency: 0, errors: 0 },
        conflicts: [], error: null,
      };
    }) };
    const prisma = {
      integrationSyncRun: { findUnique: jest.fn().mockResolvedValue({ id: ids.run, triggeredBy: ids.actor, integrationId: 'integration' }) },
      integrationCompanyMapping: { findUnique: jest.fn().mockResolvedValue({ id: ids.mapping, companyId: 'company', integrationId: 'integration' }) },
      integrationResource: { findMany: jest.fn().mockResolvedValue(resources) },
    };
    const sync = {
      markMappingRunning: jest.fn(), mergeResourceResult: jest.fn(), closeRun: jest.fn(),
    };
    const worker = new IntegrationSyncMappingWorker(
      {} as never, {} as never, prisma as never, sync as never, runner as never,
      { persistGaps: jest.fn() } as never,
      { log: jest.fn() } as never,
    );
    const handle = (worker as unknown as { handle(job: {
      data: unknown;
      attemptsMade?: number;
      opts?: { attempts?: number };
    }): Promise<unknown> }).handle.bind(worker);
    await handle({ data: {
      syncRunId: ids.run, integrationCompanyMappingId: ids.mapping,
      resourceId: ids.device, resourceIds: resources.map((resource) => resource.id),
      auditActorId: ids.actor,
    } });
    expect(calls.indexOf(ids.reservation)).toBeGreaterThan(calls.indexOf(ids.device));
    expect(calls.indexOf(ids.reservation)).toBeGreaterThan(calls.indexOf(ids.subnet));
    expect(calls.at(-1)).toBe(ids.relation);
    expect(runner.runMapping).toHaveBeenCalledWith(expect.objectContaining({ mode: 'incremental' }));
    expect(sync.mergeResourceResult).toHaveBeenCalledTimes(resources.length);
    expect(sync.closeRun).toHaveBeenCalledTimes(1);
  });

  it('passes an explicit full run mode to every resource runner call', async () => {
    const runId = '00000000-0000-0000-0000-000000000021';
    const mappingId = '00000000-0000-0000-0000-000000000022';
    const resourceId = '00000000-0000-0000-0000-000000000023';
    const runner = { runMapping: jest.fn().mockResolvedValue({
      status: 'succeeded', resourceKey: 'devices', companyId: 'company',
      totals: { ...totalsForWorker(), errors: 0 }, conflicts: [], error: null,
    }) };
    const prisma = {
      integrationSyncRun: { findUnique: jest.fn().mockResolvedValue({
        id: runId, triggeredBy: null, integrationId: 'integration',
        integration: { createdBy: null },
      }) },
      integrationCompanyMapping: { findUnique: jest.fn().mockResolvedValue({
        id: mappingId, companyId: 'company', integrationId: 'integration',
      }) },
      integrationResource: { findMany: jest.fn().mockResolvedValue([
        { id: resourceId, resourceKey: 'devices', dependsOnResourceKeys: [] },
      ]) },
    };
    const sync = {
      markMappingRunning: jest.fn(), mergeResourceResult: jest.fn(), closeRun: jest.fn(),
    };
    const worker = new IntegrationSyncMappingWorker(
      {} as never, {} as never, prisma as never, sync as never, runner as never,
      { persistGaps: jest.fn() } as never,
      { log: jest.fn() } as never,
    );
    const handle = (worker as unknown as { handle(job: {
      data: unknown;
      attemptsMade?: number;
      opts?: { attempts?: number };
    }): Promise<unknown> }).handle.bind(worker);

    await handle({ data: {
      syncRunId: runId, integrationCompanyMappingId: mappingId, resourceId, mode: 'full',
    } });
    expect(runner.runMapping).toHaveBeenCalledWith(expect.objectContaining({ mode: 'full' }));
  });

  it.each([
    ['real', false],
    ['dry-run', true],
  ] as const)('%s dependency skip only persists an exact-scope gap for a real run', async (_label, dryRun) => {
    const runId = '00000000-0000-0000-0000-000000000031';
    const mappingId = '00000000-0000-0000-0000-000000000032';
    const deviceId = '00000000-0000-0000-0000-000000000033';
    const relationId = '00000000-0000-0000-0000-000000000034';
    const tx = {};
    const prisma = {
      integrationSyncRun: { findUnique: jest.fn().mockResolvedValue({
        id: runId, triggeredBy: null, integrationId: 'integration',
        integration: { createdBy: 'creator' },
      }) },
      integrationCompanyMapping: { findUnique: jest.fn().mockResolvedValue({
        id: mappingId, companyId: 'company', integrationId: 'integration',
      }) },
      integrationResource: { findMany: jest.fn().mockResolvedValue([
        { id: deviceId, resourceKey: 'devices', dependsOnResourceKeys: [] },
        { id: relationId, resourceKey: 'relations', dependsOnResourceKeys: ['devices'] },
      ]) },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    };
    const runner = { runMapping: jest.fn().mockResolvedValue({
      status: 'failed', resourceKey: 'devices', companyId: 'company',
      totals: totalsForWorker(), conflicts: [], error: 'validation failed',
    }) };
    const sync = {
      markMappingRunning: jest.fn(), mergeResourceResult: jest.fn(), closeRun: jest.fn(),
    };
    const provenance = {
      persistGaps: jest.fn(), resolveAbsentGaps: jest.fn(),
    };
    const worker = new IntegrationSyncMappingWorker(
      {} as never, {} as never, prisma as never, sync as never, runner as never,
      provenance as never, { log: jest.fn() } as never,
    );
    const handle = (worker as unknown as { handle(job: {
      data: unknown; attemptsMade?: number; opts?: { attempts?: number };
    }): Promise<unknown> }).handle.bind(worker);

    await handle({ data: {
      syncRunId: runId, integrationCompanyMappingId: mappingId,
      resourceId: deviceId, resourceIds: [deviceId, relationId],
      dryRun,
    } });
    if (dryRun) {
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(provenance.persistGaps).not.toHaveBeenCalled();
    } else {
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(provenance.persistGaps).toHaveBeenCalledWith(tx, expect.objectContaining({
        companyId: 'company', integrationCompanyMappingId: mappingId, resourceId: relationId,
      }), [expect.objectContaining({
        externalId: null, kind: 'missing_dependency',
        details: expect.objectContaining({
          reasonCode: 'dependency_unavailable', dependencyResourceKey: 'devices',
        }),
      })]);
    }
    expect(provenance.resolveAbsentGaps).not.toHaveBeenCalled();
  });

  it('rethrows a hard resource failure after persisting and closing the mapping', async () => {
    const runId = '00000000-0000-0000-0000-000000000011';
    const mappingId = '00000000-0000-0000-0000-000000000012';
    const resourceId = '00000000-0000-0000-0000-000000000013';
    const resource = { id: resourceId, resourceKey: 'devices', dependsOnResourceKeys: [] };
    const prisma = {
      integrationSyncRun: { findUnique: jest.fn().mockResolvedValue({
        id: runId, triggeredBy: null, integrationId: 'integration',
        integration: { createdBy: 'creator' },
      }) },
      integrationCompanyMapping: { findUnique: jest.fn().mockResolvedValue({
        id: mappingId, companyId: 'company', integrationId: 'integration',
      }) },
      integrationResource: { findMany: jest.fn().mockResolvedValue([resource]) },
    };
    const failure = {
      status: 'failed' as const, resourceKey: 'devices', companyId: 'company', totals: totalsForWorker(),
      conflicts: [{ kind: 'driver_error' as const, externalId: '', message: 'transport failed' }],
      error: 'transport failed',
    };
    const sync = {
      markMappingRunning: jest.fn(), mergeResourceResult: jest.fn(), closeRun: jest.fn(),
      failMappingJob: jest.fn(),
    };
    const runner = { runMapping: jest.fn().mockResolvedValue(failure) };
    const worker = new IntegrationSyncMappingWorker(
      {} as never, {} as never, prisma as never, sync as never, runner as never,
      { persistGaps: jest.fn() } as never,
      { log: jest.fn() } as never,
    );
    const handle = (worker as unknown as { handle(job: {
      data: unknown;
      attemptsMade?: number;
      opts?: { attempts?: number };
    }): Promise<unknown> }).handle.bind(worker);
    await expect(handle({ data: {
      syncRunId: runId, integrationCompanyMappingId: mappingId, resourceId,
    }, attemptsMade: 0, opts: { attempts: 3 } })).rejects.toThrow(/transport failed/);
    expect(sync.mergeResourceResult).not.toHaveBeenCalled();
    expect(sync.closeRun).not.toHaveBeenCalled();
    expect(sync.failMappingJob).not.toHaveBeenCalled();

    await expect(handle({ data: {
      syncRunId: runId, integrationCompanyMappingId: mappingId, resourceId,
    }, attemptsMade: 2, opts: { attempts: 3 } })).rejects.toThrow(/transport failed/);
    expect(runner.runMapping).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'creator' }));
    expect(sync.mergeResourceResult).toHaveBeenCalledTimes(1);
    expect(sync.closeRun).toHaveBeenCalledTimes(1);
    expect(sync.failMappingJob).not.toHaveBeenCalled();

    runner.runMapping.mockRejectedValueOnce(new Error('unexpected preflight failure'));
    await expect(handle({ data: {
      syncRunId: runId, integrationCompanyMappingId: mappingId, resourceId,
    }, attemptsMade: 2, opts: { attempts: 3 } })).rejects.toThrow(/unexpected preflight/);
    expect(sync.failMappingJob).toHaveBeenCalledWith(expect.objectContaining({
      runId,
      mappingId,
      error: 'unexpected preflight failure',
    }));
  });
});

function totalsForWorker() {
  return {
    fetched: 0, created: 0, updated: 0, unchanged: 0, claimed: 0, archived: 0,
    skippedAmbiguous: 0, skippedManual: 0, skippedArchived: 0, stale: 0, restored: 0,
    blocked: 0, secretBlocked: 0, missingDependency: 0, errors: 1,
  };
}
