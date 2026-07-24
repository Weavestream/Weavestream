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
import { buildResourceExecutionStages } from '../../../api/src/integrations/integration-sync.service.js';
import {
  IntegrationSyncRunnerService,
  type MappingRunOutcome,
} from '../../../api/src/integrations/integration-sync-runner.service.js';
import { AUDIT_ACTIONS } from '../../../api/src/audit/audit-actions.js';
import { AuditLogService } from '../../../api/src/audit/audit.service.js';
import { IntegrationProvenanceService } from '../../../api/src/integrations/reconstruction/integration-provenance.service.js';

const SYSTEM_AUDIT_USER_AGENT = 'weavestream-worker/integration-sync';

/**
 * Phase 11 — per-mapping processor.
 *
 * Consumes the `integration-sync-mapping` queue. Each job carries one
 * (run, mapping) pair. The processor:
 *   1. Marks the per-company result row as running.
 *   2. Hands off to `IntegrationSyncRunnerService.runMapping`.
 *   3. Executes resource stages sequentially for that mapping.
 *   4. Replaces per-resource totals and closes the mapping once.
 * Retryable driver/native failures are persisted for visibility and then
 * rethrown so BullMQ resumes the whole mapping from committed checkpoints.
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
    private readonly provenance: IntegrationProvenanceService,
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
    try {
      return await this.executeMappingDag(payload, job);
    } catch (error) {
      if (isFinalAttempt(job) && !(error instanceof FinalizedMappingError)) {
        const message = error instanceof Error ? error.message : String(error);
        if (payload.resourceIds) {
          await this.sync.failMappingJob({
            runId: payload.syncRunId,
            mappingId: payload.integrationCompanyMappingId,
            error: message,
            actorId: payload.auditActorId ?? null,
          });
        } else {
          // Legacy per-resource job: force-failing the mapping row would
          // desync it from the pending siblings' merge math — persist the
          // crash as this one resource's failed outcome instead, exactly
          // like the generation that enqueued it did.
          await this.failLegacyResourceJob(payload, message);
        }
      }
      throw error;
    }
  }

  private async failLegacyResourceJob(
    payload: IntegrationSyncMappingJob,
    message: string,
  ): Promise<void> {
    const run = await this.prisma.integrationSyncRun.findUnique({
      where: { id: payload.syncRunId },
      select: {
        id: true,
        triggeredBy: true,
        integration: { select: { createdBy: true } },
      },
    });
    const mapping = await this.prisma.integrationCompanyMapping.findUnique({
      where: { id: payload.integrationCompanyMappingId },
      select: { id: true, companyId: true, integrationId: true },
    });
    const resource = mapping && await this.prisma.integrationResource.findFirst({
      where: { id: payload.resourceId, integrationId: mapping.integrationId },
      select: { resourceKey: true },
    });
    // Without a resolvable (run, mapping, resource) there is no sibling
    // arithmetic to keep truthful — the merge path would have skipped the
    // job the same way.
    if (!run || !mapping || !resource) return;
    const expectedResources = await this.prisma.integrationResource.count({
      where: {
        integrationId: mapping.integrationId,
        enabled: true,
        assetLayoutId: { not: null },
        fieldMappings: { some: {} },
      },
    });
    await this.sync.mergeResourceResult({
      runId: run.id,
      mappingId: mapping.id,
      resourceKey: resource.resourceKey,
      companyId: mapping.companyId,
      expectedResources,
      status: 'failed',
      totals: zeroTotals(),
      conflicts: [
        { kind: 'driver_error', externalId: '', message: message.slice(0, 500) },
      ],
      error: message.slice(0, 4_000),
      actorId: run.triggeredBy ?? run.integration.createdBy ?? null,
      ip: '0.0.0.0',
      userAgent: SYSTEM_AUDIT_USER_AGENT,
    });
    await this.sync.closeRun(run.id, run.triggeredBy ?? null);
  }

  private async executeMappingDag(
    payload: IntegrationSyncMappingJob,
    job: Job<unknown, unknown, string>,
  ): Promise<unknown> {
    const run = await this.prisma.integrationSyncRun.findUnique({
      where: { id: payload.syncRunId },
      select: {
        id: true,
        triggeredBy: true,
        integrationId: true,
        integration: { select: { createdBy: true } },
      },
    });
    if (!run) return null;
    const mapping = await this.prisma.integrationCompanyMapping.findUnique({
      where: { id: payload.integrationCompanyMappingId },
      select: { id: true, companyId: true, integrationId: true },
    });
    if (!mapping || mapping.integrationId !== run.integrationId) return null;
    // Legacy generation: a pre-DAG orchestrator fanned out one job per
    // (mapping, resource) with no `resourceIds`, and those jobs survive an
    // upgrade in Redis. They must run under that generation's contract —
    // no dependency gating (siblings run independently in parallel) and a
    // fan-out-wide expected-resource count — or a drained queue marks
    // mappings terminal after 1/N resources and records false
    // `dependency_unavailable` gaps.
    const legacy = !payload.resourceIds;
    const requestedIds = payload.resourceIds ?? [payload.resourceId];
    const resources = await this.prisma.integrationResource.findMany({
      where: { id: { in: requestedIds }, integrationId: mapping.integrationId },
      select: { id: true, resourceKey: true, dependsOnResourceKeys: true },
    });
    if (resources.length !== requestedIds.length) {
      if (legacy) {
        this.logger.warn(
          `Resource ${payload.resourceId} not found for mapping ${payload.integrationCompanyMappingId} — skipping legacy job`,
        );
        return null;
      }
      throw new Error('One or more mapping DAG resources do not belong to the integration.');
    }
    const selectedKeys = new Set(resources.map((resource) => resource.resourceKey));
    // The topo copy omits unavailable nodes so valid resources can still be
    // ordered. Execution maps back to the original rows below, preserving
    // every declared dependency for the visible unavailable-dependency skip.
    const stages = buildResourceExecutionStages(resources.map((resource) => ({
      ...resource,
      dependsOnResourceKeys: resource.dependsOnResourceKeys.filter((key) => selectedKeys.has(key)),
    })));
    const resourceById = new Map(resources.map((resource) => [resource.id, resource]));
    const orderedStages = stages.map((stage) => stage.map((resource) => resourceById.get(resource.id)!));
    const auditActorId =
      payload.auditActorId ??
      run.triggeredBy ??
      run.integration.createdBy ??
      null;

    await this.sync.markMappingRunning(run.id, mapping.id);
    await this.audit.log({
      actorId: auditActorId,
      action: AUDIT_ACTIONS.integration.syncMappingStarted,
      entityType: 'IntegrationCompanyMapping',
      entityId: mapping.id,
      companyId: mapping.companyId,
      ip: '0.0.0.0',
      userAgent: SYSTEM_AUDIT_USER_AGENT,
      before: null,
      after: { runId: run.id, dryRun: payload.dryRun, resourceKeys: resources.map((r) => r.resourceKey) },
    });

    const failedKeys = new Set<string>();
    const outcomes: MappingRunOutcome[] = [];
    for (const stage of orderedStages) {
      for (const resource of stage) {
        // Legacy jobs predate dependency gating: their siblings run as
        // independent queue jobs, so deps declared on the row (possibly
        // backfilled by a post-upgrade driver-definition refresh) must
        // not skip the resource here.
        const unavailable = legacy ? [] : resource.dependsOnResourceKeys.filter(
          (dependency) => !selectedKeys.has(dependency) || failedKeys.has(dependency),
        );
        let outcome: MappingRunOutcome;
        if (unavailable.length > 0) {
          if (!payload.dryRun) {
            await this.persistDependencyGaps(
              mapping.companyId, mapping.id, resource.id, unavailable,
            );
          }
          outcome = dependencySkipOutcome(resource.resourceKey, unavailable, mapping.companyId);
        } else {
          outcome = await this.runner.runMapping({
              syncRunId: run.id,
              integrationCompanyMappingId: mapping.id,
              resourceId: resource.id,
              dryRun: payload.dryRun,
              actorId: auditActorId,
              mode: payload.mode,
            });
        }
        outcomes.push(outcome);
        if (outcome.status === 'failed') failedKeys.add(resource.resourceKey);
      }
    }
    const retryable = outcomes.find(
      (outcome) =>
        outcome.status === 'failed' &&
        outcome.conflicts.some((conflict) => conflict.kind === 'driver_error'),
    );
    if (retryable && !isFinalAttempt(job)) {
      throw new Error(retryable.error ?? `Resource ${retryable.resourceKey} failed.`);
    }
    // Legacy siblings each merge one resource into the shared mapping row;
    // the row may only reach a terminal state once every sibling reports.
    // The count must mirror the pre-DAG orchestrator's fan-out filter
    // exactly (its non-asset targets didn't exist yet), or drained queues
    // close mappings early / never.
    const expectedResources = legacy
      ? await this.prisma.integrationResource.count({
          where: {
            integrationId: mapping.integrationId,
            enabled: true,
            assetLayoutId: { not: null },
            fieldMappings: { some: {} },
          },
        })
      : resources.length;
    for (const outcome of outcomes) {
      await this.sync.mergeResourceResult({
        runId: run.id,
        mappingId: mapping.id,
        resourceKey: outcome.resourceKey,
        companyId: mapping.companyId,
        expectedResources,
        status: outcome.status,
        totals: outcome.totals,
        conflicts: outcome.conflicts,
        error: outcome.error,
        actorId: auditActorId,
        ip: '0.0.0.0',
        userAgent: SYSTEM_AUDIT_USER_AGENT,
      });
    }
    await this.sync.closeRun(run.id, auditActorId);
    if (retryable) {
      throw new FinalizedMappingError(
        retryable.error ?? `Resource ${retryable.resourceKey} failed.`,
      );
    }
    return outcomes;
  }

  private async persistDependencyGaps(
    companyId: string,
    integrationCompanyMappingId: string,
    resourceId: string,
    dependencies: string[],
  ): Promise<void> {
    const observedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await this.provenance.persistGaps(tx, {
        companyId,
        integrationCompanyMappingId,
        resourceId,
        observedAt,
      }, dependencies.slice(0, 16).map((dependencyResourceKey) => ({
        externalId: null,
        syncRecordId: null,
        kind: 'missing_dependency' as const,
        message: 'A required reconstruction dependency was unavailable.',
        details: {
          reasonCode: 'dependency_unavailable',
          dependencyResourceKey,
        },
      })));
    });
  }
}

class FinalizedMappingError extends Error {}

function isFinalAttempt(job: Job<unknown, unknown, string>): boolean {
  const attempts = Math.max(1, Number(job.opts?.attempts ?? 1));
  return Number(job.attemptsMade ?? 0) + 1 >= attempts;
}

export function dependencySkipOutcome(
  resourceKey: string,
  dependencies: string[],
  companyId = '',
): MappingRunOutcome {
  const totals = zeroTotals();
  totals.errors = 0;
  totals.blocked = 1;
  totals.missingDependency = 1;
  const message = `Skipped because dependencies failed or were unavailable: ${dependencies.slice(0, 16).join(', ')}`;
  return {
    status: 'failed',
    resourceKey,
    companyId,
    totals,
    conflicts: [{ kind: 'validation_error', externalId: '', message }],
    error: message,
  };
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
    skippedArchived: 0,
    stale: 0,
    restored: 0,
    blocked: 0,
    secretBlocked: 0,
    missingDependency: 0,
    errors: 1,
  };
}
