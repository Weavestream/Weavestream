import { ConflictException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
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
    const { integrationId, triggeredBy, runId } = parsed.data;

    // "Sync domains now" only wants the registrar sync. Its run row records
    // the outcome for the Domains tab; a failure also fails the job. A run
    // refused because another is in progress is not a result of its own,
    // so it leaves "Last run" alone.
    if (job.name === CloudflareDriftSweepJobNames.manual) {
      let registrar: unknown;
      try {
        registrar = await this.registrar.sync(integrationId, triggeredBy ?? null, { runId });
      } catch (err) {
        if (!(err instanceof ConflictException)) {
          await this.lists.stampLastRun(integrationId, false);
        }
        throw err;
      }
      await this.lists.stampLastRun(integrationId, true);
      this.logger.log(`Manual registrar sync done (integration=${integrationId})`);
      return { integrationId, registrar };
    }

    const startedAt = Date.now();
    const result = await this.lists.runDriftSweep(integrationId);
    if (result.skipped) return { integrationId, ...result };
    this.logger.log(
      `Drift sweep job ${job.id ?? '<no-id>'} done in ${Date.now() - startedAt}ms ` +
        `(integration=${integrationId} checked=${result.checked} ` +
        `healed=${result.healed} errors=${result.errors})`,
    );

    // Registrar sync rides the same schedule. Its failure is recorded on its
    // run row and audited by the sync itself, but must not fail the drift
    // sweep that already succeeded (BullMQ would retry both).
    let registrar: unknown;
    let registrarOk = true;
    try {
      registrar = await this.registrar.sync(integrationId, null);
    } catch (err) {
      // A manual sync holding the lock is not a failure of this tick.
      registrarOk = err instanceof ConflictException;
      this.logger.error(
        `Registrar sync failed (integration=${integrationId}): ${err instanceof Error ? err.message : String(err)}`,
      );
      registrar = { error: err instanceof Error ? err.message : String(err) };
    }
    // One stamp for the whole job: failed if either half failed.
    await this.lists.stampLastRun(integrationId, result.errors === 0 && registrarOk);
    return { integrationId, ...result, registrar };
  }
}
