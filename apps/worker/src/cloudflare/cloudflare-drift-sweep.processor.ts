import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import {
  cloudflareDriftSweepJobSchema,
  QueueNames,
} from '@weavestream/shared';
import { EnvService } from '../../../api/src/config/env.service.js';
import { RedisService } from '../../../api/src/redis/redis.service.js';
import { CloudflareListsService } from '../../../api/src/integrations/cloudflare/cloudflare-lists.service.js';

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
  private worker: Worker | null = null;

  constructor(
    private readonly env: EnvService,
    private readonly redis: RedisService,
    private readonly lists: CloudflareListsService,
  ) {}

  async start(): Promise<void> {
    if (this.worker) return;
    this.worker = new Worker(
      QueueNames.cloudflareDriftSweep,
      async (job) => this.handle(job),
      {
        connection: this.redis.bullmqConnection(),
        concurrency: 2,
      },
    );
    this.worker.on('ready', () => {
      this.logger.log('Cloudflare drift-sweep worker ready');
    });
    this.worker.on('failed', (job, err) => {
      this.logger.error(
        `Drift-sweep job ${job?.id ?? '<unknown>'} failed: ${err?.message ?? err}`,
      );
    });
    await this.worker.waitUntilReady();
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.worker) return;
    await this.worker.close();
    this.worker = null;
  }

  private async handle(job: Job<unknown, unknown, string>): Promise<unknown> {
    const parsed = cloudflareDriftSweepJobSchema.safeParse(job.data);
    if (!parsed.success) {
      throw new Error(
        `invalid cloudflare-drift-sweep payload: ${parsed.error.message}`,
      );
    }
    await this.lists.runDriftSweep(parsed.data.integrationId);
    return { integrationId: parsed.data.integrationId };
  }
}
