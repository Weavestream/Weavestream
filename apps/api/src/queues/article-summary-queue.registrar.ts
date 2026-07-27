import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import {
  ARTICLE_SUMMARY_SWEEP_JOB_ID,
  ArticleSummaryJobNames,
  QueueNames,
} from '@weavestream/shared';
import { QueuesService } from './queues.service.js';

/**
 * Registers the repeatable article-summary `sweep` tick on API boot
 * (Mobile Phase 4). Mirrors `AlertsQueueRegistrar`'s converge-on-boot
 * idempotency: stale repeatable entries for this lane are removed and
 * the current one re-asserted, so a single API restart is the only
 * operator action that exists.
 *
 * Deliberately NO env knob: the sweep is a no-op unless the admin has
 * turned on both AI and the auto-summaries opt-in (the worker checks
 * the settings row every tick), so registration is unconditionally
 * safe — an idle tick costs one Redis poll and one settings read.
 * The batch cap (worker-side) × this interval is the feature's spend
 * governor: 25 articles / 15 min ≈ ≤100 summaries/hour during an
 * integration-import backlog drain. Tune them together or not at all;
 * a per-install env knob is a flagged follow-up for metered endpoints.
 */
const SWEEP_CRON = '*/15 * * * *';

@Injectable()
export class ArticleSummaryQueueRegistrar implements OnApplicationBootstrap {
  private readonly logger = new Logger(ArticleSummaryQueueRegistrar.name);

  constructor(private readonly queues: QueuesService) {}

  async onApplicationBootstrap(): Promise<void> {
    const queue = this.queues.get(QueueNames.articleSummary);

    const repeatables = await queue.getRepeatableJobs();
    for (const r of repeatables) {
      if (
        r.id === ARTICLE_SUMMARY_SWEEP_JOB_ID ||
        r.name === ArticleSummaryJobNames.sweep
      ) {
        await queue.removeRepeatableByKey(r.key).catch(() => undefined);
      }
    }

    await queue.add(
      ArticleSummaryJobNames.sweep,
      { kind: 'sweep' },
      {
        repeat: { pattern: SWEEP_CRON },
        jobId: ARTICLE_SUMMARY_SWEEP_JOB_ID,
      },
    );
    this.logger.log(
      `Registered article-summary sweep with cron "${SWEEP_CRON}"`,
    );
  }
}
