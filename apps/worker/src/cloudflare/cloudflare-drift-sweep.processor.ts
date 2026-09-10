import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  cloudflareDriftSweepJobSchema,
  QueueNames,
} from '@weavestream/shared';
import { EnvService } from '../../../api/src/config/env.service.js';
import { RedisService } from '../../../api/src/redis/redis.service.js';
import { CloudflareListsService } from '../../../api/src/integrations/cloudflare/cloudflare-lists.service.js';
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
    const startedAt = Date.now();
    const result = await this.lists.runDriftSweep(parsed.data.integrationId);
    this.logger.log(
      `Drift sweep job ${job.id ?? '<no-id>'} done in ${Date.now() - startedAt}ms ` +
        `(integration=${parsed.data.integrationId} checked=${result.checked} ` +
        `healed=${result.healed} errors=${result.errors})`,
    );
    return { integrationId: parsed.data.integrationId, ...result };
  }
}
