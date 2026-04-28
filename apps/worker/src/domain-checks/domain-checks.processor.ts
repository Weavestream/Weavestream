import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import {
  DomainCheckJobNames,
  QueueNames,
  domainCheckJobSchema,
  type DomainCheckJob,
} from '@weavestream/shared';
import { EnvService } from '../../../api/src/config/env.service.js';
import { RedisService } from '../../../api/src/redis/redis.service.js';
import { PrismaService } from '../../../api/src/prisma/prisma.service.js';
import {
  DomainsService,
  type AuditMeta,
} from '../../../api/src/domains/domains.service.js';
import {
  createDefaultPorts,
  deriveDomainStatus,
  runDomainCheck,
} from '../../../api/src/domains/engine/index.js';
import { runHttpCheck } from '../../../api/src/domains/engine/http-check.js';

const SYSTEM_META: AuditMeta = {
  ip: '127.0.0.1',
  userAgent: 'weavestream-worker/domain-checks',
};

/**
 * Phase 8 — DomainChecksWorker.
 *
 * Consumes the `domain-checks` BullMQ queue. Two job shapes:
 *   - `scheduled` — the repeatable job registered on API boot. Fan-out
 *     the active domains into per-domain `single` jobs so retries,
 *     concurrency limits, and dead-lettering are all per-domain.
 *   - `single`    — actually runs the engine for one domain and writes
 *     the result via `DomainsService.persistCheckResult`.
 *
 * Why the fan-out lives in the worker rather than the registrar:
 *   - We need the live list of active domains each tick, not a list
 *     frozen at API boot time. Domains are created/archived all day.
 *   - Per-domain jobs inherit the queue's attempts/backoff config, so a
 *     single slow TLD can't take the whole sweep down with it.
 *
 * Started from `main.ts` via `.start()` so we control ordering (BullMQ
 * opens Redis connections eagerly).
 */
@Injectable()
export class DomainChecksWorker implements OnModuleDestroy {
  private readonly logger = new Logger(DomainChecksWorker.name);
  private worker: Worker | null = null;
  private readonly ports = createDefaultPorts();

  constructor(
    private readonly env: EnvService,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly domains: DomainsService,
  ) {}

  async start(): Promise<void> {
    if (this.worker) return;
    this.worker = new Worker(
      QueueNames.domainChecks,
      async (job) => this.handle(job),
      {
        connection: this.redis.bullmqConnection(),
        concurrency: this.env.values.DOMAIN_CHECK_CONCURRENCY,
      },
    );
    this.worker.on('ready', () => {
      this.logger.log(
        `Worker ready — concurrency=${this.env.values.DOMAIN_CHECK_CONCURRENCY}`,
      );
    });
    this.worker.on('failed', (job, err) => {
      this.logger.error(
        `Job ${job?.id ?? '<unknown>'} failed: ${err?.message ?? err}`,
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
    const parsed = domainCheckJobSchema.safeParse(job.data);
    if (!parsed.success) {
      throw new Error(`invalid job payload: ${parsed.error.message}`);
    }
    const payload: DomainCheckJob = parsed.data;

    if (job.name === DomainCheckJobNames.scheduled || payload.kind === 'scheduled') {
      return this.handleScheduled();
    }
    return this.handleSingle(payload);
  }

  /**
   * Fan-out: enqueue one `single` job per active domain. We read only
   * ids + companyId + flags — the engine re-reads the row right before
   * running so a human edit (e.g. disabling DNS) made during the fan-out
   * window still takes effect on the actual run.
   */
  private async handleScheduled(): Promise<{ enqueued: number }> {
    const active = await this.prisma.monitoredDomain.findMany({
      where: { archivedAt: null },
      select: { id: true },
    });
    if (active.length === 0) return { enqueued: 0 };

    // Queue access via the singleton `QueuesService` would force us to
    // inject another module; since we already own the Redis connection
    // we create a scoped Queue on the fly. Callers never observe this.
    const { Queue } = await import('bullmq');
    const queue = new Queue(QueueNames.domainChecks, {
      connection: this.redis.bullmqConnection(),
    });
    try {
      let enqueued = 0;
      for (const row of active) {
        const jobId = `single:${row.id}:${Date.now()}`;
        await queue.add(
          DomainCheckJobNames.single,
          {
            kind: 'single',
            domainId: row.id,
            actorId: null,
          },
          {
            jobId,
            attempts: this.env.values.DOMAIN_CHECK_ATTEMPTS,
            backoff: {
              type: 'exponential',
              delay: this.env.values.DOMAIN_CHECK_BACKOFF_MS,
            },
            removeOnComplete: { age: 24 * 60 * 60, count: 500 },
            removeOnFail: { age: 7 * 24 * 60 * 60 },
          },
        );
        enqueued += 1;
      }
      this.logger.log(`Scheduled sweep fanned out ${enqueued} domain(s)`);
      return { enqueued };
    } finally {
      await queue.close().catch(() => undefined);
    }
  }

  private async handleSingle(
    payload: Extract<DomainCheckJob, { kind: 'single' }>,
  ): Promise<{ status: string } | null> {
    const domain = await this.prisma.monitoredDomain.findFirst({
      where: { id: payload.domainId, archivedAt: null },
    });
    if (!domain) {
      this.logger.warn(
        `Skipping check for missing/archived domain ${payload.domainId}`,
      );
      return null;
    }

    const result = await runDomainCheck(this.ports, {
      hostname: domain.hostname,
      checkWhois: domain.checkWhois,
      checkDns: domain.checkDns,
      checkTls: domain.checkTls,
      timeoutMs: this.env.values.DOMAIN_CHECK_TIMEOUT_MS,
      rdapCacheHours: this.env.values.RDAP_BOOTSTRAP_CACHE_HOURS,
    });
    const status = deriveDomainStatus(result, domain.alertThresholdDays);

    await this.domains.persistCheckResult({
      domainId: domain.id,
      companyId: domain.companyId,
      result,
      status,
      actorId: payload.actorId,
      reason: payload.actorId ? 'manual' : 'scheduled',
      meta: SYSTEM_META,
    });

    // Alerts feature: lightweight HTTP availability probe. Drives the
    // `WEBSITE_DOWN` alert evaluator. We deliberately keep this OUT of
    // `runDomainCheck` so the registrar/whois/tls history stays
    // unchanged when the operator disables HTTP probing — and so an
    // origin that refuses HTTP doesn't taint the WHOIS/DNS/TLS verdict.
    if (domain.httpCheckEnabled) {
      try {
        const http = await runHttpCheck(domain.hostname, {
          timeoutMs: this.env.values.HTTP_CHECK_TIMEOUT_MS,
        });
        // Update only the http-related columns. `latestHttpStatus` is
        // null when we never received a response (DNS / TLS / timeout).
        // `httpDownSince` keeps its existing value when the host is
        // still down so the WEBSITE_DOWN evaluator can dedup off the
        // continuous-outage timestamp.
        await this.prisma.monitoredDomain.update({
          where: { id: domain.id },
          data: {
            latestHttpStatus: http.status,
            httpDownSince: http.ok
              ? null
              : (domain.httpDownSince ?? new Date()),
          },
        });
      } catch (err) {
        this.logger.warn(
          `http-check failed for ${domain.hostname}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return { status };
  }
}
