import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import {
  QueueNames,
  integrationSyncMappingJobSchema,
  type IntegrationSyncMappingJob,
} from '@weavestream/shared';
import { EnvService } from '../../../api/src/config/env.service.js';
import { RedisService } from '../../../api/src/redis/redis.service.js';
import { PrismaService } from '../../../api/src/prisma/prisma.service.js';
import { IntegrationSyncService } from '../../../api/src/integrations/integration-sync.service.js';
import { IntegrationSyncRunnerService } from '../../../api/src/integrations/integration-sync-runner.service.js';
import { AUDIT_ACTIONS } from '../../../api/src/audit/audit-actions.js';
import { AuditLogService } from '../../../api/src/audit/audit.service.js';

const SYSTEM_AUDIT_USER_AGENT = 'weavestream-worker/integration-sync';

/**
 * Phase 11 — per-mapping processor.
 *
 * Consumes the `integration-sync-mapping` queue. Each job carries one
 * (run, mapping) pair. The processor:
 *   1. Marks the per-company result row as running.
 *   2. Hands off to `IntegrationSyncRunnerService.runMapping`.
 *   3. Writes totals + conflicts back via `finishMapping`.
 *   4. Calls `closeRun` so the parent run is finalised once every
 *      child terminal-states.
 *
 * The runner returns its own `status` so transient driver failures
 * (auth, rate limit) bubble as a failed mapping rather than an
 * uncaught throw — the BullMQ retry budget is reserved for actual
 * transport-level errors.
 */
@Injectable()
export class IntegrationSyncMappingWorker implements OnModuleDestroy {
  private readonly logger = new Logger(IntegrationSyncMappingWorker.name);
  private worker: Worker | null = null;

  constructor(
    private readonly env: EnvService,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly sync: IntegrationSyncService,
    private readonly runner: IntegrationSyncRunnerService,
    private readonly audit: AuditLogService,
  ) {}

  async start(): Promise<void> {
    if (this.worker) return;
    this.worker = new Worker(
      QueueNames.integrationSyncMapping,
      async (job) => this.handle(job),
      {
        connection: this.redis.bullmqConnection(),
        concurrency: this.env.values.INTEGRATION_SYNC_MAPPING_CONCURRENCY,
      },
    );
    this.worker.on('ready', () => {
      this.logger.log(
        `Mapping worker ready — concurrency=${this.env.values.INTEGRATION_SYNC_MAPPING_CONCURRENCY}`,
      );
    });
    this.worker.on('failed', (job, err) => {
      this.logger.error(
        `Mapping job ${job?.id ?? '<unknown>'} failed: ${err?.message ?? err}`,
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
    const parsed = integrationSyncMappingJobSchema.safeParse(job.data);
    if (!parsed.success) {
      throw new Error(
        `invalid integration-sync-mapping payload: ${parsed.error.message}`,
      );
    }
    const payload: IntegrationSyncMappingJob = parsed.data;

    const run = await this.prisma.integrationSyncRun.findUnique({
      where: { id: payload.syncRunId },
      select: { id: true, triggeredBy: true, integrationId: true },
    });
    if (!run) {
      this.logger.warn(
        `Sync run ${payload.syncRunId} not found — skipping mapping ${payload.integrationCompanyMappingId}`,
      );
      return null;
    }

    const mapping = await this.prisma.integrationCompanyMapping.findUnique({
      where: { id: payload.integrationCompanyMappingId },
      select: { id: true, companyId: true, integrationId: true },
    });
    if (!mapping) {
      this.logger.warn(
        `Mapping ${payload.integrationCompanyMappingId} not found — skipping`,
      );
      return null;
    }

    const resource = await this.prisma.integrationResource.findFirst({
      where: { id: payload.resourceId, integrationId: mapping.integrationId },
      select: { id: true, resourceKey: true },
    });
    if (!resource) {
      this.logger.warn(
        `Resource ${payload.resourceId} not found for mapping ${payload.integrationCompanyMappingId} — skipping`,
      );
      return null;
    }

    // How many enabled+configured resources we expect to see report
    // back for this mapping. Used by mergeResourceResult to decide
    // when the per-mapping row reaches a terminal state. Must match
    // the orchestrator's fan-out filter.
    const expectedResources = await this.prisma.integrationResource.count({
      where: {
        integrationId: mapping.integrationId,
        enabled: true,
        assetLayoutId: { not: null },
        fieldMappings: { some: {} },
      },
    });

    await this.sync.markMappingRunning(run.id, mapping.id);
    await this.audit.log({
      actorId: run.triggeredBy,
      action: AUDIT_ACTIONS.integration.syncMappingStarted,
      entityType: 'IntegrationCompanyMapping',
      entityId: mapping.id,
      companyId: mapping.companyId,
      ip: '0.0.0.0',
      userAgent: SYSTEM_AUDIT_USER_AGENT,
      before: null,
      after: {
        runId: run.id,
        dryRun: payload.dryRun,
        resourceKey: resource.resourceKey,
      },
    });

    try {
      const outcome = await this.runner.runMapping({
        syncRunId: run.id,
        integrationCompanyMappingId: mapping.id,
        resourceId: resource.id,
        dryRun: payload.dryRun,
        actorId: run.triggeredBy,
      });
      await this.sync.mergeResourceResult({
        runId: run.id,
        mappingId: mapping.id,
        resourceKey: outcome.resourceKey,
        companyId: outcome.companyId,
        expectedResources,
        status: outcome.status,
        totals: outcome.totals,
        conflicts: outcome.conflicts,
        error: outcome.error,
        actorId: run.triggeredBy,
        ip: '0.0.0.0',
        userAgent: SYSTEM_AUDIT_USER_AGENT,
      });
      await this.sync.closeRun(run.id, run.triggeredBy);
      return outcome;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.sync.mergeResourceResult({
        runId: run.id,
        mappingId: mapping.id,
        resourceKey: resource.resourceKey,
        companyId: mapping.companyId,
        expectedResources,
        status: 'failed',
        totals: zeroTotals(),
        conflicts: [
          {
            kind: 'driver_error',
            externalId: '',
            message: message.slice(0, 500),
          },
        ],
        error: message.slice(0, 4_000),
        actorId: run.triggeredBy,
        ip: '0.0.0.0',
        userAgent: SYSTEM_AUDIT_USER_AGENT,
      });
      await this.sync.closeRun(run.id, run.triggeredBy);
      throw e;
    }
  }
}

function zeroTotals() {
  return {
    fetched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    claimed: 0,
    archived: 0,
    skippedAmbiguous: 0,
    skippedManual: 0,
    errors: 1,
  };
}
