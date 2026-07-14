import { integrationSyncMappingJobSchema } from '@weavestream/shared';
import { IntegrationSyncOrchestratorWorker } from './integration-sync-orchestrator.processor.js';

describe('integration sync orchestrator staged payload', () => {
  it('keeps legacy resourceId while carrying the whole mapping DAG and audit actor', () => {
    const job = integrationSyncMappingJobSchema.parse({
      syncRunId: '00000000-0000-0000-0000-000000000001',
      integrationCompanyMappingId: '00000000-0000-0000-0000-000000000002',
      resourceId: '00000000-0000-0000-0000-000000000003',
      resourceIds: [
        '00000000-0000-0000-0000-000000000003',
        '00000000-0000-0000-0000-000000000004',
      ],
      auditActorId: '00000000-0000-0000-0000-000000000005',
    });
    expect(job.resourceIds).toHaveLength(2);
    expect(job.auditActorId).toBe('00000000-0000-0000-0000-000000000005');
  });
});

describe('IntegrationSyncOrchestratorWorker persisted modes', () => {
  const integrationId = '00000000-0000-0000-0000-000000000011';
  const actorId = '00000000-0000-0000-0000-000000000012';

  function handleOf(worker: IntegrationSyncOrchestratorWorker) {
    return (worker as unknown as { handle(job: { data: unknown }): Promise<unknown> }).handle.bind(worker);
  }

  it('lets the service select and persist scheduled mode before fan-out', async () => {
    const prisma = {
      integration: { findUnique: jest.fn().mockResolvedValue({ id: integrationId, status: 'ACTIVE' }) },
      integrationCompanyMapping: { count: jest.fn().mockResolvedValue(1) },
      integrationSyncRun: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const sync = {
      createScheduledRun: jest.fn().mockResolvedValue({ id: 'scheduled-run', mode: 'full' }),
      beginRun: jest.fn().mockResolvedValue(undefined),
      failRun: jest.fn(),
    };
    const worker = new IntegrationSyncOrchestratorWorker(
      {} as never, {} as never, prisma as never, sync as never,
    );

    await expect(handleOf(worker)({ id: 'tick-1', data: { kind: 'scheduled', integrationId } } as never)).resolves.toEqual({
      runId: 'scheduled-run',
    });
    expect(sync.createScheduledRun).toHaveBeenCalledWith(
      integrationId, undefined, expect.any(Date), 'scheduled:tick-1',
    );
    expect(sync.beginRun).toHaveBeenCalledWith('scheduled-run');
  });

  it('binds a retry to its unique scheduled delivery instead of reusing another active run', async () => {
    const prisma = {
      integration: { findUnique: jest.fn().mockResolvedValue({ id: integrationId, status: 'ACTIVE' }) },
      integrationCompanyMapping: { count: jest.fn().mockResolvedValue(1) },
      integrationSyncRun: { findFirst: jest.fn().mockResolvedValue({ id: 'unrelated-full-run', mode: 'full' }) },
    };
    const sync = {
      createScheduledRun: jest.fn().mockResolvedValue({ id: 'delivery-run', mode: 'incremental' }),
      beginRun: jest.fn().mockRejectedValue(new Error('temporary queue failure')),
      failRun: jest.fn(),
    };
    const worker = new IntegrationSyncOrchestratorWorker(
      {} as never, {} as never, prisma as never, sync as never,
    );

    await expect(handleOf(worker)({
      id: 'tick-2', data: { kind: 'scheduled', integrationId }, attemptsMade: 0, opts: { attempts: 2 },
    } as never)).rejects.toThrow('temporary queue failure');
    expect(sync.createScheduledRun).toHaveBeenCalledWith(
      integrationId, undefined, expect.any(Date), 'scheduled:tick-2',
    );
    expect(sync.beginRun).toHaveBeenCalledWith('delivery-run');
    expect(sync.failRun).not.toHaveBeenCalled();
  });

  it('does not fan out a distinct occurrence that coalesced into an active scheduled run', async () => {
    const prisma = {
      integration: { findUnique: jest.fn().mockResolvedValue({ id: integrationId, status: 'ACTIVE' }) },
      integrationCompanyMapping: { count: jest.fn().mockResolvedValue(1) },
    };
    const sync = {
      createScheduledRun: jest.fn().mockResolvedValue({
        id: 'active-run',
        mode: 'incremental',
        deliveryKey: 'scheduled:tick-1',
        shouldBegin: false,
      }),
      beginRun: jest.fn(),
      failRun: jest.fn(),
    };
    const worker = new IntegrationSyncOrchestratorWorker(
      {} as never, {} as never, prisma as never, sync as never,
    );

    await expect(handleOf(worker)({
      id: 'tick-2', data: { kind: 'scheduled', integrationId },
    } as never)).resolves.toEqual({ runId: 'active-run', coalesced: true });
    expect(sync.beginRun).not.toHaveBeenCalled();
  });

  it('retries the same scheduled delivery and refills its queued fan-out', async () => {
    const prisma = {
      integration: { findUnique: jest.fn().mockResolvedValue({ id: integrationId, status: 'ACTIVE' }) },
      integrationCompanyMapping: { count: jest.fn().mockResolvedValue(1) },
    };
    const sync = {
      createScheduledRun: jest.fn().mockResolvedValue({
        id: 'delivery-run',
        mode: 'incremental',
        deliveryKey: 'scheduled:tick-retry',
        shouldBegin: true,
      }),
      beginRun: jest.fn().mockResolvedValue(undefined),
      failRun: jest.fn(),
    };
    const worker = new IntegrationSyncOrchestratorWorker(
      {} as never, {} as never, prisma as never, sync as never,
    );

    await expect(handleOf(worker)({
      id: 'tick-retry', data: { kind: 'scheduled', integrationId }, attemptsMade: 1,
    } as never)).resolves.toEqual({ runId: 'delivery-run' });
    expect(sync.beginRun).toHaveBeenCalledWith('delivery-run');
  });

  it('matches a manual job to a run with the same mode and begins that persisted run', async () => {
    const prisma = {
      integrationSyncRun: {
        findUnique: jest.fn().mockResolvedValue({
          id: integrationId, integrationId, kind: 'manual', triggeredBy: actorId,
          mode: 'full', dryRun: false, status: 'queued',
        }),
        findFirst: jest.fn(),
      },
    };
    const sync = { beginRun: jest.fn(), failRun: jest.fn() };
    const worker = new IntegrationSyncOrchestratorWorker(
      {} as never, {} as never, prisma as never, sync as never,
    );

    await handleOf(worker)({ data: {
      kind: 'manual', integrationId, triggeredBy: actorId, dryRun: false, mode: 'full',
      syncRunId: integrationId,
    } });
    expect(prisma.integrationSyncRun.findUnique).toHaveBeenCalledWith({
      where: { id: integrationId },
    });
    expect(prisma.integrationSyncRun.findFirst).not.toHaveBeenCalled();
    expect(sync.beginRun).toHaveBeenCalledWith(integrationId);
  });

  it('rejects an exact manual run id whose persisted authority does not match the payload', async () => {
    const prisma = {
      integrationSyncRun: { findUnique: jest.fn().mockResolvedValue({
        id: integrationId, integrationId, kind: 'manual', triggeredBy: actorId,
        mode: 'incremental', dryRun: false, status: 'queued',
      }) },
    };
    const sync = { beginRun: jest.fn(), failRun: jest.fn() };
    const worker = new IntegrationSyncOrchestratorWorker(
      {} as never, {} as never, prisma as never, sync as never,
    );

    await expect(handleOf(worker)({ data: {
      kind: 'manual', integrationId, syncRunId: integrationId,
      triggeredBy: actorId, dryRun: false, mode: 'full',
    } })).resolves.toBeNull();
    expect(sync.beginRun).not.toHaveBeenCalled();
  });
});
