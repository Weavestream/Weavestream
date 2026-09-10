import { IntegrationSyncOrchestratorJobNames, QueueNames } from '@weavestream/shared';
import { envSchema } from '@weavestream/shared/server';
import { IntegrationSyncSchedulerService } from './integration-sync-scheduler.service.js';

describe('IntegrationSyncSchedulerService', () => {
  it('uses exactly a 15-minute global cron default', () => {
    expect(envSchema.shape.INTEGRATION_SYNC_DEFAULT_CRON.parse(undefined)).toBe('*/15 * * * *');
  });

  /** BullMQ 5.76 lists Job Schedulers under `key`; `id` is often absent. */
  type SchedulerEntry = { id?: string; key?: string };
  type ActiveRow = { id: string; syncCron: string | null; name: string; driver: string };

  /**
   * `sweep` is only read by `refreshAll`. The `refreshFor` tests below leave it
   * empty, which is why the queue mocks carry the listing methods either way —
   * without them `refreshAll` throws `TypeError` rather than failing an
   * assertion, and that is how this path went uncovered for so long.
   */
  function setup(
    row: null | { status: string; syncCron: string | null } = { status: 'ACTIVE', syncCron: null },
    sweep: { schedulers?: SchedulerEntry[]; repeatables?: Array<{ key: string }>; active?: ActiveRow[] } = {},
  ) {
    const makeQueue = () => ({
      removeJobScheduler: jest.fn().mockResolvedValue(undefined),
      upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
      getJobSchedulers: jest.fn().mockResolvedValue(sweep.schedulers ?? []),
      getRepeatableJobs: jest.fn().mockResolvedValue(sweep.repeatables ?? []),
      removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
    });
    const orchestrator = makeQueue();
    const cloudflare = makeQueue();
    const integration = row && {
      id: 'integration-1', name: 'Breeze', driver: 'breeze', ...row,
    };
    const prisma = {
      integration: {
        findUnique: jest.fn().mockResolvedValue(integration),
        findMany: jest.fn().mockResolvedValue(sweep.active ?? []),
      },
    };
    const queues = {
      get: jest.fn((name: string) =>
        name === QueueNames.integrationSyncOrchestrator ? orchestrator : cloudflare),
    };
    const service = new IntegrationSyncSchedulerService(
      prisma as never,
      queues as never,
      { values: { INTEGRATION_SYNC_DEFAULT_CRON: '*/15 * * * *' } } as never,
      { has: jest.fn().mockReturnValue(true), kindOf: jest.fn().mockReturnValue('pull') } as never,
    );
    const logger = (service as unknown as { logger: { warn: (...a: unknown[]) => void } }).logger;
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    return { service, orchestrator, cloudflare, prisma, warnSpy };
  }

  it('registers an ACTIVE pull integration with the 15-minute default and existing payload', async () => {
    const { service, orchestrator } = setup();

    await service.refreshFor('integration-1');

    expect(orchestrator.upsertJobScheduler).toHaveBeenCalledWith(
      'scheduled-integration-1',
      { pattern: '*/15 * * * *' },
      {
        name: IntegrationSyncOrchestratorJobNames.scheduled,
        data: { kind: 'scheduled', integrationId: 'integration-1' },
      },
    );
  });

  it('preserves an explicit per-integration cron override', async () => {
    const { service, orchestrator } = setup({ status: 'ACTIVE', syncCron: '0 2 * * *' });
    await service.refreshFor('integration-1');
    expect(orchestrator.upsertJobScheduler).toHaveBeenCalledWith(
      expect.any(String), { pattern: '0 2 * * *' }, expect.any(Object),
    );
  });

  it.each(['PAUSED', 'DISABLED'])('removes and does not register a %s integration', async (status) => {
    const { service, orchestrator, cloudflare } = setup({ status, syncCron: null });
    await service.refreshFor('integration-1');
    expect(orchestrator.removeJobScheduler).toHaveBeenCalledWith('scheduled-integration-1');
    expect(cloudflare.removeJobScheduler).toHaveBeenCalledWith('scheduled-integration-1');
    expect(orchestrator.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it('removes a deleted integration registration', async () => {
    const { service, orchestrator } = setup(null);
    await service.refreshFor('integration-1');
    expect(orchestrator.removeJobScheduler).toHaveBeenCalledWith('scheduled-integration-1');
    expect(orchestrator.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it('preserves the documented off behavior', async () => {
    const { service, orchestrator } = setup();
    (service as unknown as { env: { values: { INTEGRATION_SYNC_DEFAULT_CRON: string } } }).env.values.INTEGRATION_SYNC_DEFAULT_CRON = 'off';
    await service.refreshFor('integration-1');
    expect(orchestrator.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it('still registers an explicit integration schedule when the global default is off', async () => {
    const { service, orchestrator } = setup({
      status: 'ACTIVE',
      syncCron: '30 4 * * *',
    });
    (service as unknown as { env: { values: { INTEGRATION_SYNC_DEFAULT_CRON: string } } }).env.values.INTEGRATION_SYNC_DEFAULT_CRON = 'off';

    await service.refreshFor('integration-1');

    expect(orchestrator.upsertJobScheduler).toHaveBeenCalledWith(
      'scheduled-integration-1',
      { pattern: '30 4 * * *' },
      {
        name: IntegrationSyncOrchestratorJobNames.scheduled,
        data: { kind: 'scheduled', integrationId: 'integration-1' },
      },
    );
  });

  describe('refreshAll', () => {
    const oneActive: ActiveRow[] = [
      { id: 'integration-1', syncCron: null, name: 'Breeze', driver: 'breeze' },
    ];

    it('sweeps both scheduled- and scheduled: registrations off both queues', async () => {
      const { service, orchestrator, cloudflare } = setup(null, {
        schedulers: [
          { key: 'scheduled-a' },
          { key: 'scheduled:legacy-colon' },
          // BullMQ 5.76 sets `id` on some entries; it wins over `key`.
          { id: 'scheduled-b', key: 'ignored-when-id-present' },
          // A legacy-shaped zset member and an unidentifiable one — not ours.
          { key: '3f2a9c81d4be5f6a7c8d9e0f3f2a9c81' },
          {},
        ],
      });

      await service.refreshAll();

      for (const queue of [orchestrator, cloudflare]) {
        expect(queue.removeJobScheduler.mock.calls.map((c) => c[0])).toEqual([
          'scheduled-a', 'scheduled:legacy-colon', 'scheduled-b',
        ]);
      }
    });

    it('sweeps legacy repeatables only after every scheduler is gone', async () => {
      const { service, orchestrator } = setup(null, {
        schedulers: [{ key: 'scheduled-a' }],
        repeatables: [{ key: 'legacy-md5-one' }, { key: 'legacy-md5-two' }],
      });

      await service.refreshAll();

      expect(orchestrator.removeRepeatableByKey.mock.calls.map((c) => c[0]))
        .toEqual(['legacy-md5-one', 'legacy-md5-two']);
      // Both live in one Redis zset, so an interleaved pass could remove an
      // entry the other half just wrote.
      expect(Math.max(...orchestrator.removeJobScheduler.mock.invocationCallOrder))
        .toBeLessThan(Math.min(...orchestrator.removeRepeatableByKey.mock.invocationCallOrder));
    });

    it('warns about a stuck removal and still registers every ACTIVE integration', async () => {
      const { service, orchestrator, warnSpy } = setup(null, {
        schedulers: [{ key: 'scheduled-a' }, { key: 'scheduled-b' }],
        active: oneActive,
      });
      orchestrator.removeJobScheduler.mockRejectedValueOnce(new Error('redis gone'));

      await service.refreshAll();

      // Best-effort, but never silent — and never at the cost of the rest.
      expect(orchestrator.removeJobScheduler).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'redis gone', key: 'scheduled-a' }),
        expect.stringContaining('failed to remove a stale scheduler'),
      );
      expect(orchestrator.upsertJobScheduler).toHaveBeenCalledWith(
        'scheduled-integration-1', { pattern: '*/15 * * * *' }, expect.any(Object),
      );
    });
  });
});
