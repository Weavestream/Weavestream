import { IntegrationSyncOrchestratorJobNames, QueueNames } from '@weavestream/shared';
import { envSchema } from '@weavestream/shared/server';
import { IntegrationSyncSchedulerService } from './integration-sync-scheduler.service.js';

describe('IntegrationSyncSchedulerService', () => {
  it('uses exactly a 15-minute global cron default', () => {
    expect(envSchema.shape.INTEGRATION_SYNC_DEFAULT_CRON.parse(undefined)).toBe('*/15 * * * *');
  });

  function setup(row: null | { status: string; syncCron: string | null } = { status: 'ACTIVE', syncCron: null }) {
    const orchestrator = {
      removeJobScheduler: jest.fn().mockResolvedValue(undefined),
      upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    };
    const cloudflare = {
      removeJobScheduler: jest.fn().mockResolvedValue(undefined),
      upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    };
    const integration = row && {
      id: 'integration-1', name: 'Breeze', driver: 'breeze', ...row,
    };
    const prisma = { integration: { findUnique: jest.fn().mockResolvedValue(integration) } };
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
    return { service, orchestrator, cloudflare };
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
});
