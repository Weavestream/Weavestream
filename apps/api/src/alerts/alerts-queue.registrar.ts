import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { AlertsJobNames, QueueNames } from '@weavestream/shared';
import { EnvService } from '../config/env.service.js';
import { QueuesService } from '../queues/queues.service.js';

/**
 * Registers the repeatable `alerts:scan` BullMQ job on API boot.
 * Mirrors `DomainChecksQueueRegistrar` so flipping `ALERTS_SCAN_CRON`
 * in `.env` and redeploying the API is the only operator knob — no
 * "register schedule" endpoint to remember.
 *
 * Setting the env var to the literal string `off` skips registration
 * AND removes any prior repeatable entry, so a local-dev environment
 * isn't surprised by leftover work after toggling the feature off.
 *
 * The repeatable job is registered API-side (not on the worker) so
 * a single API restart re-asserts the cron idempotently. The worker
 * simply consumes whatever shows up on the queue.
 */
@Injectable()
export class AlertsQueueRegistrar implements OnApplicationBootstrap {
  private readonly logger = new Logger(AlertsQueueRegistrar.name);

  constructor(
    private readonly env: EnvService,
    private readonly queues: QueuesService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const queue = this.queues.get(QueueNames.alerts);
    const cron = this.env.values.ALERTS_SCAN_CRON;
    const jobId = 'alerts:scan';

    const repeatables = await queue.getRepeatableJobs();
    for (const r of repeatables) {
      if (r.id === jobId || r.name === AlertsJobNames.scan) {
        await queue.removeRepeatableByKey(r.key).catch(() => undefined);
      }
    }

    if (cron === 'off') {
      this.logger.warn(
        'ALERTS_SCAN_CRON=off — scheduled alert scans disabled. Real-time alerts still fire.',
      );
      return;
    }

    await queue.add(
      AlertsJobNames.scan,
      { kind: 'scan' },
      {
        repeat: { pattern: cron },
        jobId,
      },
    );
    this.logger.log(`Registered scheduled alerts:scan job with cron "${cron}"`);
  }
}
