import type { Logger } from '@nestjs/common';
import type { Queue, RepeatableJob } from 'bullmq';

/**
 * Structural rather than the Nest `Logger` class, so a spec can pass a plain
 * object of `jest.fn()`s.
 */
type RegistrarLogger = Pick<Logger, 'log' | 'warn'>;

export interface RemoveRepeatablesOptions {
  /**
   * REQUIRED, and deliberately not a defaulted boolean. The 2 policies are
   * load-bearing and differ per call site:
   *
   *   'skip'  — best-effort. 1 stuck key must not block the rest.
   *   'throw' — the caller aborts registration rather than let a surviving
   *             legacy entry double-fire beside a freshly registered
   *             scheduler. `BackupQueueRegistrar` depends on this.
   */
  readonly onError: 'throw' | 'skip';
  /** Omit to remove every legacy entry on the queue. */
  readonly match?: (r: RepeatableJob) => boolean;
}

/**
 * Removes legacy `add({ repeat })` registrations from a queue.
 *
 * `getRepeatableJobs` and `removeRepeatableByKey` are BullMQ v5's LEGACY
 * repeatable API, superseded by Job Schedulers. Both remaining users of the
 * old API — this file's `registerRepeatableCron`, and the 2 scheduler-based
 * registrars that sweep it — route through here, so retiring it is 1 change
 * rather than 6.
 *
 * The `getRepeatableJobs()` read itself always throws on failure, under both
 * policies. Only the per-key removals honour `onError`. That matches what
 * every call site did before this helper existed.
 */
export async function removeRepeatables(
  queue: Queue,
  opts: RemoveRepeatablesOptions,
): Promise<void> {
  const repeatables = await queue.getRepeatableJobs();
  for (const r of repeatables) {
    if (opts.match && !opts.match(r)) continue;
    if (opts.onError === 'skip') {
      await queue.removeRepeatableByKey(r.key).catch(() => undefined);
    } else {
      await queue.removeRepeatableByKey(r.key);
    }
  }
}

export interface RepeatableCronRegistration {
  readonly queue: Queue;
  readonly logger: RegistrarLogger;
  /** Stable BullMQ job id for this lane, e.g. `domain-checks:scheduled`. */
  readonly jobId: string;
  /** BullMQ job name, e.g. `AlertsJobNames.scan`. */
  readonly jobName: string;
  /** A cron pattern, or the literal `off`. */
  readonly cron: string;
  readonly data: unknown;
  /** Names the lane in the success log, e.g. `domain-checks`, `alerts:scan`. */
  readonly label: string;
  /**
   * Warn text used when `cron === 'off'`. Required on purpose: an optional
   * message whose absence silently skipped the guard would be a landmine, and
   * each lane's text carries real operator guidance about what still works
   * once the schedule is off.
   */
  readonly disabledMessage: string;
}

/**
 * Converges 1 repeatable cron job on API boot.
 *
 * Boot is treated as the authoritative configuration moment: stale repeatable
 * entries for this lane are cleared first, then the current schedule is
 * re-asserted. A single API restart is therefore the only operator action
 * that exists for changing a schedule.
 */
export async function registerRepeatableCron(
  reg: RepeatableCronRegistration,
): Promise<void> {
  const { queue, logger, jobId, jobName, cron, data, label } = reg;

  await removeRepeatables(queue, {
    onError: 'skip',
    match: (r) => r.id === jobId || r.name === jobName,
  });

  if (cron === 'off') {
    logger.warn(reg.disabledMessage);
    return;
  }

  await queue.add(jobName, data, { repeat: { pattern: cron }, jobId });
  logger.log(`Registered scheduled ${label} job with cron "${cron}"`);
}
