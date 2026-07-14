import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  IntegrationSyncMappingJobNames,
  IntegrationSyncOrchestratorJobNames,
  QueueNames,
  stripNul,
  syncRunTotalsSchema,
  type IntegrationSyncMode,
  type IntegrationSyncRunCompanyResultDto,
  type IntegrationSyncRunDto,
  type SyncRunConflict,
  type SyncRunResourceTotals,
  type SyncRunTotals,
} from '@weavestream/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import { QueuesService } from '../queues/queues.service.js';
import { IntegrationDriverRegistry } from './drivers/integration-driver.registry.js';
import type { AuditMeta } from './integrations.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * Phase 11 — sync run orchestration + history.
 *
 * Two paths into this service:
 *   1. `triggerManual()` — operator pressed "Run sync". Creates a
 *      queued `IntegrationSyncRun` and enqueues the orchestrator job.
 *   2. `triggerScheduled()` — cron registrar fires for an integration
 *      with a non-null `syncCron`. Identical bookkeeping but kind=scheduled.
 *
 * The worker reads + writes via lower-level helpers exposed below
 * (`createMappingResults`, `markRunRunning`, `finishRun`, etc.) — the
 * orchestrator job in the worker doesn't reach into Prisma for sync-run
 * bookkeeping; it goes through this service so audit + status
 * transitions stay consistent.
 */
@Injectable()
export class IntegrationSyncService {
  private readonly logger = new Logger(IntegrationSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly queues: QueuesService,
    private readonly drivers: IntegrationDriverRegistry,
  ) {}

  // -------------------------------------------------------------------
  // Run history (admin UI consumes this)
  // -------------------------------------------------------------------

  async listRuns(
    integrationId: string,
    limit = 50,
  ): Promise<IntegrationSyncRunDto[]> {
    const rows = await this.prisma.integrationSyncRun.findMany({
      where: { integrationId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    const userIndex = await this.resolveTriggeredByUsers(rows);
    return rows.map((r) => toRunDto(r, userIndex));
  }

  async getRun(
    integrationId: string,
    runId: string,
  ): Promise<{
    run: IntegrationSyncRunDto;
    companyResults: IntegrationSyncRunCompanyResultDto[];
  }> {
    const row = await this.prisma.integrationSyncRun.findFirst({
      where: { id: runId, integrationId },
    });
    if (!row) throw new NotFoundException(`Sync run ${runId} not found`);

    const results = await this.prisma.integrationSyncRunCompanyResult.findMany({
      where: { syncRunId: runId },
      orderBy: { createdAt: 'asc' },
      include: {
        companyMapping: {
          include: { company: { select: { name: true } } },
        },
      },
    });

    const userIndex = await this.resolveTriggeredByUsers([row]);

    return {
      run: toRunDto(row, userIndex),
      companyResults: results.map((r) => ({
        id: r.id,
        syncRunId: r.syncRunId,
        integrationCompanyMappingId: r.integrationCompanyMappingId,
        companyId: r.companyId,
        companyName: r.companyMapping.company?.name ?? null,
        status: r.status,
        startedAt: r.startedAt ? r.startedAt.toISOString() : null,
        finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
        totals: r.totals as Record<string, unknown> | null,
        conflicts: (r.conflicts ?? null) as unknown[] | null,
        error: r.error,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  // -------------------------------------------------------------------
  // Trigger paths
  // -------------------------------------------------------------------

  async triggerManual(
    actor: AuthedUser,
    integrationId: string,
    dryRun: boolean,
    meta: AuditMeta,
    mode: IntegrationSyncMode = 'incremental',
  ): Promise<IntegrationSyncRunDto> {
    const integration = await this.prisma.integration.findUnique({
      where: { id: integrationId },
    });
    if (!integration) throw new NotFoundException(`Integration ${integrationId} not found`);
    if (this.drivers.has(integration.driver) && this.drivers.kindOf(integration.driver) === 'security') {
      throw new BadRequestException(
        'This driver does not support manual sync — security drivers manage their target system directly.',
      );
    }
    if (integration.status === 'DISABLED') {
      throw new BadRequestException(
        'Integration is DISABLED — re-enable it before running a sync.',
      );
    }

    const enabledMappingCount = await this.prisma.integrationCompanyMapping.count({
      where: { integrationId, enabled: true },
    });
    if (enabledMappingCount === 0) {
      throw new BadRequestException(
        'No enabled company mappings — configure at least one before triggering a sync.',
      );
    }
    const enabledResourceCount = await this.prisma.integrationResource.count({
      where: {
        integrationId,
        enabled: true,
        OR: [
          { targetKind: { not: 'asset' } },
          { targetKind: 'asset', assetLayoutId: { not: null }, fieldMappings: { some: {} } },
        ],
      },
    });
    if (enabledResourceCount === 0) {
      throw new BadRequestException(
        'No fully-configured resources for this integration — pick a layout and configure field mappings on at least one resource tab before triggering a sync.',
      );
    }

    let run;
    try {
      run = await this.prisma.integrationSyncRun.create({
        data: {
          integrationId,
          kind: 'manual',
          mode,
          status: 'queued',
          dryRun,
          triggeredBy: actor.id,
        },
      });
    } catch (error) {
      if (mode === 'full' && isUniqueConstraintError(error)) {
        throw new BadRequestException(
          'A scheduled sync or full reconstruction sync is already queued or running for this integration.',
        );
      }
      throw error;
    }

    await this.queues.get(QueueNames.integrationSyncOrchestrator).add(
      IntegrationSyncOrchestratorJobNames.manual,
      {
        kind: 'manual',
        integrationId,
        syncRunId: run.id,
        triggeredBy: actor.id,
        mode,
        dryRun,
      },
      {
        jobId: `manual-${run.id}`,
        attempts: 2,
        backoff: { type: 'exponential', delay: 5_000 },
      },
    );

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.integration.syncRunStarted,
      entityType: 'IntegrationSyncRun',
      entityId: run.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { kind: 'manual', mode, dryRun, mappings: enabledMappingCount },
    });

    const userIndex = await this.resolveTriggeredByUsers([run]);
    return toRunDto(run, userIndex);
  }

  /**
   * Choose a scheduled mode from durable full checkpoints. Every enabled
   * mapping × enabled/configured resource scope must have completed a full
   * traversal in the preceding 24 hours; raw or disabled checkpoint rows do
   * not satisfy the requirement.
   */
  async selectScheduledMode(
    integrationId: string,
    now = new Date(),
  ): Promise<IntegrationSyncMode> {
    const activeFull = await this.prisma.integrationSyncRun.count({
      where: {
        integrationId,
        mode: 'full',
        status: { in: ['queued', 'running'] },
      },
    });
    if (activeFull > 0) return 'incremental';

    const configuredResourceWhere = {
      integrationId,
      enabled: true,
      OR: [
        { targetKind: { not: 'asset' as const } },
        {
          targetKind: 'asset' as const,
          assetLayoutId: { not: null },
          fieldMappings: { some: {} },
        },
      ],
    };
    const [mappingCount, resourceCount] = await Promise.all([
      this.prisma.integrationCompanyMapping.count({
        where: { integrationId, enabled: true },
      }),
      this.prisma.integrationResource.count({ where: configuredResourceWhere }),
    ]);
    const expectedScopes = mappingCount * resourceCount;
    if (expectedScopes === 0) return 'incremental';

    const fullCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
    const recentFullCheckpoints = await this.prisma.integrationSyncCheckpoint.count({
      where: {
        mode: 'full',
        lastFullCompletedAt: { gte: fullCutoff },
        companyMapping: { integrationId, enabled: true },
        resource: configuredResourceWhere,
      },
    });
    return recentFullCheckpoints >= expectedScopes ? 'incremental' : 'full';
  }

  /** Persist the scheduled decision once, before any fan-out or retry. */
  async createScheduledRun(
    integrationId: string,
    requestedMode?: IntegrationSyncMode,
    now = new Date(),
    deliveryKey?: string,
  ) {
    if (deliveryKey) {
      const persisted = await this.prisma.integrationSyncRun.findUnique({
        where: { deliveryKey },
      });
      if (persisted) return { ...persisted, shouldBegin: true as const };
    }

    const activeBlocker = await this.findActiveScheduledBlocker(integrationId);
    if (activeBlocker) {
      return { ...activeBlocker, shouldBegin: false as const };
    }

    let mode = requestedMode ?? await this.selectScheduledMode(integrationId, now);
    if (mode === 'full') {
      const activeFull = await this.prisma.integrationSyncRun.count({
        where: {
          integrationId,
          mode: 'full',
          status: { in: ['queued', 'running'] },
        },
      });
      if (activeFull > 0) mode = 'incremental';
    }

    try {
      const created = await this.prisma.integrationSyncRun.create({
        data: {
          integrationId,
          kind: 'scheduled',
          mode,
          status: 'queued',
          dryRun: false,
          ...(deliveryKey ? { deliveryKey } : {}),
        },
      });
      return { ...created, shouldBegin: true as const };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      if (deliveryKey) {
        const persisted = await this.prisma.integrationSyncRun.findUnique({
          where: { deliveryKey },
        });
        if (persisted) return { ...persisted, shouldBegin: true as const };
      }

      const raceWinner = await this.findActiveScheduledBlocker(integrationId);
      if (raceWinner) return { ...raceWinner, shouldBegin: false as const };

      if (mode !== 'full') throw error;
      // A manual full may have won the separate full-run guard. Scheduled
      // work may continue incrementally, but remains subject to the durable
      // scheduled single-flight guard below.
      try {
        const created = await this.prisma.integrationSyncRun.create({
          data: {
            integrationId,
            kind: 'scheduled',
            mode: 'incremental',
            status: 'queued',
            dryRun: false,
            ...(deliveryKey ? { deliveryKey } : {}),
          },
        });
        return { ...created, shouldBegin: true as const };
      } catch (fallbackError) {
        if (!isUniqueConstraintError(fallbackError)) throw fallbackError;
        if (deliveryKey) {
          const persisted = await this.prisma.integrationSyncRun.findUnique({
            where: { deliveryKey },
          });
          if (persisted) return { ...persisted, shouldBegin: true as const };
        }
        const fallbackWinner = await this.findActiveScheduledBlocker(integrationId);
        if (fallbackWinner) return { ...fallbackWinner, shouldBegin: false as const };
        throw fallbackError;
      }
    }
  }

  private findActiveScheduledBlocker(integrationId: string) {
    return this.prisma.integrationSyncRun.findFirst({
      where: {
        integrationId,
        status: { in: ['queued', 'running'] },
        OR: [{ kind: 'scheduled' }, { mode: 'full' }],
      },
      orderBy: [{ mode: 'desc' }, { status: 'desc' }, { createdAt: 'asc' }],
    });
  }

  // -------------------------------------------------------------------
  // Worker-facing helpers
  // -------------------------------------------------------------------

  /**
   * Worker-only: claim a queued run + fan out one job per
   * (mapping × enabled-and-configured resource).
   *
   * Phase 11.1 — a single per-mapping `IntegrationSyncRunCompanyResult`
   * still represents the mapping-level outcome in the run viewer. Each
   * job posts its per-resource totals back via `mergeResourceResult`,
   * which atomically folds the resource totals into the parent
   * `result.totals.byResource` map and tracks how many resources are
   * still outstanding before the row reaches a terminal state.
   */
  async beginRun(runId: string): Promise<{
    run: { id: string; integrationId: string; mode: IntegrationSyncMode; dryRun: boolean };
    jobs: Array<{
      mappingId: string;
      resourceId: string;
      resourceIds: string[];
      companyId: string;
      auditActorId: string | null;
    }>;
  }> {
    const run = await this.prisma.integrationSyncRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        integrationId: true,
        mode: true,
        dryRun: true,
        status: true,
        triggeredBy: true,
        integration: { select: { createdBy: true } },
      },
    });
    if (!run) throw new NotFoundException(`Sync run ${runId} not found`);
    if (run.status !== 'queued' && run.status !== 'running') {
      throw new BadRequestException(
        `Sync run ${runId} is in terminal state ${run.status}`,
      );
    }

    const mappings = await this.prisma.integrationCompanyMapping.findMany({
      where: { integrationId: run.integrationId, enabled: true },
      select: { id: true, companyId: true },
    });
    const resources = await this.prisma.integrationResource.findMany({
      where: {
        integrationId: run.integrationId,
        enabled: true,
        OR: [
          { targetKind: { not: 'asset' } },
          { targetKind: 'asset', assetLayoutId: { not: null }, fieldMappings: { some: {} } },
        ],
      },
      select: { id: true, resourceKey: true, dependsOnResourceKeys: true },
    });
    let orderedResources = resources;
    try {
      orderedResources = buildResourceExecutionStages(resources).flat();
    } catch {
      // Missing/disabled dependencies are carried to the worker so it can
      // produce a visible bounded skip instead of silently omitting them.
    }
    const resourceIds = orderedResources.map((resource) => resource.id);
    const auditActorId = run.triggeredBy ?? run.integration.createdBy ?? null;
    const jobs = resourceIds.length === 0
      ? []
      : mappings.map((mapping) => ({
          mappingId: mapping.id,
          resourceId: resourceIds[0]!,
          resourceIds,
          companyId: mapping.companyId,
          auditActorId,
        }));

    await this.prisma.$transaction(async (tx) => {
      await tx.integrationSyncRun.updateMany({
        where: { id: runId, status: 'queued' },
        data: { status: 'running', startedAt: new Date() },
      });
      for (const m of mappings) {
        const resourcesForMapping = resources.length;
        await tx.integrationSyncRunCompanyResult.upsert({
          where: {
            syncRunId_integrationCompanyMappingId: {
              syncRunId: runId,
              integrationCompanyMappingId: m.id,
            },
          },
          create: {
            syncRunId: runId,
            integrationCompanyMappingId: m.id,
            companyId: m.companyId,
            status: resourcesForMapping === 0 ? 'succeeded' : 'queued',
            startedAt: resourcesForMapping === 0 ? new Date() : null,
            finishedAt: resourcesForMapping === 0 ? new Date() : null,
            totals: resourcesForMapping === 0
              ? (zeroAggregateTotals() as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
          },
          update: {},
        });
      }
    });

    const queuedResults = await this.prisma.integrationSyncRunCompanyResult.findMany({
      where: { syncRunId: runId, status: 'queued' },
      select: { integrationCompanyMappingId: true, status: true },
    });
    const queuedMappingIds = new Set(
      queuedResults
        .filter((result) => result.status === 'queued')
        .map((result) => result.integrationCompanyMappingId),
    );
    const fanoutJobs = jobs.filter((job) => queuedMappingIds.has(job.mappingId));
    for (const job of fanoutJobs) {
      await this.queues.get(QueueNames.integrationSyncMapping).add(
        IntegrationSyncMappingJobNames.syncMapping,
        {
          syncRunId: runId,
          integrationCompanyMappingId: job.mappingId,
          resourceId: job.resourceId,
          resourceIds: job.resourceIds,
          auditActorId: job.auditActorId,
          mode: run.mode,
          dryRun: run.dryRun,
        },
        {
          jobId: `mapping-${runId}-${job.mappingId}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 10_000 },
        },
      );
    }

    return {
      run: { id: run.id, integrationId: run.integrationId, mode: run.mode, dryRun: run.dryRun },
      jobs: fanoutJobs,
    };
  }

  /** Idempotent: mark the per-mapping row as running on the first
   * (mapping, resource) job to start. Subsequent calls are no-ops. */
  async markMappingRunning(runId: string, mappingId: string): Promise<void> {
    await this.prisma.integrationSyncRunCompanyResult.updateMany({
      where: {
        syncRunId: runId,
        integrationCompanyMappingId: mappingId,
        status: { in: ['queued'] },
      },
      data: { status: 'running', startedAt: new Date() },
    });
  }

  /**
   * Fold a single (mapping, resource) job's outcome into the parent
   * per-mapping result row. The row holds a `byResource` totals map and
   * a top-level sum so the run viewer can render either flavour
   * without recomputing it.
   *
   * The row reaches a terminal state once every enabled resource for
   * the mapping has reported back (queued count rolled in `expectedResources`).
   */
  async mergeResourceResult(args: {
    runId: string;
    mappingId: string;
    resourceKey: string;
    companyId: string;
    expectedResources: number;
    status: 'succeeded' | 'failed';
    totals: SyncRunTotals;
    conflicts: SyncRunConflict[];
    error: string | null;
    actorId: string | null;
    ip: string;
    userAgent: string;
  }): Promise<void> {
    const resourceTotals = syncRunTotalsSchema.parse(args.totals);
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.integrationSyncRunCompanyResult.findUnique({
        where: {
          syncRunId_integrationCompanyMappingId: {
            syncRunId: args.runId,
            integrationCompanyMappingId: args.mappingId,
          },
        },
      });
      const existingTotals = mergeAggregate(
        current?.totals,
        args.resourceKey,
        resourceTotals,
        args.status,
      );
      const existingConflicts = appendConflicts(
        current?.conflicts,
        args.resourceKey,
        args.conflicts,
      );
      const completedKeys = new Set(
        Object.keys(existingTotals.byResource ?? {}),
      );
      const allDone = completedKeys.size >= args.expectedResources;
      const anyResourceFailed = Object.values(
        existingTotals.byResource ?? {},
      ).some((resource) => resource.status === 'failed');
      const nextStatus: 'queued' | 'running' | 'succeeded' | 'failed' =
        !allDone ? 'running' : anyResourceFailed ? 'failed' : 'succeeded';

      const mergedError = replaceResourceError(
        current?.error,
        args.resourceKey,
        args.error,
      );

      await tx.integrationSyncRunCompanyResult.update({
        where: { id: current!.id },
        data: {
          status: nextStatus,
          startedAt: current?.startedAt ?? new Date(),
          finishedAt: allDone ? new Date() : null,
          // Postgres text/jsonb columns reject U+0000 (SQLSTATE 22P05);
          // upstream driver records can carry stray NUL bytes, so strip
          // them from every persisted string (shared stripNul()).
          totals: stripNul(existingTotals) as unknown as Prisma.InputJsonValue,
          conflicts: stripNul(
            existingConflicts,
          ) as unknown as Prisma.InputJsonValue,
          error: stripNul(mergedError),
        },
      });
    });

    await this.audit.log({
      actorId: args.actorId,
      action:
        args.status === 'succeeded'
          ? AUDIT_ACTIONS.integration.syncMappingFinished
          : AUDIT_ACTIONS.integration.syncMappingFailed,
      entityType: 'IntegrationCompanyMapping',
      entityId: args.mappingId,
      companyId: args.companyId,
      ip: args.ip,
      userAgent: args.userAgent,
      before: null,
      after: {
        runId: args.runId,
        resourceKey: args.resourceKey,
        totals: resourceTotals,
        error: args.error,
      },
    });
  }

  /** Aggregate child results into the parent run + close it. */
  async closeRun(runId: string, actorId: string | null): Promise<void> {
    const run = await this.prisma.integrationSyncRun.findUnique({
      where: { id: runId },
      include: { companyResults: true },
    });
    if (!run) return;
    if (run.status === 'cancelled') return;

    const aggregated = aggregateTotals(run.companyResults.map((r) => r.totals));
    const anyFailed = run.companyResults.some((r) => r.status === 'failed');
    const allTerminal = run.companyResults.every(
      (r) => r.status === 'succeeded' || r.status === 'failed',
    );
    if (!allTerminal) return;

    const status = anyFailed ? 'failed' : 'succeeded';

    const finalized = await this.prisma.$transaction(async (tx) => {
      const transition = await tx.integrationSyncRun.updateMany({
        where: { id: runId, status: { in: ['queued', 'running'] } },
        data: {
          status,
          finishedAt: new Date(),
          totals: aggregated as unknown as Prisma.InputJsonValue,
          error: anyFailed
            ? run.companyResults
                .filter((r) => r.error)
                .map((r) => r.error)
                .join('; ')
                .slice(0, 4_000) || null
            : null,
        },
      });
      // Cancellation can race the read above. The conditional transition is
      // authoritative and prevents a late child from reviving the run.
      if (transition.count === 0) return false;
      await tx.integration.update({
        where: { id: run.integrationId },
        data: {
          lastRunAt: new Date(),
          lastRunStatus: status,
        },
      });
      return true;
    });
    if (!finalized) return;

    await this.audit.log({
      actorId,
      action:
        status === 'succeeded'
          ? AUDIT_ACTIONS.integration.syncRunFinished
          : AUDIT_ACTIONS.integration.syncRunFailed,
      entityType: 'IntegrationSyncRun',
      entityId: runId,
      ip: '0.0.0.0',
      userAgent: 'worker',
      before: null,
      after: { totals: aggregated },
    });
  }

  /** Final-attempt fallback for mapping jobs that throw outside a resource outcome. */
  async failMappingJob(args: {
    runId: string;
    mappingId: string;
    error: string;
    actorId: string | null;
  }): Promise<void> {
    const current = await this.prisma.integrationSyncRunCompanyResult.findUnique({
      where: {
        syncRunId_integrationCompanyMappingId: {
          syncRunId: args.runId,
          integrationCompanyMappingId: args.mappingId,
        },
      },
      select: {
        id: true,
        companyId: true,
        totals: true,
        conflicts: true,
        syncRun: {
          select: {
            triggeredBy: true,
            integration: { select: { createdBy: true } },
          },
        },
      },
    });
    if (!current) return;
    const auditActorId =
      args.actorId ??
      current.syncRun.triggeredBy ??
      current.syncRun.integration.createdBy ??
      null;
    const parsedTotals = syncRunTotalsSchema.safeParse(current.totals);
    const totals = parsedTotals.success ? parsedTotals.data : zeroAggregateTotals();
    totals.errors += 1;
    const conflicts = appendConflicts(
      current.conflicts,
      '__mapping__',
      [{
        kind: 'driver_error',
        externalId: '',
        message: args.error.slice(0, 500),
      }],
    );
    await this.prisma.integrationSyncRunCompanyResult.update({
      where: { id: current.id },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        totals: stripNul(totals) as unknown as Prisma.InputJsonValue,
        conflicts: stripNul(conflicts) as unknown as Prisma.InputJsonValue,
        error: stripNul(args.error.slice(0, 4_000)),
      },
    });
    await this.audit.log({
      actorId: auditActorId,
      action: AUDIT_ACTIONS.integration.syncMappingFailed,
      entityType: 'IntegrationCompanyMapping',
      entityId: args.mappingId,
      companyId: current.companyId,
      ip: '0.0.0.0',
      userAgent: 'worker',
      before: null,
      after: { runId: args.runId, error: args.error.slice(0, 4_000) },
    });
    await this.closeRun(args.runId, auditActorId);
  }

  /** Worker-side: bail out a run that exploded outside per-mapping scope. */
  async failRun(runId: string, error: string): Promise<void> {
    const run = await this.prisma.integrationSyncRun.findUnique({
      where: { id: runId },
    });
    if (!run) return;
    await this.prisma.integrationSyncRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        error: error.slice(0, 4_000),
      },
    });
    await this.audit.log({
      actorId: run.triggeredBy,
      action: AUDIT_ACTIONS.integration.syncRunFailed,
      entityType: 'IntegrationSyncRun',
      entityId: runId,
      ip: '0.0.0.0',
      userAgent: 'worker',
      before: null,
      after: { error: error.slice(0, 4_000) },
    });
  }

  /**
   * Resolve the `triggeredBy` UUIDs across a batch of runs into a
   * `{ id, name, email }` index so the UI can render actor names
   * instead of raw UUIDs. Cheap one-shot lookup that bypasses the
   * tenant-scoped `User` middleware (runs are global).
   */
  private async resolveTriggeredByUsers(
    rows: ReadonlyArray<{ triggeredBy: string | null }>,
  ): Promise<Map<string, TriggeredByUser>> {
    const ids = Array.from(
      new Set(
        rows.map((r) => r.triggeredBy).filter((v): v is string => Boolean(v)),
      ),
    );
    if (ids.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, email: true },
    });
    return new Map(users.map((u) => [u.id, u]));
  }
}

export interface ResourceExecutionNode {
  id: string;
  resourceKey: string;
  dependsOnResourceKeys: string[];
}

export function buildResourceExecutionStages<T extends ResourceExecutionNode>(
  resources: readonly T[],
): T[][] {
  const byKey = new Map(resources.map((resource) => [resource.resourceKey, resource]));
  if (byKey.size !== resources.length) throw new BadRequestException('Resource keys must be unique.');
  for (const resource of resources) {
    for (const dependency of resource.dependsOnResourceKeys) {
      if (!byKey.has(dependency)) {
        throw new BadRequestException(
          `Resource ${resource.resourceKey} has missing dependency ${dependency}.`,
        );
      }
    }
  }
  const pending = new Map(byKey);
  const completed = new Set<string>();
  const stages: T[][] = [];
  while (pending.size > 0) {
    const stage = resources.filter((resource) =>
      pending.has(resource.resourceKey) &&
      resource.dependsOnResourceKeys.every((dependency) => completed.has(dependency)),
    );
    if (stage.length === 0) {
      throw new BadRequestException('Resource dependency graph contains a cycle.');
    }
    stages.push(stage);
    for (const resource of stage) {
      pending.delete(resource.resourceKey);
      completed.add(resource.resourceKey);
    }
  }
  return stages;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

type TriggeredByUser = { id: string; name: string; email: string };

function toRunDto(
  row: {
    id: string;
    integrationId: string;
    kind: 'manual' | 'scheduled';
    mode: IntegrationSyncMode;
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    dryRun: boolean;
    triggeredBy: string | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    totals: unknown;
    error: string | null;
    createdAt: Date;
  },
  users: Map<string, TriggeredByUser>,
): IntegrationSyncRunDto {
  const triggeredByUser = row.triggeredBy ? users.get(row.triggeredBy) ?? null : null;
  return {
    id: row.id,
    integrationId: row.integrationId,
    kind: row.kind,
    mode: row.mode,
    status: row.status,
    dryRun: row.dryRun,
    triggeredBy: row.triggeredBy,
    triggeredByUser,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    totals: (row.totals ?? null) as Record<string, unknown> | null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

function aggregateTotals(values: unknown[]): SyncRunTotals {
  const acc: SyncRunTotals = zeroAggregateTotals();
  const byResource: Record<string, SyncRunResourceTotals> = {};
  for (const raw of values) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as Record<string, unknown>;
    for (const k of TOTAL_KEYS) {
      const n = Number(t[k] ?? 0);
      if (Number.isFinite(n)) acc[k] += n;
    }
    const nested = t.byResource;
    if (nested && typeof nested === 'object') {
      for (const [key, value] of Object.entries(
        nested as Record<string, unknown>,
      )) {
        if (!value || typeof value !== 'object') continue;
        const partial = value as Record<string, unknown>;
        const target = byResource[key] ?? zeroResourceTotals();
        for (const k of TOTAL_KEYS) {
          const n = Number(partial[k] ?? 0);
          if (Number.isFinite(n)) target[k] += n;
        }
        byResource[key] = target;
      }
    }
  }
  if (Object.keys(byResource).length > 0) acc.byResource = byResource;
  return acc;
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'code' in error && error.code === 'P2002',
  );
}

const TOTAL_KEYS = [
  'fetched',
  'created',
  'updated',
  'unchanged',
  'claimed',
  'archived',
  'skippedAmbiguous',
  'skippedManual',
  'skippedArchived',
  'stale',
  'restored',
  'blocked',
  'secretBlocked',
  'missingDependency',
  'errors',
] as const satisfies ReadonlyArray<keyof SyncRunResourceTotals>;

export function zeroResourceTotals(): SyncRunResourceTotals {
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
    errors: 0,
  };
}

export function zeroAggregateTotals(): SyncRunTotals {
  return { ...zeroResourceTotals() };
}

/**
 * Fold one resource's per-record counters into the per-mapping result
 * row's `byResource` map AND into the top-level summed counters.
 * A retry replaces the prior resource entry and the top-level totals are
 * re-derived from the map, so replay cannot double-count.
 */
export function mergeAggregate(
  raw: unknown,
  resourceKey: string,
  resourceTotals: SyncRunTotals,
  status: 'succeeded' | 'failed',
): SyncRunTotals {
  const acc: SyncRunTotals = zeroAggregateTotals();
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    const existingByResource = r.byResource;
    if (existingByResource && typeof existingByResource === 'object') {
      acc.byResource = {} as Record<string, SyncRunResourceTotals>;
      for (const [key, value] of Object.entries(
        existingByResource as Record<string, unknown>,
      )) {
        if (!value || typeof value !== 'object') continue;
        const partial = value as Record<string, unknown>;
        const totals = zeroResourceTotals();
        for (const k of TOTAL_KEYS) {
          const n = Number(partial[k] ?? 0);
          if (Number.isFinite(n)) totals[k] = n;
        }
        totals.status = partial.status === 'failed' ? 'failed' : 'succeeded';
        acc.byResource![key] = totals;
      }
    }
  }
  acc.byResource = acc.byResource ?? {};
  acc.byResource[resourceKey] = {
    fetched: resourceTotals.fetched,
    created: resourceTotals.created,
    updated: resourceTotals.updated,
    unchanged: resourceTotals.unchanged,
    claimed: resourceTotals.claimed,
    archived: resourceTotals.archived,
    skippedAmbiguous: resourceTotals.skippedAmbiguous,
    skippedManual: resourceTotals.skippedManual,
    skippedArchived: resourceTotals.skippedArchived,
    stale: resourceTotals.stale,
    restored: resourceTotals.restored,
    blocked: resourceTotals.blocked,
    secretBlocked: resourceTotals.secretBlocked,
    missingDependency: resourceTotals.missingDependency,
    errors: resourceTotals.errors,
    status,
  };
  for (const totals of Object.values(acc.byResource)) {
    for (const k of TOTAL_KEYS) acc[k] += totals[k];
  }
  return acc;
}

interface ConflictWithResource extends SyncRunConflict {
  resourceKey?: string;
}

function appendConflicts(
  raw: unknown,
  resourceKey: string,
  next: SyncRunConflict[],
): ConflictWithResource[] {
  const existing: ConflictWithResource[] = Array.isArray(raw)
    ? (raw as ConflictWithResource[])
    : [];
  return [
    ...existing.filter((conflict) => conflict.resourceKey !== resourceKey),
    ...next.map((c) => ({ ...c, resourceKey })),
  ];
}

function replaceResourceError(
  raw: string | null | undefined,
  resourceKey: string,
  next: string | null,
): string | null {
  const prefix = `[${resourceKey}] `;
  const retained = (raw ?? '')
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith(prefix));
  if (next) retained.push(`${prefix}${next.replace(/\s+/g, ' ')}`);
  return retained.join('\n').slice(0, 4_000) || null;
}
