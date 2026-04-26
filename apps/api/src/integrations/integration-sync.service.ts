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
  syncRunTotalsSchema,
  type IntegrationSyncRunCompanyResultDto,
  type IntegrationSyncRunDto,
  type SyncRunConflict,
  type SyncRunTotals,
} from '@weavestream/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import { QueuesService } from '../queues/queues.service.js';
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
  ): Promise<IntegrationSyncRunDto> {
    const integration = await this.prisma.integration.findUnique({
      where: { id: integrationId },
    });
    if (!integration) throw new NotFoundException(`Integration ${integrationId} not found`);
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

    const run = await this.prisma.integrationSyncRun.create({
      data: {
        integrationId,
        kind: 'manual',
        status: 'queued',
        dryRun,
        triggeredBy: actor.id,
      },
    });

    await this.queues.get(QueueNames.integrationSyncOrchestrator).add(
      IntegrationSyncOrchestratorJobNames.manual,
      {
        kind: 'manual',
        integrationId,
        triggeredBy: actor.id,
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
      after: { kind: 'manual', dryRun, mappings: enabledMappingCount },
    });

    const userIndex = await this.resolveTriggeredByUsers([run]);
    return toRunDto(run, userIndex);
  }

  // -------------------------------------------------------------------
  // Worker-facing helpers
  // -------------------------------------------------------------------

  /** Worker-only: claim a queued run + create child result rows. */
  async beginRun(runId: string): Promise<{
    run: { id: string; integrationId: string; dryRun: boolean };
    mappings: Array<{ id: string; companyId: string }>;
  }> {
    const run = await this.prisma.integrationSyncRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        integrationId: true,
        dryRun: true,
        status: true,
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

    await this.prisma.$transaction(async (tx) => {
      await tx.integrationSyncRun.update({
        where: { id: runId },
        data: { status: 'running', startedAt: new Date() },
      });
      for (const m of mappings) {
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
            status: 'queued',
          },
          update: {
            status: 'queued',
            error: null,
            totals: Prisma.JsonNull,
            conflicts: Prisma.JsonNull,
          },
        });
      }
    });

    for (const m of mappings) {
      await this.queues.get(QueueNames.integrationSyncMapping).add(
        IntegrationSyncMappingJobNames.syncMapping,
        {
          syncRunId: runId,
          integrationCompanyMappingId: m.id,
          dryRun: run.dryRun,
        },
        {
          jobId: `mapping-${runId}-${m.id}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 10_000 },
        },
      );
    }

    return {
      run: { id: run.id, integrationId: run.integrationId, dryRun: run.dryRun },
      mappings,
    };
  }

  async markMappingRunning(runId: string, mappingId: string): Promise<void> {
    await this.prisma.integrationSyncRunCompanyResult.update({
      where: {
        syncRunId_integrationCompanyMappingId: {
          syncRunId: runId,
          integrationCompanyMappingId: mappingId,
        },
      },
      data: { status: 'running', startedAt: new Date() },
    });
  }

  async finishMapping(args: {
    runId: string;
    mappingId: string;
    companyId: string;
    status: 'succeeded' | 'failed';
    totals: SyncRunTotals;
    conflicts: SyncRunConflict[];
    error: string | null;
    actorId: string | null;
    ip: string;
    userAgent: string;
  }): Promise<void> {
    const totals = syncRunTotalsSchema.parse(args.totals);
    await this.prisma.integrationSyncRunCompanyResult.update({
      where: {
        syncRunId_integrationCompanyMappingId: {
          syncRunId: args.runId,
          integrationCompanyMappingId: args.mappingId,
        },
      },
      data: {
        status: args.status,
        finishedAt: new Date(),
        totals: totals as unknown as Prisma.InputJsonValue,
        conflicts: args.conflicts as unknown as Prisma.InputJsonValue,
        error: args.error,
      },
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
      after: { runId: args.runId, totals, error: args.error },
    });
  }

  /** Aggregate child results into the parent run + close it. */
  async closeRun(runId: string, actorId: string | null): Promise<void> {
    const run = await this.prisma.integrationSyncRun.findUnique({
      where: { id: runId },
      include: { companyResults: true },
    });
    if (!run) return;

    const aggregated = aggregateTotals(run.companyResults.map((r) => r.totals));
    const anyFailed = run.companyResults.some((r) => r.status === 'failed');
    const allTerminal = run.companyResults.every(
      (r) => r.status === 'succeeded' || r.status === 'failed',
    );
    if (!allTerminal) return;

    const status = anyFailed ? 'failed' : 'succeeded';

    await this.prisma.$transaction(async (tx) => {
      await tx.integrationSyncRun.update({
        where: { id: runId },
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
      await tx.integration.update({
        where: { id: run.integrationId },
        data: {
          lastRunAt: new Date(),
          lastRunStatus: status,
        },
      });
    });

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

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

type TriggeredByUser = { id: string; name: string; email: string };

function toRunDto(
  row: {
    id: string;
    integrationId: string;
    kind: 'manual' | 'scheduled';
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
  const acc: SyncRunTotals = {
    fetched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    claimed: 0,
    archived: 0,
    skippedAmbiguous: 0,
    skippedManual: 0,
    errors: 0,
  };
  for (const raw of values) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as Record<string, unknown>;
    for (const k of Object.keys(acc) as Array<keyof SyncRunTotals>) {
      const n = Number(t[k] ?? 0);
      if (Number.isFinite(n)) acc[k] += n;
    }
  }
  return acc;
}
