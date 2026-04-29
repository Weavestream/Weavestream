import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Queue, QueueEvents, type JobsOptions } from 'bullmq';
import {
  CompanyExportJobNames,
  DomainCheckJobNames,
  PwnedCheckJobNames,
  QueueNames,
  type CompanyExportJob,
  type DomainCheckJob,
  type PwnedCheckJob,
  type QueueName,
} from '@weavestream/shared';
import { EnvService } from '../config/env.service.js';
import { RedisService } from '../redis/redis.service.js';

/**
 * Typed producer for every BullMQ queue the API writes to.
 *
 * One `Queue` instance per queue name is created eagerly on boot so
 * callers don't pay connection overhead on every `.add`. BullMQ
 * multiplexes commands onto a single Redis connection internally,
 * using the same ioredis client configuration the API's Redis module
 * already validated (url + password + tls handled by the URL).
 *
 * `QueueEvents` is what `waitForJob` blocks on — the controller's
 * "Check now" path needs to know when the consumer finished so it can
 * return the freshly written `DomainCheck` in the same HTTP response
 * (within `DOMAIN_CHECK_TIMEOUT_MS * DOMAIN_CHECK_ATTEMPTS` + 2s).
 */
@Injectable()
export class QueuesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueuesService.name);
  private readonly queues = new Map<QueueName, Queue>();
  private readonly queueEvents = new Map<QueueName, QueueEvents>();

  constructor(
    private readonly env: EnvService,
    private readonly redis: RedisService,
  ) {}

  async onModuleInit(): Promise<void> {
    for (const name of Object.values(QueueNames)) {
      const queue = new Queue(name, {
        connection: this.redis.bullmqConnection(),
        defaultJobOptions: {
          removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
          removeOnFail: { age: 7 * 24 * 60 * 60 },
        },
      });
      const events = new QueueEvents(name, {
        connection: this.redis.bullmqConnection(),
      });
      await events.waitUntilReady();
      this.queues.set(name, queue);
      this.queueEvents.set(name, events);
      this.logger.log(`Registered producer for queue ${name}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const q of this.queues.values()) await q.close().catch(() => undefined);
    for (const e of this.queueEvents.values()) await e.close().catch(() => undefined);
  }

  /**
   * Typed access to a queue. Throws if the queue was never registered
   * in `QueueNames` — a compile-time check catches most misuse; this
   * is a runtime fallback for dynamic callers (CLI, tests).
   */
  get(name: QueueName): Queue {
    const q = this.queues.get(name);
    if (!q) throw new Error(`Queue "${name}" is not registered`);
    return q;
  }

  getEvents(name: QueueName): QueueEvents {
    const e = this.queueEvents.get(name);
    if (!e) throw new Error(`QueueEvents for "${name}" is not registered`);
    return e;
  }

  /**
   * Enqueue a domain-check job. Centralised here so every producer
   * path (DomainsService.enqueueManualCheck, the CLI, the scheduled
   * fan-out inside the worker itself) uses the same retry/backoff
   * defaults driven by env configuration.
   */
  async enqueueDomainCheck(
    payload: DomainCheckJob,
    extraOptions: JobsOptions = {},
  ): Promise<string> {
    const jobName =
      payload.kind === 'scheduled'
        ? DomainCheckJobNames.scheduled
        : DomainCheckJobNames.single;

    const queue = this.get(QueueNames.domainChecks);
    const job = await queue.add(jobName, payload, {
      attempts: this.env.values.DOMAIN_CHECK_ATTEMPTS,
      backoff: {
        type: 'exponential',
        delay: this.env.values.DOMAIN_CHECK_BACKOFF_MS,
      },
      ...extraOptions,
    });
    return job.id ?? '';
  }

  /**
   * Blocks until a job finishes (completed or failed). Used by the
   * "Check now" endpoint so the HTTP caller gets the fresh
   * `DomainCheck` row in the response. Times out cleanly so a
   * pathologically slow worker never holds an HTTP connection open.
   */
  async waitForJob(
    queueName: QueueName,
    jobId: string,
    timeoutMs: number,
  ): Promise<'completed' | 'failed' | 'timeout'> {
    const events = this.getEvents(queueName);
    const completed = new Promise<'completed'>((resolve) => {
      const off = (args: { jobId: string }) => {
        if (args.jobId === jobId) {
          events.off('completed', off);
          resolve('completed');
        }
      };
      events.on('completed', off);
    });
    const failed = new Promise<'failed'>((resolve) => {
      const off = (args: { jobId: string }) => {
        if (args.jobId === jobId) {
          events.off('failed', off);
          resolve('failed');
        }
      };
      events.on('failed', off);
    });
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), timeoutMs),
    );
    return Promise.race([completed, failed, timeout]);
  }

  /**
   * Enqueue a HIBP k-anonymity check for a password. Called from the
   * API's PasswordsService after a successful create/update. The
   * payload carries the full SHA-1 hex of the plaintext so the worker
   * can split into prefix (sent to hibp) + suffix (local compare).
   *
   * Retention is intentionally minimal: completed jobs are removed
   * immediately so the SHA-1 hex never lingers in Redis snapshots /
   * AOF beyond the worker's consume window. Failed jobs are kept just
   * long enough to surface in dashboards (1h) — `attempts: 3` with
   * exponential backoff already replays transient HIBP outages.
   */
  async enqueuePwnedCheck(payload: PwnedCheckJob): Promise<string> {
    const queue = this.get(QueueNames.pwnedCheck);
    const job = await queue.add(PwnedCheckJobNames.password, payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: { age: 60 * 60, count: 50 },
    });
    return job.id ?? '';
  }

  /**
   * Enqueue a company PDF export job. The worker will gather all company
   * data, build a PDFKit document, upload to MinIO, and store the
   * storage key in the job return value for the API to presign on poll.
   */
  async enqueueCompanyExport(payload: CompanyExportJob): Promise<string> {
    const queue = this.get(QueueNames.companyExport);
    const jobName =
      payload.kind === 'export'
        ? CompanyExportJobNames.export
        : CompanyExportJobNames.cleanup;
    const job = await queue.add(jobName, payload, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 10_000 },
      // Keep completed jobs long enough for the 4-hour download window +
      // buffer, then let Redis clean up automatically.
      removeOnComplete: { age: 5 * 60 * 60 },
      removeOnFail: { age: 24 * 60 * 60 },
    });
    return job.id ?? '';
  }

  /** Counts per lane — used by the `/health/queues` probe. */
  async getCounts(name: QueueName): Promise<Record<string, number>> {
    const q = this.get(name);
    return q.getJobCounts('active', 'waiting', 'delayed', 'completed', 'failed');
  }
}
