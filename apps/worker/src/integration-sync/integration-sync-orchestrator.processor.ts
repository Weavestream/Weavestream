import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import {
  QueueNames,
  integrationSyncOrchestratorJobSchema,
  type IntegrationSyncOrchestratorJob,
} from '@weavestream/shared';
import { EnvService } from '../../../api/src/config/env.service.js';
import { RedisService } from '../../../api/src/redis/redis.service.js';
import { PrismaService } from '../../../api/src/prisma/prisma.service.js';
import { IntegrationSyncService } from '../../../api/src/integrations/integration-sync.service.js';

/**
 * Phase 11 — orchestrator processor.
 *
 * For a `manual` job: reuses the queued `IntegrationSyncRun` already
 * created by the API (`triggerManual`) and fans out per-mapping jobs
 * via `IntegrationSyncService.beginRun`.
 *
 * For a `scheduled` job: creates the run row itself before fanning
 * out — there is no API request to seed it.
 *
 * The orchestrator's BullMQ retries are deliberately small (2) — a
 * persistent failure means the per-mapping fan-out couldn't even start,
 * which is almost always a config / Redis problem rather than something
 * the next attempt will resolve.
 */
@Injectable()
export class IntegrationSyncOrchestratorWorker implements OnModuleDestroy {
  private readonly logger = new Logger(IntegrationSyncOrchestratorWorker.name);
  private worker: Worker | null = null;

  constructor(
    private readonly env: EnvService,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly sync: IntegrationSyncService,
  ) {}

  async start(): Promise<void> {
    if (this.worker) return;
    this.worker = new Worker(
      QueueNames.integrationSyncOrchestrator,
      async (job) => this.handle(job),
      {
        connection: this.redis.bullmqConnection(),
        concurrency:
          this.env.values.INTEGRATION_SYNC_ORCHESTRATOR_CONCURRENCY,
      },
    );
    this.worker.on('ready', () => {
      this.logger.log(
        `Orchestrator ready — concurrency=${this.env.values.INTEGRATION_SYNC_ORCHESTRATOR_CONCURRENCY}`,
      );
    });
    this.worker.on('failed', (job, err) => {
      this.logger.error(
        `Orchestrator job ${job?.id ?? '<unknown>'} failed: ${err?.message ?? err}`,
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
    const parsed = integrationSyncOrchestratorJobSchema.safeParse(job.data);
    if (!parsed.success) {
      throw new Error(
        `invalid integration-sync-orchestrator payload: ${parsed.error.message}`,
      );
    }
    const payload: IntegrationSyncOrchestratorJob = parsed.data;

    if (payload.kind === 'manual') {
      return this.handleManual(payload, job);
    }
    return this.handleScheduled(payload, job);
  }

  private async handleManual(
    payload: Extract<IntegrationSyncOrchestratorJob, { kind: 'manual' }>,
    job: Job<unknown, unknown, string>,
  ): Promise<unknown> {
    // The API already created an `IntegrationSyncRun` keyed by
    // `manual:<runId>`. Pull the most recent queued/running run for
    // this integration that has the same triggeredBy + dryRun flags.
    const run = await this.resolveManualRun(payload);
    if (!run) {
      this.logger.warn(
        `No queued manual run found for integration ${payload.integrationId} — skipping orchestrator`,
      );
      return null;
    }
    try {
      await this.sync.beginRun(run.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (isFinalAttempt(job)) await this.sync.failRun(run.id, message);
      throw e;
    }
    return { runId: run.id };
  }

  /**
   * Two payload generations coexist while queues drain across an
   * upgrade (jobs persist in Redis):
   *   - current jobs pin their run with `syncRunId`; every claimed
   *     attribute must match the row or the job is dropped.
   *   - legacy jobs (pre-DAG API) carry no `syncRunId`; recover the
   *     row the way that generation's worker did — the most recent
   *     queued/running manual run for the same integration,
   *     triggeredBy, and dryRun. No `mode` comparison: the field
   *     didn't exist, so the row's own (defaulted) mode is
   *     authoritative and `beginRun` reads it from the row anyway.
   */
  private async resolveManualRun(
    payload: Extract<IntegrationSyncOrchestratorJob, { kind: 'manual' }>,
  ) {
    if (payload.syncRunId) {
      const run = await this.prisma.integrationSyncRun.findUnique({
        where: { id: payload.syncRunId },
      });
      const matches =
        run && run.integrationId === payload.integrationId && run.kind === 'manual' &&
        run.triggeredBy === payload.triggeredBy && run.mode === payload.mode &&
        run.dryRun === payload.dryRun && ['queued', 'running'].includes(run.status);
      return matches ? run : null;
    }
    return this.prisma.integrationSyncRun.findFirst({
      where: {
        integrationId: payload.integrationId,
        kind: 'manual',
        triggeredBy: payload.triggeredBy,
        dryRun: payload.dryRun,
        status: { in: ['queued', 'running'] },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async handleScheduled(
    payload: Extract<IntegrationSyncOrchestratorJob, { kind: 'scheduled' }>,
    job: Job<unknown, unknown, string>,
  ): Promise<unknown> {
    const integration = await this.prisma.integration.findUnique({
      where: { id: payload.integrationId },
    });
    if (!integration || integration.status !== 'ACTIVE') {
      this.logger.debug(
        `Skipping scheduled run — integration ${payload.integrationId} is not ACTIVE`,
      );
      return null;
    }
    const enabled = await this.prisma.integrationCompanyMapping.count({
      where: { integrationId: payload.integrationId, enabled: true },
    });
    if (enabled === 0) {
      this.logger.debug(
        `Skipping scheduled run — no enabled mappings for ${payload.integrationId}`,
      );
      return null;
    }
    const run = await this.sync.createScheduledRun(
      payload.integrationId,
      payload.mode,
      new Date(),
      scheduledDeliveryKey(job),
    );
    if (run.shouldBegin === false) {
      this.logger.debug(
        `Coalescing scheduled occurrence into run ${run.id} (status ${run.status}) for ${payload.integrationId}`,
      );
      return { runId: run.id, coalesced: true };
    }
    try {
      await this.sync.beginRun(run.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (isFinalAttempt(job)) await this.sync.failRun(run.id, message);
      throw e;
    }
    return { runId: run.id };
  }
}

function isFinalAttempt(job: Job<unknown, unknown, string>): boolean {
  const attempts = Math.max(1, Number(job.opts?.attempts ?? 1));
  return Number(job.attemptsMade ?? 0) + 1 >= attempts;
}

function scheduledDeliveryKey(job: Job<unknown, unknown, string>): string {
  if (!job.id) throw new Error('Scheduled integration sync job is missing its delivery id.');
  return `scheduled:${job.id}`.slice(0, 512);
}
