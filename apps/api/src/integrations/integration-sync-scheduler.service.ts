import { Injectable, Logger } from '@nestjs/common';
import {
  CloudflareDriftSweepJobNames,
  IntegrationSyncOrchestratorJobNames,
  QueueNames,
} from '@weavestream/shared';
import type { Queue } from 'bullmq';
import { EnvService } from '../config/env.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QueuesService } from '../queues/queues.service.js';
import { IntegrationDriverRegistry } from './drivers/integration-driver.registry.js';

/**
 * Phase 11 — owns BullMQ repeatable registrations for Integration sync
 * schedules. Lives in `IntegrationsCoreModule` so `IntegrationsService`
 * (also in core) can call `refreshFor` from CRUD paths without crossing
 * the API/worker module boundary. The boot-time sweep is invoked by
 * `IntegrationSyncQueueRegistrar` (API only) so it never runs in the
 * worker process — see registrar for details.
 */
@Injectable()
export class IntegrationSyncSchedulerService {
  private readonly logger = new Logger(IntegrationSyncSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly env: EnvService,
    private readonly drivers: IntegrationDriverRegistry,
  ) {}

  /**
   * Reconcile the BullMQ repeatable for a single integration with the
   * current Postgres row. Idempotent and safe to call after CRUD,
   * including when the row was just deleted (the repeatable is then
   * just unregistered).
   *
   * Errors are logged and swallowed — Redis hiccups must not fail the
   * HTTP request that triggered the refresh.
   */
  async refreshFor(integrationId: string): Promise<void> {
    try {
      const orchQueue = this.queues.get(QueueNames.integrationSyncOrchestrator);
      const cfQueue = this.queues.get(QueueNames.cloudflareDriftSweep);

      const integration = await this.prisma.integration.findUnique({
        where: { id: integrationId },
        select: { id: true, status: true, syncCron: true, driver: true, name: true },
      });

      // Always purge any existing repeatable for this id from BOTH
      // queues first. Handles ACTIVE→PAUSED, deletion, and the unlikely
      // case where a driver kind change moves the schedule between
      // queues.
      await this.removeScheduledFor(orchQueue, integrationId);
      await this.removeScheduledFor(cfQueue, integrationId);

      if (!integration || integration.status !== 'ACTIVE') return;

      const pattern = integration.syncCron ?? this.resolveDefaultCron();
      if (!pattern) return;

      const kind = this.drivers.has(integration.driver)
        ? this.drivers.kindOf(integration.driver)
        : 'pull';

      if (kind === 'security') {
        await cfQueue.add(
          CloudflareDriftSweepJobNames.scheduled,
          { integrationId: integration.id },
          {
            jobId: `scheduled-${integration.id}`,
            repeat: { pattern },
          },
        );
      } else {
        await orchQueue.add(
          IntegrationSyncOrchestratorJobNames.scheduled,
          { kind: 'scheduled', integrationId: integration.id },
          {
            jobId: `scheduled-${integration.id}`,
            repeat: { pattern },
          },
        );
      }

      this.logger.log(
        `Refreshed scheduled ${kind} sync for "${integration.driver}/${integration.name}" with cron "${pattern}"${integration.syncCron ? '' : ' (default)'}`,
      );
    } catch (e) {
      this.logger.error(
        { err: (e as Error).message, integrationId },
        'failed to refresh scheduled sync',
      );
    }
  }

  /**
   * Boot-time sweep: clear every `scheduled-*` repeatable on both
   * queues, then re-register one for each ACTIVE integration. Stale
   * registrations (deleted, paused, or cron cleared since the last
   * boot) are dropped here.
   */
  async refreshAll(): Promise<void> {
    const orchQueue = this.queues.get(QueueNames.integrationSyncOrchestrator);
    const cfQueue = this.queues.get(QueueNames.cloudflareDriftSweep);

    for (const queue of [orchQueue, cfQueue]) {
      const repeatables = await queue.getRepeatableJobs();
      for (const r of repeatables) {
        if (
          r.id?.startsWith('scheduled-') ||
          r.id?.startsWith('scheduled:')
        ) {
          await queue.removeRepeatableByKey(r.key).catch(() => undefined);
        }
      }
    }

    const defaultCron = this.resolveDefaultCron();

    const integrations = await this.prisma.integration.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, syncCron: true, name: true, driver: true },
    });

    this.logger.log(
      `Sync scheduler boot: ${integrations.length} ACTIVE integration(s); ` +
        `default cron = ${defaultCron ?? '(disabled)'}`,
    );

    let registered = 0;
    for (const i of integrations) {
      const pattern = i.syncCron ?? defaultCron;
      if (!pattern) continue;
      const kind = this.drivers.has(i.driver)
        ? this.drivers.kindOf(i.driver)
        : 'pull';
      try {
        if (kind === 'security') {
          await cfQueue.add(
            CloudflareDriftSweepJobNames.scheduled,
            { integrationId: i.id },
            {
              jobId: `scheduled-${i.id}`,
              repeat: { pattern },
            },
          );
        } else {
          await orchQueue.add(
            IntegrationSyncOrchestratorJobNames.scheduled,
            { kind: 'scheduled', integrationId: i.id },
            {
              jobId: `scheduled-${i.id}`,
              repeat: { pattern },
            },
          );
        }
        registered += 1;
        this.logger.log(
          `Registered scheduled ${kind} sync for "${i.driver}/${i.name}" with cron "${pattern}"${i.syncCron ? '' : ' (default)'}`,
        );
      } catch (e) {
        this.logger.error(
          { err: (e as Error).message, integrationId: i.id },
          'failed to register scheduled sync',
        );
      }
    }

    if (registered === 0) {
      this.logger.log('No ACTIVE integrations with cron — sync scheduler idle.');
    }
  }

  // The literal "off" disables the global default — only integrations
  // with an explicit `syncCron` get scheduled. See env.ts.
  private resolveDefaultCron(): string | null {
    const raw = this.env.values.INTEGRATION_SYNC_DEFAULT_CRON;
    return raw.toLowerCase() === 'off' ? null : raw;
  }

  private async removeScheduledFor(queue: Queue, integrationId: string): Promise<void> {
    const expectedId = `scheduled-${integrationId}`;
    const legacyId = `scheduled:${integrationId}`;
    const repeatables = await queue.getRepeatableJobs();
    for (const r of repeatables) {
      if (r.id === expectedId || r.id === legacyId) {
        await queue.removeRepeatableByKey(r.key).catch(() => undefined);
      }
    }
  }
}
