import type { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';

/**
 * Structural rather than the Nest `Logger` class, so a spec can pass a plain
 * object of `jest.fn()`s.
 */
type RegistrarLogger = Pick<Logger, 'log' | 'warn'>;

/**
 * What a single failed removal does. REQUIRED, and deliberately not a
 * defaulted boolean. The 2 policies are load-bearing and differ per call site:
 *
 *   'skip'  — best-effort. 1 stuck key must not block the rest.
 *   'throw' — the caller aborts registration rather than let a surviving
 *             legacy entry double-fire beside a freshly registered
 *             scheduler. `BackupQueueRegistrar` depends on this.
 *
 * 'skip' carries a mandatory `onSkipped`. Best-effort must not mean silent:
 * a discarded failure leaves a deleted schedule still firing, or a legacy
 * entry double-firing beside a fresh scheduler, and nobody learns of it until
 * the next restart. An optional callback would be swallowed by omission, which
 * is the behaviour this replaces.
 */
export type RemoveErrorPolicy =
  | { readonly onError: 'throw' }
  | {
      readonly onError: 'skip';
      /** Called once per discarded failure, with the key or id that stuck. */
      readonly onSkipped: (id: string, err: unknown) => void;
    };

export type RemoveJobSchedulersOptions = RemoveErrorPolicy & {
  /**
   * REQUIRED, unlike `removeRepeatables`, which takes no filter. "Remove every
   * legacy repeatable" is safe because nothing creates them any more, so every
   * one left is stale; "remove every Job Scheduler" has no such guarantee, so
   * there is no defensible default.
   *
   * Receives the RESOLVED id — see `resolveSchedulerId`.
   */
  readonly match: (id: string) => boolean;
};

/** Applies the policy to 1 removal. The only place either policy is spelt out. */
async function removeOne(
  policy: RemoveErrorPolicy,
  id: string,
  remove: () => Promise<unknown>,
): Promise<void> {
  if (policy.onError === 'throw') {
    await remove();
    return;
  }
  try {
    await remove();
  } catch (err) {
    policy.onSkipped(id, err);
  }
}

/**
 * BullMQ 5.76 lists Job Schedulers under `key`, not `id` — but sets `id` on
 * some entries. Both call sites had this `??` written out by hand; it lives
 * here now so a BullMQ upgrade revisits 1 line rather than 2.
 */
function resolveSchedulerId(entry: unknown): string | null {
  // `getJobSchedulers()` lists the zset, then reads each `repeat:<id>` hash
  // separately. When another API replica removes an entry in between, BullMQ
  // returns `undefined` for it. It is gone already, so it is skipped.
  if (entry === null || typeof entry !== 'object') return null;
  const { id, key } = entry as { id?: string; key?: string };
  const resolved = id ?? key;
  return typeof resolved === 'string' ? resolved : null;
}

/**
 * Removes every legacy `add({ repeat })` registration from a queue, and
 * leaves its Job Schedulers alone.
 *
 * BullMQ v6 removes the legacy repeatable API, and raises an error when it
 * finds legacy entries in Redis. Weavestream no longer creates them, so this
 * boot sweep clears what older releases left behind while the install still
 * runs v5. It is the only caller of `getRepeatableJobs` and
 * `removeRepeatableByKey`; the BullMQ v6 upgrade deletes it.
 *
 * Legacy entries and Job Schedulers share 1 Redis zset, so
 * `getRepeatableJobs()` lists both. A Job Scheduler is the entry with an
 * `iterationCount`: only `storeJobScheduler` writes that `ic` hash field, and
 * BullMQ v6 tells the 2 apart by the same field.
 *
 * Both listings always throw on failure, under both policies. Only the
 * per-key removals honour `onError`.
 */
export async function removeRepeatables(
  queue: Queue,
  policy: RemoveErrorPolicy,
): Promise<void> {
  const schedulerIds = new Set<string>();
  for (const s of await queue.getJobSchedulers()) {
    const id = resolveSchedulerId(s);
    if (id !== null && s.iterationCount !== undefined) schedulerIds.add(id);
  }
  const repeatables = await queue.getRepeatableJobs();
  for (const r of repeatables) {
    if (schedulerIds.has(r.key)) continue;
    await removeOne(policy, r.key, () => queue.removeRepeatableByKey(r.key));
  }
}

/**
 * Removes BullMQ v5 Job Scheduler registrations from a queue.
 *
 * The scheduler-side counterpart to `removeRepeatables`, and the same
 * doctrine: the version quirk that makes this awkward (`id` vs `key`, above)
 * is stated once here instead of in every registrar.
 *
 * Removals run in listing order and sequentially. `BackupQueueRegistrar`'s
 * spec pins that order, and pins that every scheduler removal completes
 * before any legacy `removeRepeatables` sweep begins — schedulers and legacy
 * repeatables share one Redis zset, so an interleaved pass can remove an
 * entry the other half just wrote.
 *
 * As with `removeRepeatables`, the `getJobSchedulers()` read always throws on
 * failure under both policies. Only the per-id removals honour `onError`.
 */
export async function removeJobSchedulers(
  queue: Queue,
  opts: RemoveJobSchedulersOptions,
): Promise<void> {
  const schedulers = await queue.getJobSchedulers();
  for (const s of schedulers) {
    const id = resolveSchedulerId(s);
    if (id === null || !opts.match(id)) continue;
    await removeOne(opts, id, () => queue.removeJobScheduler(id));
  }
}

export interface CronSchedulerRegistration {
  readonly queue: Queue;
  readonly logger: RegistrarLogger;
  /** Stable Job Scheduler id for this lane, e.g. `domain-checks:scheduled`. */
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
 * Converges 1 cron Job Scheduler on API boot.
 *
 * Boot is treated as the authoritative configuration moment: legacy
 * repeatable entries on the queue are cleared first, then the current
 * schedule is upserted under `jobId` (or removed when `off`). A single API
 * restart is therefore the only operator action that exists for changing a
 * schedule.
 */
export async function registerCronScheduler(
  reg: CronSchedulerRegistration,
): Promise<void> {
  const { queue, logger, jobId, jobName, cron, data, label } = reg;

  await removeRepeatables(queue, {
    onError: 'skip',
    // A legacy entry we could not remove keeps firing beside the scheduler we
    // are about to register. That is worth a look, so it is not discarded.
    onSkipped: (key, err) =>
      logger.warn(
        `Could not remove a legacy ${label} repeatable (key ${key}); it may double-fire until the next API restart: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
  });

  if (cron === 'off') {
    await queue.removeJobScheduler(jobId);
    logger.warn(reg.disabledMessage);
    return;
  }

  await queue.upsertJobScheduler(jobId, { pattern: cron }, { name: jobName, data });
  logger.log(`Registered scheduled ${label} job with cron "${cron}"`);
}
