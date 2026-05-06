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
 *
 * Uses BullMQ v5 Job Schedulers (`upsertJobScheduler` / `removeJobScheduler`)
 * because the legacy `add(... { repeat, jobId })` path stores entries
 * under a hashed key rather than the `jobId` we pass, which makes them
 * impossible to remove deterministically afterwards. Job Schedulers key
 * the entry by `jobSchedulerId` directly, so removal-by-id Just Works.
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
   * Reconcile the BullMQ scheduler for a single integration with the
   * current Postgres row. Idempotent and safe to call after CRUD,
   * including when the row was just deleted (the scheduler is then just
   * unregistered).
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

      // Always purge any existing scheduler for this id from BOTH queues
      // first. Handles ACTIVE→PAUSED, deletion, and the unlikely case
      // where a driver kind change moves the schedule between queues.
      const schedulerId = this.schedulerIdFor(integrationId);
      await orchQueue.removeJobScheduler(schedulerId).catch(() => undefined);
      await cfQueue.removeJobScheduler(schedulerId).catch(() => undefined);

      if (!integration || integration.status !== 'ACTIVE') return;

      const pattern = integration.syncCron ?? this.resolveDefaultCron();
      if (!pattern) return;

      const kind = this.drivers.has(integration.driver)
        ? this.drivers.kindOf(integration.driver)
        : 'pull';

      await this.upsertScheduler(kind === 'security' ? cfQueue : orchQueue, kind, integration.id, pattern);

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
   * Boot-time sweep: clear every `scheduled-*` registration on both
   * queues — including legacy `add({ repeat })` entries left over from
   * before we migrated to Job Schedulers — then re-register one per
   * ACTIVE integration. Stale registrations (deleted, paused, or cron
   * cleared since the last boot) are dropped here.
   */
  async refreshAll(): Promise<void> {
    const orchQueue = this.queues.get(QueueNames.integrationSyncOrchestrator);
    const cfQueue = this.queues.get(QueueNames.cloudflareDriftSweep);

    for (const queue of [orchQueue, cfQueue]) {
      // 1. Remove every Job Scheduler whose id matches our prefix.
      const schedulers = await queue.getJobSchedulers();
      for (const s of schedulers) {
        const id = (s as { id?: string; key?: string }).id ?? (s as { key?: string }).key;
        if (typeof id === 'string' && (id.startsWith('scheduled-') || id.startsWith('scheduled:'))) {
          await queue.removeJobScheduler(id).catch(() => undefined);
        }
      }
      // 2. Sweep up legacy `add({ repeat })` entries, which are stored
      //    under hashed keys and not visible as Job Schedulers. The id
      //    field on these is reliably undefined in BullMQ 5.76 (a known
      //    quirk in `getRepeatableData`), so we can't filter — but these
      //    integration queues only ever held our `scheduled-*` entries,
      //    so removing every legacy entry is safe.
      const repeatables = await queue.getRepeatableJobs();
      for (const r of repeatables) {
        await queue.removeRepeatableByKey(r.key).catch(() => undefined);
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
        await this.upsertScheduler(kind === 'security' ? cfQueue : orchQueue, kind, i.id, pattern);
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

  private async upsertScheduler(
    queue: Queue,
    kind: 'pull' | 'security',
    integrationId: string,
    pattern: string,
  ): Promise<void> {
    const schedulerId = this.schedulerIdFor(integrationId);
    if (kind === 'security') {
      await queue.upsertJobScheduler(
        schedulerId,
        { pattern },
        {
          name: CloudflareDriftSweepJobNames.scheduled,
          data: { integrationId },
        },
      );
    } else {
      await queue.upsertJobScheduler(
        schedulerId,
        { pattern },
        {
          name: IntegrationSyncOrchestratorJobNames.scheduled,
          data: { kind: 'scheduled', integrationId },
        },
      );
    }
  }

  private schedulerIdFor(integrationId: string): string {
    return `scheduled-${integrationId}`;
  }

  // The literal "off" disables the global default — only integrations
  // with an explicit `syncCron` get scheduled. See env.ts.
  private resolveDefaultCron(): string | null {
    const raw = this.env.values.INTEGRATION_SYNC_DEFAULT_CRON;
    return raw.toLowerCase() === 'off' ? null : raw;
  }
}
