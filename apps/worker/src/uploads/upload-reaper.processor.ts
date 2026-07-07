import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import {
  QueueNames,
  UploadReaperJobNames,
  uploadReaperJobSchema,
} from '@weavestream/shared';
import { EnvService } from '../../../api/src/config/env.service.js';
import { RedisService } from '../../../api/src/redis/redis.service.js';
import { PrismaService } from '../../../api/src/prisma/prisma.service.js';
import { AuditLogService } from '../../../api/src/audit/audit.service.js';
import { AUDIT_ACTIONS } from '../../../api/src/audit/audit-actions.js';
import { LocalStorageService } from '../../../api/src/storage/local-storage.service.js';
import { pendingKey } from '../../../api/src/uploads/upload-session-keys.js';

/**
 * Postgres `pg_try_advisory_lock` arguments. Same shape as the backup
 * processor — a stable `hashtext` of a literal string scopes the lock
 * to the reaper lane so two reapers can't race over the same batch
 * even if a misconfigured BullMQ schedule double-fires.
 */
const ADVISORY_LOCK_KEY_SQL =
  "SELECT pg_try_advisory_lock(hashtext('weavestream:upload-reaper')) AS got";
const ADVISORY_UNLOCK_SQL =
  "SELECT pg_advisory_unlock(hashtext('weavestream:upload-reaper'))";

const SYSTEM_META = {
  ip: '127.0.0.1',
  userAgent: 'weavestream-worker/upload-reaper',
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

interface ReaperOutcome {
  reaped: number;
  failed: number;
  bytesFreed: number;
  scanned: number;
  cutoff: string;
  batchSize: number;
  retentionDays: number;
  /** WS-013 orphan pass: upload dirs on disk with no DB row. */
  orphanScanned: number;
  orphanRemoved: number;
  orphanSkipped: number;
  orphanFailed: number;
  skipped?: 'concurrent';
}

/**
 * Phase 7 — UploadReaperWorker.
 *
 * Consumes the `upload-reaper` BullMQ queue (one repeatable
 * `scheduled` job registered by the API). Each tick:
 *
 *   1. Takes a Postgres advisory lock so two workers can't double-reap.
 *   2. Loads up to `UPLOAD_REAPER_BATCH_SIZE` Upload rows whose
 *      `deletedAt` is older than `UPLOAD_REAPER_RETENTION_DAYS`.
 *   3. For each row, deletes the original + thumbnail bytes from
 *      local storage, removes the now-empty per-upload directory,
 *      then hard-deletes the row. If storage delete throws, the row
 *      is left alone and the next tick retries — we never delete
 *      the DB pointer to bytes we may not have purged.
 *   4. Emits a single roll-up audit row per tick with totals. Per-row
 *      audit would flood the log on installs with article-body churn.
 *
 * The row delete fires the `uploads_search_index_delete` trigger which
 * purges the search row automatically; `companies.logo_upload_id` is
 * `ON DELETE SET NULL` so a tombstoned logo upload reaping just clears
 * the company-side pointer without cascading.
 */
@Injectable()
export class UploadReaperWorker implements OnModuleDestroy {
  private readonly logger = new Logger(UploadReaperWorker.name);
  private worker: Worker | null = null;

  constructor(
    private readonly env: EnvService,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly storage: LocalStorageService,
    private readonly audit: AuditLogService,
  ) {}

  async start(): Promise<void> {
    if (this.worker) return;
    this.worker = new Worker(
      QueueNames.uploadReaper,
      async (job) => this.handle(job),
      {
        connection: this.redis.bullmqConnection(),
        // Single concurrency on top of the advisory lock. Two ticks
        // back-to-back can only run if the first releases the lock,
        // so concurrency > 1 would just burn round trips.
        concurrency: 1,
      },
    );
    this.worker.on('ready', () => {
      this.logger.log('Worker ready — upload-reaper consumer started');
    });
    this.worker.on('failed', (job, err) => {
      this.logger.error(
        `[${job?.id ?? '<unknown>'}] upload-reaper job failed: ${
          err?.message ?? err
        }`,
      );
    });
    await this.worker.waitUntilReady();
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.worker) return;
    await this.worker.close();
    this.worker = null;
  }

  // ----------------------------------------------------------------
  // Dispatch
  // ----------------------------------------------------------------

  private async handle(job: Job<unknown, unknown, string>): Promise<ReaperOutcome> {
    const parsed = uploadReaperJobSchema.safeParse(job.data);
    if (!parsed.success) {
      throw new Error(`invalid upload-reaper job payload: ${parsed.error.message}`);
    }
    if (job.name !== UploadReaperJobNames.scheduled) {
      throw new Error(`unknown upload-reaper job name: ${job.name}`);
    }
    return this.sweep();
  }

  /**
   * Visible to tests via a direct call so they don't have to construct
   * a real BullMQ Job. The handler simply parses the payload and
   * delegates here.
   */
  async sweep(): Promise<ReaperOutcome> {
    const retentionDays = this.env.values.UPLOAD_REAPER_RETENTION_DAYS;
    const batchSize = this.env.values.UPLOAD_REAPER_BATCH_SIZE;
    const cutoff = new Date(Date.now() - retentionDays * DAY_MS);

    const lockRows = (await this.prisma.$queryRawUnsafe(
      ADVISORY_LOCK_KEY_SQL,
    )) as Array<{ got: boolean }>;
    if (!lockRows[0]?.got) {
      this.logger.warn(
        'upload-reaper: advisory lock held by another sweep — skipping',
      );
      return {
        reaped: 0,
        failed: 0,
        bytesFreed: 0,
        scanned: 0,
        cutoff: cutoff.toISOString(),
        batchSize,
        retentionDays,
        orphanScanned: 0,
        orphanRemoved: 0,
        orphanSkipped: 0,
        orphanFailed: 0,
        skipped: 'concurrent',
      };
    }

    try {
      const rows = await this.prisma.upload.findMany({
        where: { deletedAt: { lt: cutoff } },
        orderBy: { deletedAt: 'asc' },
        take: batchSize,
        select: {
          id: true,
          companyId: true,
          storageKey: true,
          thumbnailKey: true,
          sizeBytes: true,
        },
      });

      let reaped = 0;
      let failed = 0;
      let bytesFreed = 0;

      for (const row of rows) {
        try {
          await this.storage.deleteObject(row.companyId, row.storageKey);
          if (row.thumbnailKey) {
            await this.storage.deleteObject(row.companyId, row.thumbnailKey);
          }
          await this.storage
            .removeUploadDirIfEmpty(row.companyId, row.id)
            .catch((err) => {
              this.logger.warn(
                `upload-reaper: rmdir failed for ${row.companyId}/uploads/${row.id}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });

          // Storage purged — only now drop the DB pointer. The
          // `uploads_search_index_delete` trigger handles the search
          // row; `companies.logo_upload_id` is ON DELETE SET NULL.
          await this.prisma.upload.delete({ where: { id: row.id } });
          reaped += 1;
          bytesFreed += row.sizeBytes ?? 0;
        } catch (err) {
          failed += 1;
          this.logger.error(
            `upload-reaper: failed to reap upload ${row.id} (company ${row.companyId}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      // WS-013 orphan pass: the row reap and the orphan removal share
      // one per-sweep work budget so a single tick never does more
      // than `batchSize` deletions in total.
      const orphans = await this.sweepOrphanDirs(batchSize - rows.length);

      const outcome: ReaperOutcome = {
        reaped,
        failed,
        bytesFreed,
        scanned: rows.length,
        cutoff: cutoff.toISOString(),
        batchSize,
        retentionDays,
        ...orphans,
      };

      // Roll-up audit row. `entityId` is null because the row aggregates
      // many uploads; `actorId` is null because the worker fires it.
      // Wrapping in try/catch keeps a transient audit-write failure
      // from blowing up an otherwise successful sweep.
      try {
        await this.audit.log({
          actorId: null,
          action: AUDIT_ACTIONS.upload.reap,
          entityType: 'Upload',
          entityId: null,
          ip: SYSTEM_META.ip,
          userAgent: SYSTEM_META.userAgent,
          before: null,
          after: outcome,
        });
      } catch (err) {
        this.logger.warn(
          `upload-reaper: audit.log failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      if (reaped > 0 || failed > 0 || orphans.orphanRemoved > 0 || orphans.orphanFailed > 0) {
        this.logger.log(
          `upload-reaper sweep: reaped=${reaped} failed=${failed} bytesFreed=${bytesFreed} ` +
            `orphansRemoved=${orphans.orphanRemoved} orphansFailed=${orphans.orphanFailed} (retention=${retentionDays}d)`,
        );
      }

      return outcome;
    } finally {
      await this.prisma
        .$queryRawUnsafe(ADVISORY_UNLOCK_SQL)
        .catch((unlockErr) => {
          this.logger.warn(
            `upload-reaper: advisory unlock failed: ${
              unlockErr instanceof Error ? unlockErr.message : String(unlockErr)
            }`,
          );
        });
    }
  }

  /**
   * WS-013 orphan pass. A relay PUT that is never confirmed leaves
   * `${companyId}/uploads/<uploadId>/` on disk with no `Upload` row —
   * the pending session is Redis-only and its 15-minute TTL erases the
   * last pointer to those bytes. This walks the storage tree and
   * removes upload directories that:
   *
   *   - are older than `UPLOAD_ORPHAN_MIN_AGE_HOURS` (dir mtime), and
   *   - have no `Upload` row of any state (soft-deleted rows belong to
   *     the retention pass above — their bytes are still referenced), and
   *   - have no live pending session in Redis (defence in depth; the
   *     age floor of 1h already dwarfs the 15-minute session TTL).
   *
   * `budget` is what remains of `UPLOAD_REAPER_BATCH_SIZE` after the
   * row reap, so one tick never does more than the configured total
   * work; anything left over is picked up on the next tick.
   */
  private async sweepOrphanDirs(budget: number): Promise<{
    orphanScanned: number;
    orphanRemoved: number;
    orphanSkipped: number;
    orphanFailed: number;
  }> {
    const counters = {
      orphanScanned: 0,
      orphanRemoved: 0,
      orphanSkipped: 0,
      orphanFailed: 0,
    };
    if (budget <= 0) return counters;
    const minAgeHours = this.env.values.UPLOAD_ORPHAN_MIN_AGE_HOURS;
    const cutoffMs = Date.now() - minAgeHours * HOUR_MS;

    let companies: string[];
    try {
      companies = await this.storage.listTenantDirs();
    } catch (err) {
      counters.orphanFailed += 1;
      this.logger.error(
        `upload-reaper: orphan pass could not enumerate storage root: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return counters;
    }

    for (const companyId of companies) {
      if (counters.orphanRemoved >= budget) break;

      let dirs: { uploadId: string; mtime: Date }[];
      try {
        dirs = await this.storage.listUploadDirs(companyId);
      } catch (err) {
        counters.orphanFailed += 1;
        this.logger.warn(
          `upload-reaper: orphan pass could not enumerate ${companyId}/uploads: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }

      const oldDirs = dirs.filter((d) => d.mtime.getTime() < cutoffMs);
      counters.orphanScanned += oldDirs.length;
      if (oldDirs.length === 0) continue;

      // One batch lookup per company; any row (live OR soft-deleted)
      // means the directory is owned and must be left alone.
      const rows = await this.prisma.upload.findMany({
        where: { id: { in: oldDirs.map((d) => d.uploadId) } },
        select: { id: true },
      });
      const owned = new Set(rows.map((r) => r.id));

      for (const dir of oldDirs) {
        if (counters.orphanRemoved >= budget) break;
        if (owned.has(dir.uploadId)) {
          counters.orphanSkipped += 1;
          continue;
        }
        try {
          if (await this.redis.client.exists(pendingKey(dir.uploadId))) {
            counters.orphanSkipped += 1;
            continue;
          }
          await this.storage.removeUploadDir(companyId, dir.uploadId);
          counters.orphanRemoved += 1;
        } catch (err) {
          counters.orphanFailed += 1;
          this.logger.warn(
            `upload-reaper: failed to remove orphan dir ${companyId}/uploads/${dir.uploadId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    return counters;
  }
}
