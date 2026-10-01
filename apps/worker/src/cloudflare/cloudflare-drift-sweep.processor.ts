import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  CloudflareDriftSweepJobNames,
  cloudflareDriftSweepJobSchema,
  QueueNames,
} from '@weavestream/shared';
import { EnvService, RedisService } from '@weavestream/api/runtime';
import {
  CloudflareListsService,
  CloudflareRegistrarSyncService,
} from '@weavestream/api/integrations';
import {
  createManagedWorker,
  type ManagedWorker,
} from '../common/managed-worker.js';

/**
 * Cloudflare drift-sweep worker.
 *
 * Cron-driven (one repeatable job per ACTIVE Cloudflare integration with
 * a non-null `syncCron`). Each job enumerates every CloudflareIpList row
 * for the integration and runs a drift check against Cloudflare's view.
 * Errors per-list are captured into that list's `driftDetails.lastError`
 * so a single bad list doesn't poison the whole sweep.
 */
@Injectable()
export class CloudflareDriftSweepWorker implements OnModuleDestroy {
  private readonly logger = new Logger(CloudflareDriftSweepWorker.name);
  // Assigned in `start()`, never in a field initializer: class fields run
  // before the constructor body assigns `this.redis`.
  private managed: ManagedWorker | null = null;

  constructor(
    private readonly env: EnvService,
    private readonly redis: RedisService,
    private readonly lists: CloudflareListsService,
    private readonly registrar: CloudflareRegistrarSyncService,
  ) {}

  async start(): Promise<void> {
    if (this.managed) return;
    this.managed = createManagedWorker({
      queue: QueueNames.cloudflareDriftSweep,
      logger: this.logger,
      handler: async (job) => this.handle(job),
      options: {
        connection: this.redis.bullmqConnection(),
        concurrency: 2,
      },
    });
    await this.managed.ready();
  }

  async onModuleDestroy(): Promise<void> {
    await this.managed?.close();
    this.managed = null;
  }

  private async handle(job: Job<unknown, unknown, string>): Promise<unknown> {
    const parsed = cloudflareDriftSweepJobSchema.safeParse(job.data);
    if (!parsed.success) {
      throw new Error(
        `invalid cloudflare-drift-sweep payload: ${parsed.error.message}`,
      );
    }
    const { integrationId, triggeredBy } = parsed.data;

    // "Sync domains now" only wants the registrar sync; let its failure fail
    // the job so it shows up as failed rather than as a quiet no-op.
    if (job.name === CloudflareDriftSweepJobNames.manual) {
      const registrar = await this.registrar.sync(integrationId, triggeredBy ?? null);
      this.logger.log(`Manual registrar sync done (integration=${integrationId})`);
      return { integrationId, registrar };
    }

    const startedAt = Date.now();
    const result = await this.lists.runDriftSweep(integrationId);
    this.logger.log(
      `Drift sweep job ${job.id ?? '<no-id>'} done in ${Date.now() - startedAt}ms ` +
        `(integration=${integrationId} checked=${result.checked} ` +
        `healed=${result.healed} errors=${result.errors})`,
    );

    // Registrar sync rides the same schedule. Its failure is logged and
    // reported in the job result, but must not fail the drift sweep that
    // already succeeded (BullMQ would retry both).
    let registrar: unknown;
    try {
      registrar = await this.registrar.sync(integrationId, null);
    } catch (err) {
      this.logger.error(
        `Registrar sync failed (integration=${integrationId}): ${err instanceof Error ? err.message : String(err)}`,
      );
      registrar = { error: err instanceof Error ? err.message : String(err) };
    }
    return { integrationId, ...result, registrar };
  }
}
