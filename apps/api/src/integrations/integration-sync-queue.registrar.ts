import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import {
  IntegrationSyncOrchestratorJobNames,
  QueueNames,
} from '@weavestream/shared';
import { EnvService } from '../config/env.service.js';
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
    private readonly env: EnvService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const queue = this.queues.get(QueueNames.integrationSyncOrchestrator);

    const repeatables = await queue.getRepeatableJobs();
    for (const r of repeatables) {
      if (r.id?.startsWith('scheduled:')) {
        await queue.removeRepeatableByKey(r.key).catch(() => undefined);
      }
    }

    // The literal "off" disables the global default — only integrations
    // with an explicit `syncCron` get scheduled. See env.ts.
    const rawDefault = this.env.values.INTEGRATION_SYNC_DEFAULT_CRON;
    const defaultCron = rawDefault.toLowerCase() === 'off' ? null : rawDefault;

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
      try {
        await queue.add(
          IntegrationSyncOrchestratorJobNames.scheduled,
          { kind: 'scheduled', integrationId: i.id },
          {
            jobId: `scheduled-${i.id}`,
            repeat: { pattern },
          },
        );
        registered += 1;
        this.logger.log(
          `Registered scheduled sync for "${i.driver}/${i.name}" with cron "${pattern}"${i.syncCron ? '' : ' (default)'}`,
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
}
