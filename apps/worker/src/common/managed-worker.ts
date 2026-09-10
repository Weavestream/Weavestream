import type { Logger } from '@nestjs/common';
import {
  Worker,
  type Job,
  type Processor,
  type Queue,
  type WorkerOptions,
} from 'bullmq';

/**
 * Structural rather than the Nest `Logger` class, so a spec can pass a plain
 * object of `jest.fn()`s without constructing Nest's logger.
 */
type WorkerLogger = Pick<Logger, 'log' | 'warn' | 'error'>;

export interface ManagedWorkerConfig<D = unknown, R = unknown> {
  /** BullMQ queue name. */
  readonly queue: string;
  /** Log prefix. Defaults to `queue`. */
  readonly label?: string;
  /** The owning processor's own Logger, so the Nest log context is unchanged. */
  readonly logger: WorkerLogger;
  readonly handler: Processor<D, R, string>;
  /**
   * Passed VERBATIM to `new Worker`. Must carry `connection`. Every other
   * BullMQ knob — concurrency, lockDuration, lockRenewTime, stalledInterval —
   * rides through untouched. This helper never reinterprets them.
   */
  readonly options: WorkerOptions;
  /** Appended to the ready line, e.g. `dir=/var/lib/…, lock=360min`. */
  readonly readyDetail?: string;
  /** Log every completion. Default false. */
  readonly logCompleted?: boolean;
  /** Warn on `stalled`. Default false. */
  readonly logStalled?: boolean;
  /** Suffix appended INSIDE the standard failure line. */
  readonly describeFailure?: (err: unknown) => string;
  /** Side effect run after the failure line. Exceptions are caught. */
  readonly onFailed?: (job: Job<D, R, string> | undefined, err: unknown) => void;
  /**
   * Long-lived producer Queues owned by this processor. Create them BEFORE
   * calling, so the construction order is unchanged; `close()` closes them
   * after the worker has finished draining.
   */
  readonly producers?: readonly Queue[];
}

export interface ManagedWorker {
  /** Escape hatch for anything this helper does not model. */
  readonly worker: Worker;
  /** Awaits BullMQ readiness, then logs the ready line. */
  ready(): Promise<void>;
  close(): Promise<void>;
}

/** Matches the existing idiom in `apps/api/src/backups/backup-queue.registrar.ts`. */
function formatError(err: unknown): string {
  return err instanceof Error ? err.message || err.name : String(err);
}

/**
 * Builds a BullMQ Worker with this repository's standard lifecycle: uniform
 * failure logging, opt-in completion and stall logging, a reconnect notice,
 * and a shutdown that drains the worker before closing the producers it feeds.
 *
 * SYNCHRONOUS ON PURPOSE. `apps/worker/src/main.ts` enables Nest's shutdown
 * hooks before it starts any consumer, so a processor must own its handle
 * before it awaits readiness. If this returned a promise, a SIGTERM arriving
 * during startup would find a null field, skip that worker, and go on closing
 * the Redis and Prisma services underneath it. Callers assign first, then
 * `await handle.ready()`.
 */
export function createManagedWorker<D = unknown, R = unknown>(
  config: ManagedWorkerConfig<D, R>,
): ManagedWorker {
  const {
    queue,
    logger,
    handler,
    options,
    readyDetail,
    logCompleted = false,
    logStalled = false,
    describeFailure,
    onFailed,
    producers = [],
  } = config;
  const label = config.label ?? queue;

  const worker = new Worker<D, R, string>(queue, handler, options);

  // The first `ready` is already covered by the line `ready()` logs after
  // `waitUntilReady()`. Later fires are Redis reconnects, which are the
  // operationally interesting ones and were invisible before.
  let readyFires = 0;
  worker.on('ready', () => {
    readyFires += 1;
    if (readyFires > 1) {
      logger.log(`[${label}] worker reconnected to Redis`);
    }
  });

  worker.on('failed', (job, err) => {
    let detail = '';
    try {
      detail = describeFailure?.(err) ?? '';
    } catch {
      // A broken description must never cost us the failure line itself.
      detail = '';
    }
    logger.error(
      `[${label}] job ${job?.id ?? '<unknown>'} failed: ${formatError(err)}${detail}`,
    );
    try {
      onFailed?.(job, err);
    } catch (hookErr) {
      // BullMQ's `QueueBase.emit` would catch this and fall back to a bare
      // `console.error`, which bypasses the Nest logger. Keep it structured.
      logger.error(`[${label}] failed-hook threw: ${formatError(hookErr)}`);
    }
  });

  if (logCompleted) {
    worker.on('completed', (job) => {
      logger.log(`[${label}] job ${job.id} completed`);
    });
  }

  if (logStalled) {
    worker.on('stalled', (jobId) => {
      logger.warn(`[${label}] job ${jobId} stalled; waiting for recovery`);
    });
  }

  let closing: Promise<void> | null = null;

  return {
    worker,

    async ready(): Promise<void> {
      await worker.waitUntilReady();
      const parts = [`concurrency=${options.concurrency ?? 1}`];
      if (readyDetail) parts.push(readyDetail);
      logger.log(`[${label}] worker ready (${parts.join(', ')})`);
    },

    close(): Promise<void> {
      closing ??= (async () => {
        // Serialized on purpose, and NOT Promise.all. The worker drains its
        // in-flight jobs inside `close()`, and a draining export or backup job
        // still enqueues its cleanup through a producer. Closing a producer
        // before the drain completes breaks that enqueue.
        await worker
          .close()
          .catch((err: unknown) =>
            logger.warn(`[${label}] worker close failed: ${formatError(err)}`),
          );
        for (const producer of producers) {
          await producer
            .close()
            .catch((err: unknown) =>
              logger.warn(
                `[${label}] producer close failed: ${formatError(err)}`,
              ),
            );
        }
      })();
      return closing;
    },
  };
}
