import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { DomainCheckJobNames, QueueNames } from '@weavestream/shared';
import { EnvService } from '../config/env.service.js';
import { QueuesService } from './queues.service.js';

/**
 * Registers the repeatable `domain-checks:scheduled` job on API boot.
 *
 * Uses `OnApplicationBootstrap` (not `OnModuleInit`) so this hook is
 * guaranteed to run AFTER `QueuesService.onModuleInit` has populated
 * the queue map — otherwise `queues.get(...)` would race with the
 * lazy producer registration in the same module.
 *
 * Runs on the API side rather than the worker so:
 *   - Repeatable registrations are idempotent by `jobId`. Every API
 *     restart re-asserts the cron, which means flipping
 *     `DOMAIN_CHECK_CRON` in `.env` and redeploying the API is the
 *     sole knob an operator needs. The worker never has to know about
 *     the schedule.
 *   - `DOMAIN_CHECK_CRON=off` short-circuits registration and
 *     simultaneously removes any prior repeatable entry so a local
 *     dev environment isn't surprised by leftover work.
 */
@Injectable()
export class DomainChecksQueueRegistrar implements OnApplicationBootstrap {
  private readonly logger = new Logger(DomainChecksQueueRegistrar.name);

  constructor(
    private readonly env: EnvService,
    private readonly queues: QueuesService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const queue = this.queues.get(QueueNames.domainChecks);
    const cron = this.env.values.DOMAIN_CHECK_CRON;
    const jobId = 'domain-checks:scheduled';

    // Always clear stale repeatable registrations for this jobId — we
    // treat the API's boot as the authoritative configuration moment.
    const repeatables = await queue.getRepeatableJobs();
    for (const r of repeatables) {
      if (r.id === jobId || r.name === DomainCheckJobNames.scheduled) {
        await queue.removeRepeatableByKey(r.key).catch(() => undefined);
      }
    }

    if (cron === 'off') {
      this.logger.warn(
        'DOMAIN_CHECK_CRON=off — scheduled domain checks disabled. Manual enqueue still works.',
      );
      return;
    }

    await queue.add(
      DomainCheckJobNames.scheduled,
      { kind: 'scheduled' },
      {
        repeat: { pattern: cron },
        jobId,
      },
    );
    this.logger.log(`Registered scheduled domain-checks job with cron "${cron}"`);
  }
}
