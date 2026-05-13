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

interface ReaperOutcome {
  reaped: number;
  failed: number;
  bytesFreed: number;
  scanned: number;
  cutoff: string;
  batchSize: number;
  retentionDays: number;
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

      const outcome: ReaperOutcome = {
        reaped,
        failed,
        bytesFreed,
        scanned: rows.length,
        cutoff: cutoff.toISOString(),
        batchSize,
        retentionDays,
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

      if (reaped > 0 || failed > 0) {
        this.logger.log(
          `upload-reaper sweep: reaped=${reaped} failed=${failed} bytesFreed=${bytesFreed} (retention=${retentionDays}d)`,
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
}
