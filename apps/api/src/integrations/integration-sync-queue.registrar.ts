import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import {
  IntegrationSyncOrchestratorJobNames,
  QueueNames,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { QueuesService } from '../queues/queues.service.js';

/**
 * Phase 11 — registers / refreshes the per-integration scheduled cron
 * registrations for the orchestrator queue on API boot.
 *
 * For every Integration with `status = ACTIVE` AND a non-null
 * `syncCron`, this registrar adds a BullMQ repeatable job keyed on
 * `scheduled:<integrationId>` so the schedule is idempotent across
 * restarts. Stale registrations (Integration deleted, paused, or its
 * cron cleared) are removed in the same sweep.
 *
 * Why on API boot rather than the worker:
 *   - Repeatable registrations are managed via `add(... { repeat: …,
 *     jobId })`, which is idempotent only when the same `jobId` is
 *     reused. Concentrating that ownership on the API side gives the
 *     operator a single deploy target to flip the schedule.
 *   - The worker doesn't watch Postgres for new Integrations — the
 *     API is the only place creates/updates flow through.
 *
 * Mid-cycle CRUD also calls `refreshFor(integrationId)` so an operator
 * doesn't have to wait for the next API restart to see their schedule
 * pick up. (Hooked from `IntegrationsService.update` whenever
 * `syncCron` or `status` changes — TODO once the wiring matures.)
 */
@Injectable()
export class IntegrationSyncQueueRegistrar implements OnApplicationBootstrap {
  private readonly logger = new Logger(IntegrationSyncQueueRegistrar.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const queue = this.queues.get(QueueNames.integrationSyncOrchestrator);

    const repeatables = await queue.getRepeatableJobs();
    for (const r of repeatables) {
      if (r.id?.startsWith('scheduled:')) {
        await queue.removeRepeatableByKey(r.key).catch(() => undefined);
      }
    }

    const integrations = await this.prisma.integration.findMany({
      where: { status: 'ACTIVE', syncCron: { not: null } },
      select: { id: true, syncCron: true, name: true, driver: true },
    });

    for (const i of integrations) {
      if (!i.syncCron) continue;
      try {
        await queue.add(
          IntegrationSyncOrchestratorJobNames.scheduled,
          { kind: 'scheduled', integrationId: i.id },
          {
            jobId: `scheduled-${i.id}`,
            repeat: { pattern: i.syncCron },
          },
        );
        this.logger.log(
          `Registered scheduled sync for "${i.driver}/${i.name}" with cron "${i.syncCron}"`,
        );
      } catch (e) {
        this.logger.error(
          { err: (e as Error).message, integrationId: i.id },
          'failed to register scheduled sync',
        );
      }
    }

    if (integrations.length === 0) {
      this.logger.log('No ACTIVE integrations with cron — sync scheduler idle.');
    }
  }
}
