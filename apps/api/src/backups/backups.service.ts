import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
  Inject,
} from '@nestjs/common';
import type {
  BackupConfig as BackupConfigRow,
  BackupRun as BackupRunRow,
} from '@prisma/client';
import { promises as fs } from 'node:fs';
import { createReadStream, type ReadStream } from 'node:fs';
import * as path from 'node:path';
import {
  BackupJobNames,
  QueueNames,
  backupConfigInputSchema,
  type BackupConfig,
  type BackupConfigInput,
  type BackupConfigPatch,
  type BackupRetention,
  type BackupRunDto,
  type BackupRunKind,
  type BackupRunStatus,
} from '@weavestream/shared';
import { resolveDataDir } from '@weavestream/shared/server';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import { QueuesService } from '../queues/queues.service.js';
import { EnvService } from '../config/env.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import type { RequestMeta } from '../common/request-meta.js';
import { BackupQueueRegistrar } from './backup-queue.registrar.js';

/**
 * Filenames the worker emits look like
 * `weavestream-postgres-<isoTimestamp>.dump`. We constrain reads via
 * `BackupRun.dumpPath` (the authoritative source of truth) and only
 * use this regex as a defense-in-depth check before opening a file.
 */
const SAFE_FILENAME = /^weavestream-postgres-[0-9TZ:\-]+\.dump$/;

@Injectable()
export class BackupsService {
  private readonly logger = new Logger(BackupsService.name);

  /**
   * Resolved absolute backup directory. Compose maps this to
   * `/var/lib/weavestream/backup` on the api container (read-only;
   * the worker owns the write path); dev `./data/backup` is anchored
   * to the monorepo root via `resolveDataDir` so api + worker share a
   * single path regardless of which package directory they were
   * launched from. Derived from the `BACKUP_STORAGE_DIR` env var.
   */
  private readonly backupDir: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly queues: QueuesService,
    private readonly env: EnvService,
    @Inject(forwardRef(() => BackupQueueRegistrar))
    private readonly registrar: BackupQueueRegistrar,
  ) {
    this.backupDir = resolveDataDir(this.env.values.BACKUP_STORAGE_DIR);
  }

  // ------------------------------------------------------------------
  // Config CRUD
  // ------------------------------------------------------------------

  async listConfigs(): Promise<BackupConfig[]> {
    const rows = await this.prisma.backupConfig.findMany({
      orderBy: [{ enabled: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map(toConfigDto);
  }

  async getConfigById(id: string): Promise<BackupConfig> {
    const row = await this.prisma.backupConfig.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Backup schedule not found');
    return toConfigDto(row);
  }

  async createConfig(
    actor: AuthedUser,
    input: BackupConfigInput,
    meta: RequestMeta,
  ): Promise<BackupConfig> {
    const data = sanitiseConfig(input);
    const row = await this.prisma.backupConfig.create({
      data: {
        ...data,
        createdBy: actor.id,
      },
    });
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.backup.configCreate,
      entityType: 'BackupConfig',
      entityId: row.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: toAuditPayload(row),
    });
    await this.registrar.reassert(row.id);
    return toConfigDto(row);
  }

  async updateConfig(
    actor: AuthedUser,
    id: string,
    patch: BackupConfigPatch,
    meta: RequestMeta,
  ): Promise<BackupConfig> {
    const before = await this.prisma.backupConfig.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Backup schedule not found');

    const merged = backupConfigInputSchema.parse({
      name: patch.name ?? before.name,
      enabled: patch.enabled ?? before.enabled,
      cron: patch.cron ?? before.cron,
      timezone:
        patch.timezone === undefined ? before.timezone : patch.timezone,
      retention:
        patch.retention ?? (before.retention as unknown as BackupRetention),
      notifyEmails:
        patch.notifyEmails === undefined ? before.notifyEmails : patch.notifyEmails,
      notifyOnSuccess: patch.notifyOnSuccess ?? before.notifyOnSuccess,
    });

    const data = sanitiseConfig(merged);
    const after = await this.prisma.backupConfig.update({
      where: { id },
      data,
    });

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.backup.configUpdate,
      entityType: 'BackupConfig',
      entityId: id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: toAuditPayload(before),
      after: toAuditPayload(after),
    });
    await this.registrar.reassert(id);
    return toConfigDto(after);
  }

  async deleteConfig(
    actor: AuthedUser,
    id: string,
    meta: RequestMeta,
  ): Promise<{ ok: true }> {
    const row = await this.prisma.backupConfig.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Backup schedule not found');

    await this.prisma.backupConfig.delete({ where: { id } });

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.backup.configDelete,
      entityType: 'BackupConfig',
      entityId: id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: toAuditPayload(row),
      after: null,
    });
    await this.registrar.reassert(id);
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // Runs
  // ------------------------------------------------------------------

  async listRuns(opts: { limit: number; configId?: string }): Promise<BackupRunDto[]> {
    const rows = await this.prisma.backupRun.findMany({
      where: opts.configId ? { configId: opts.configId } : undefined,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(opts.limit, 1), 200),
      include: { config: { select: { name: true } } },
    });
    return rows.map(toRunDto);
  }

  async getRunById(id: string): Promise<BackupRunDto> {
    const row = await this.prisma.backupRun.findUnique({
      where: { id },
      include: { config: { select: { name: true } } },
    });
    if (!row) throw new NotFoundException('Backup run not found');
    return toRunDto(row);
  }

  /**
   * Resolve a completed run's dump file to an absolute path inside
   * `BACKUP_DIR` and return a streaming handle plus metadata. The
   * filename is doubly validated:
   *   1. The `dumpPath` field on `BackupRun` is the authoritative
   *      pointer, written exclusively by the worker.
   *   2. We re-check the basename against `SAFE_FILENAME` before
   *      opening it, so a corrupted DB row still cannot escape the
   *      backup directory.
   */
  async openRunDump(id: string): Promise<{
    body: ReadStream;
    contentLength: number;
    filename: string;
  }> {
    const row = await this.prisma.backupRun.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Backup run not found');
    if (row.status !== 'success' || !row.dumpPath) {
      throw new NotFoundException('Backup run has no downloadable dump');
    }

    const abs = path.resolve(row.dumpPath);
    const dirRoot = this.backupDir;
    if (abs !== dirRoot && !abs.startsWith(`${dirRoot}${path.sep}`)) {
      throw new ForbiddenException('Dump path escapes backup directory');
    }

    const filename = path.basename(abs);
    if (!SAFE_FILENAME.test(filename)) {
      throw new ForbiddenException('Dump filename rejected by safety check');
    }

    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      throw new NotFoundException('Backup dump file is missing on disk');
    }
    if (!stat.isFile()) {
      throw new NotFoundException('Backup dump path is not a file');
    }

    return {
      body: createReadStream(abs),
      contentLength: stat.size,
      filename,
    };
  }

  /**
   * Audit a successful download. Called by the controller after the
   * stream has been wired up so we don't write a `downloaded` row for
   * a request that 4xx'd before bytes left the box.
   */
  async noteDownload(
    actor: AuthedUser,
    runId: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.backup.runDownloaded,
      entityType: 'BackupRun',
      entityId: runId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: null,
    });
  }

  /**
   * Enqueue an immediate `backup:run` job for the given config. Used
   * by the "Run now" admin button. Mints a fresh `BackupRun(MANUAL)`
   * row up front so the UI can poll status by run id.
   */
  async runNow(
    actor: AuthedUser,
    configId: string,
    meta: RequestMeta,
  ): Promise<BackupRunDto> {
    const cfg = await this.prisma.backupConfig.findUnique({
      where: { id: configId },
    });
    if (!cfg) throw new NotFoundException('Backup schedule not found');

    const run = await this.prisma.backupRun.create({
      data: {
        configId,
        kind: 'MANUAL',
        status: 'queued',
        triggeredBy: actor.id,
      },
      include: { config: { select: { name: true } } },
    });

    const queue = this.queues.get(QueueNames.backup);
    await queue.add(
      BackupJobNames.run,
      { kind: 'run', configId, backupRunId: run.id },
      {
        attempts: 1,
        removeOnComplete: { age: 24 * 60 * 60 },
        removeOnFail: { age: 24 * 60 * 60 },
      },
    );

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.backup.runTriggered,
      entityType: 'BackupRun',
      entityId: run.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { configId, configName: cfg.name, kind: 'MANUAL' },
    });

    return toRunDto(run);
  }
}

// ─────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────

function sanitiseConfig(input: BackupConfigInput) {
  return {
    name: input.name,
    enabled: input.enabled,
    cron: input.cron,
    timezone: input.timezone ?? null,
    retention: input.retention as unknown as object,
    notifyEmails: input.notifyEmails,
    notifyOnSuccess: input.notifyOnSuccess,
  };
}

function toConfigDto(row: BackupConfigRow): BackupConfig {
  const retention = row.retention as unknown as BackupRetention;
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    cron: row.cron,
    timezone: row.timezone,
    retention: {
      keepLast: retention?.keepLast ?? 3,
      daily: retention?.daily ?? 7,
      weekly: retention?.weekly ?? 4,
      monthly: retention?.monthly ?? 12,
    },
    notifyEmails: row.notifyEmails,
    notifyOnSuccess: row.notifyOnSuccess,
    lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAuditPayload(row: BackupConfigRow) {
  return {
    name: row.name,
    enabled: row.enabled,
    cron: row.cron,
    timezone: row.timezone,
    retention: row.retention,
    notifyEmails: row.notifyEmails,
    notifyOnSuccess: row.notifyOnSuccess,
  };
}

type RunWithConfig = BackupRunRow & { config?: { name: string } | null };

function toRunDto(row: RunWithConfig): BackupRunDto {
  return {
    id: row.id,
    configId: row.configId,
    configName: row.config?.name ?? null,
    kind: row.kind as BackupRunKind,
    status: row.status as BackupRunStatus,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    sizeBytes: row.sizeBytes !== null ? Number(row.sizeBytes) : null,
    manifest: row.manifest ?? null,
    dumpFilename: row.dumpPath ? path.basename(row.dumpPath) : null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

// Avoid TS unused-import warning when downstream callers ever drop
// references to `BadRequestException`.
void BadRequestException;
