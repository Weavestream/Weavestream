import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { QueueNames, UploadReaperJobNames } from '@weavestream/shared';
import { EnvService } from '../config/env.service.js';
import { QueuesService } from './queues.service.js';

/**
 * Phase 7 — registers the repeatable `upload-reaper:scheduled` job on
 * API boot. Same idempotency model as `DomainChecksQueueRegistrar`:
 *
 *   - Always clears any prior repeatable for this jobId so changing
 *     `UPLOAD_REAPER_CRON` and redeploying the API is the only knob
 *     an operator needs.
 *   - `UPLOAD_REAPER_CRON=off` short-circuits registration and leaves
 *     the queue empty — useful for local dev, tests, and migrations
 *     where mass-undelete might still be desired.
 *
 * Lives on the API side (not the worker) so the registrar shares the
 * Redis connection lifecycle with the rest of `QueuesService` and so
 * a single API replica owns the schedule even when multiple workers
 * are running.
 */
@Injectable()
export class UploadReaperQueueRegistrar implements OnApplicationBootstrap {
  private readonly logger = new Logger(UploadReaperQueueRegistrar.name);

  constructor(
    private readonly env: EnvService,
    private readonly queues: QueuesService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const queue = this.queues.get(QueueNames.uploadReaper);
    const cron = this.env.values.UPLOAD_REAPER_CRON;
    const jobId = 'upload-reaper:scheduled';

    const repeatables = await queue.getRepeatableJobs();
    for (const r of repeatables) {
      if (r.id === jobId || r.name === UploadReaperJobNames.scheduled) {
        await queue.removeRepeatableByKey(r.key).catch(() => undefined);
      }
    }

    if (cron === 'off') {
      this.logger.warn(
        'UPLOAD_REAPER_CRON=off — scheduled upload reaper disabled. Soft-deleted bytes will accumulate on disk.',
      );
      return;
    }

    await queue.add(
      UploadReaperJobNames.scheduled,
      { kind: 'scheduled' },
      {
        repeat: { pattern: cron },
        jobId,
      },
    );
    this.logger.log(`Registered scheduled upload-reaper job with cron "${cron}"`);
  }
}
