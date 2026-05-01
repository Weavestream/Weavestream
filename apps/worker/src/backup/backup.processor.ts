import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Worker, Queue, type Job } from 'bullmq';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, createWriteStream } from 'node:fs';
import * as path from 'node:path';
import {
  BackupJobNames,
  QueueNames,
  backupJobSchema,
  type BackupJob,
} from '@weavestream/shared';
import { RedisService } from '../../../api/src/redis/redis.service.js';
import { PrismaService } from '../../../api/src/prisma/prisma.service.js';
import { AuditLogService } from '../../../api/src/audit/audit.service.js';
import { AUDIT_ACTIONS } from '../../../api/src/audit/audit-actions.js';
import { EmailService } from '../../../api/src/email/email.service.js';
import { EnvService } from '../../../api/src/config/env.service.js';

/**
 * Postgres `pg_try_advisory_lock` argument used to guarantee at most
 * one backup is running at a time. The hash of the literal string
 * `'weavestream:backup'` is stable across restarts, so a job that
 * fires while one is in flight fails fast with `error='concurrent'`
 * instead of racing.
 */
const ADVISORY_LOCK_KEY_SQL =
  "SELECT pg_try_advisory_lock(hashtext('weavestream:backup')) AS got";
const ADVISORY_UNLOCK_SQL =
  "SELECT pg_advisory_unlock(hashtext('weavestream:backup'))";

const SYSTEM_META = {
  ip: '127.0.0.1',
  userAgent: 'weavestream-worker/backup',
};

const NOTIFY_TIMEOUT_MS = 30_000;

interface ManifestPayload {
  weavestreamVersion: string;
  prismaMigrationHash: string;
  passwordEncryptionKid: string | null;
  databaseUrlHostname: string;
  generatedAt: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
}

@Injectable()
export class BackupWorker implements OnModuleDestroy {
  private readonly logger = new Logger(BackupWorker.name);
  private worker: Worker | null = null;
  private pruneProducer: Queue | null = null;

  /**
   * Resolved absolute backup directory. In compose this is
   * `/var/lib/weavestream/backup` (host-bind-mounted from
   * `${DATA_DIR}/backup`); in dev it defaults to `./data/backup`
   * relative to the worker process cwd. Operators can override via
   * the `BACKUP_STORAGE_DIR` env var.
   */
  private readonly backupDir: string;

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly email: EmailService,
    private readonly env: EnvService,
  ) {
    this.backupDir = path.resolve(this.env.values.BACKUP_STORAGE_DIR);
  }

  async start(): Promise<void> {
    if (this.worker) return;

    this.pruneProducer = new Queue(QueueNames.backup, {
      connection: this.redis.bullmqConnection(),
    });

    this.worker = new Worker(
      QueueNames.backup,
      async (job: Job) => this.dispatch(job),
      {
        connection: this.redis.bullmqConnection(),
        // Single concurrency on top of the advisory lock — even if
        // BullMQ were to schedule two ticks back-to-back, only one
        // can hold the lock at a time. concurrency=1 saves the wasted
        // round trips.
        concurrency: 1,
      },
    );

    this.worker.on('completed', (job) =>
      this.logger.log(`[${job.id}] backup job completed`),
    );
    this.worker.on('failed', (job, err) =>
      this.logger.error(
        `[${job?.id ?? '<unknown>'}] backup job failed: ${err?.message ?? err}`,
      ),
    );
    await this.worker.waitUntilReady();
    this.logger.log(
      `Worker ready — backup queue consumer started (dir=${this.backupDir})`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.pruneProducer?.close().catch(() => undefined);
    this.worker = null;
    this.pruneProducer = null;
  }

  // -----------------------------------------------------------------

  private async dispatch(job: Job): Promise<void> {
    const parsed = backupJobSchema.safeParse(job.data);
    if (!parsed.success) {
      throw new Error(`Invalid backup job payload: ${parsed.error.message}`);
    }
    const payload: BackupJob = parsed.data;
    if (payload.kind === BackupJobNames.run) {
      await this.handleRun(payload);
      return;
    }
    if (payload.kind === BackupJobNames.prune) {
      await this.handlePrune(payload);
    }
  }

  // -----------------------------------------------------------------
  // run
  // -----------------------------------------------------------------

  private async handleRun(
    payload: Extract<BackupJob, { kind: 'run' }>,
  ): Promise<void> {
    const cfg = await this.prisma.backupConfig.findUnique({
      where: { id: payload.configId },
    });
    if (!cfg) {
      this.logger.warn(
        `backup:run skipped — config ${payload.configId} not found`,
      );
      return;
    }

    // Resolve or mint the BackupRun row. Manual runs come in with a
    // pre-allocated id (so the UI can poll status); cron-scheduled
    // runs let the worker create the row inline.
    const run = payload.backupRunId
      ? await this.prisma.backupRun.findUnique({
          where: { id: payload.backupRunId },
        })
      : await this.prisma.backupRun.create({
          data: {
            configId: cfg.id,
            kind: 'SCHEDULED',
            status: 'queued',
          },
        });
    if (!run) {
      this.logger.warn(
        `backup:run aborted — BackupRun ${payload.backupRunId} not found`,
      );
      return;
    }

    // Try the advisory lock. If it's held, mark the run as failed
    // with `concurrent` so it surfaces on the History tab and (if
    // configured) emits a notification.
    const lockRows = (await this.prisma.$queryRawUnsafe(
      ADVISORY_LOCK_KEY_SQL,
    )) as Array<{ got: boolean }>;
    if (!lockRows[0]?.got) {
      await this.markFailed(
        run.id,
        cfg.id,
        'concurrent',
        'Another backup is already running for this instance.',
      );
      await this.notify(cfg, 'failed', new Error('concurrent'));
      return;
    }

    let dumpPath: string | null = null;
    let manifestPath: string | null = null;
    try {
      await this.prisma.backupRun.update({
        where: { id: run.id },
        data: { status: 'running', startedAt: new Date() },
      });

      await fs.mkdir(this.backupDir, { recursive: true });
      const ts = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .replace(/-\d+Z$/, 'Z');
      const baseName = `weavestream-postgres-${ts}`;
      const tmpDump = path.join(this.backupDir, `.${baseName}.dump.tmp`);
      const finalDump = path.join(this.backupDir, `${baseName}.dump`);

      const { sizeBytes, sha256 } = await this.spawnPgDump(tmpDump);
      await fs.rename(tmpDump, finalDump);
      dumpPath = finalDump;

      const manifest = await this.buildManifest({
        filename: path.basename(finalDump),
        sizeBytes,
        sha256,
      });
      manifestPath = path.join(this.backupDir, `${baseName}.manifest.json`);
      await fs.writeFile(
        manifestPath,
        JSON.stringify(manifest, null, 2),
        'utf8',
      );

      await this.prisma.backupRun.update({
        where: { id: run.id },
        data: {
          status: 'success',
          finishedAt: new Date(),
          sizeBytes: BigInt(sizeBytes),
          dumpPath,
          manifestPath,
          manifest: manifest as unknown as object,
        },
      });
      await this.prisma.backupConfig.update({
        where: { id: cfg.id },
        data: { lastRunAt: new Date() },
      });

      await this.audit.log({
        actorId: null,
        action: AUDIT_ACTIONS.backup.runCompleted,
        entityType: 'BackupRun',
        entityId: run.id,
        ip: SYSTEM_META.ip,
        userAgent: SYSTEM_META.userAgent,
        before: null,
        after: { configId: cfg.id, sizeBytes, filename: path.basename(finalDump) },
      });

      // Enqueue a prune pass on success. Inherits the same advisory
      // lock so it never overlaps with the next run.
      if (this.pruneProducer) {
        await this.pruneProducer.add(
          BackupJobNames.prune,
          { kind: 'prune', configId: cfg.id },
          {
            attempts: 1,
            removeOnComplete: { age: 60 * 60 },
            removeOnFail: { age: 24 * 60 * 60 },
          },
        );
      }

      if (cfg.notifyOnSuccess) {
        await this.notify(cfg, 'success', null, {
          sizeBytes,
          filename: path.basename(finalDump),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`backup:run failed: ${message}`);

      // Best-effort cleanup of any partially written artefacts so
      // the host directory doesn't accumulate junk on repeated
      // failures.
      if (dumpPath) {
        await fs.rm(dumpPath, { force: true }).catch(() => undefined);
      }
      if (manifestPath) {
        await fs.rm(manifestPath, { force: true }).catch(() => undefined);
      }

      await this.markFailed(run.id, cfg.id, message, message);
      await this.notify(cfg, 'failed', err instanceof Error ? err : new Error(message));
    } finally {
      await this.prisma
        .$queryRawUnsafe(ADVISORY_UNLOCK_SQL)
        .catch((unlockErr) => {
          this.logger.warn(
            `Could not release backup advisory lock: ${
              unlockErr instanceof Error ? unlockErr.message : String(unlockErr)
            }`,
          );
        });
    }
  }

  /**
   * Spawn `pg_dump --format=custom` and stream stdout into the tmp
   * dump path while computing a sha256 inline. We pipe through a
   * passthrough hash so we never have to re-read the file off disk
   * to populate the manifest.
   */
  private async spawnPgDump(tmpPath: string): Promise<{
    sizeBytes: number;
    sha256: string;
  }> {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is not set on the worker process');
    }

    return new Promise((resolve, reject) => {
      const child = spawn(
        'pg_dump',
        [
          '--format=custom',
          '--no-owner',
          '--no-acl',
          // `--dbname` lets pg_dump consume the full connection URL
          // (host + port + db + user + password) without us having to
          // split the URI manually. The password lives only in this
          // child process's argv for the duration of the dump.
          `--dbname=${databaseUrl}`,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );

      const hash = createHash('sha256');
      let bytes = 0;

      const out = createWriteStream(tmpPath, { mode: 0o600 });
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        hash.update(chunk);
      });
      child.stdout.pipe(out);

      const stderrChunks: Buffer[] = [];
      child.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
        // Cap captured stderr so a chatty pg_dump can't OOM us.
        if (stderrChunks.length > 200) stderrChunks.shift();
      });

      child.on('error', (err) => {
        out.destroy();
        reject(err);
      });

      child.on('close', (code) => {
        out.end(() => {
          if (code === 0) {
            resolve({ sizeBytes: bytes, sha256: hash.digest('hex') });
          } else {
            const stderr = Buffer.concat(stderrChunks)
              .toString('utf8')
              .trim();
            reject(
              new Error(
                `pg_dump exited with code ${code}${stderr ? `: ${stderr}` : ''}`,
              ),
            );
          }
        });
      });
    });
  }

  private async buildManifest(parts: {
    filename: string;
    sizeBytes: number;
    sha256: string;
  }): Promise<ManifestPayload> {
    const migrationHash = await readPrismaMigrationHash();
    const databaseHostname = parseDatabaseHostname(process.env.DATABASE_URL);
    return {
      weavestreamVersion: process.env.WEAVESTREAM_VERSION ?? 'dev',
      prismaMigrationHash: migrationHash,
      passwordEncryptionKid: process.env.PASSWORD_ENCRYPTION_KEY_KID ?? null,
      databaseUrlHostname: databaseHostname,
      generatedAt: new Date().toISOString(),
      filename: parts.filename,
      sizeBytes: parts.sizeBytes,
      sha256: parts.sha256,
    };
  }

  private async markFailed(
    runId: string,
    configId: string,
    error: string,
    auditMessage: string,
  ): Promise<void> {
    await this.prisma.backupRun
      .update({
        where: { id: runId },
        data: { status: 'failed', finishedAt: new Date(), error },
      })
      .catch((err) => {
        this.logger.warn(
          `Could not mark BackupRun ${runId} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    await this.audit
      .log({
        actorId: null,
        action: AUDIT_ACTIONS.backup.runFailed,
        entityType: 'BackupRun',
        entityId: runId,
        ip: SYSTEM_META.ip,
        userAgent: SYSTEM_META.userAgent,
        before: null,
        after: { configId, error: auditMessage },
      })
      .catch((err) => {
        this.logger.warn(
          `Could not write backup.run.failed audit row: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }

  private async notify(
    cfg: { id: string; name: string; notifyEmails: string[] },
    kind: 'success' | 'failed',
    err: Error | null,
    extras?: { sizeBytes?: number; filename?: string },
  ): Promise<void> {
    if (cfg.notifyEmails.length === 0) return;
    const subject =
      kind === 'success'
        ? `[Weavestream] Backup succeeded — ${cfg.name}`
        : `[Weavestream] Backup FAILED — ${cfg.name}`;
    const lines: string[] = [];
    lines.push(`Schedule: ${cfg.name}`);
    if (kind === 'success' && extras) {
      if (extras.filename) lines.push(`File: ${extras.filename}`);
      if (typeof extras.sizeBytes === 'number') {
        lines.push(`Size: ${formatBytes(extras.sizeBytes)}`);
      }
      lines.push('');
      lines.push(
        'The backup is stored under `${DATA_DIR}/backup` on the Docker host.',
      );
      lines.push(
        'Remember to back up both `${DATA_DIR}/backup` and `${DATA_DIR}/files` to off-host storage.',
      );
    } else {
      lines.push(`Error: ${err?.message ?? 'unknown error'}`);
      lines.push('');
      lines.push(
        'Check the worker container logs for stderr from pg_dump and the BackupRun row in the admin Backups page.',
      );
    }

    const send = this.email.send({
      to: cfg.notifyEmails,
      subject,
      text: lines.join('\n'),
    });
    const timeout = new Promise<void>((resolve) =>
      setTimeout(() => resolve(), NOTIFY_TIMEOUT_MS),
    );

    try {
      await Promise.race([send, timeout]);
    } catch (e) {
      this.logger.warn(
        `Backup notification email failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  // -----------------------------------------------------------------
  // prune
  // -----------------------------------------------------------------

  private async handlePrune(
    payload: Extract<BackupJob, { kind: 'prune' }>,
  ): Promise<void> {
    const cfg = await this.prisma.backupConfig.findUnique({
      where: { id: payload.configId },
    });
    if (!cfg) return;

    const retention = (cfg.retention ?? {}) as {
      keepLast?: number;
      daily?: number;
      weekly?: number;
      monthly?: number;
    };
    const keepLast = clamp(retention.keepLast ?? 3, 0, 100);
    const keepDaily = clamp(retention.daily ?? 7, 0, 365);
    const keepWeekly = clamp(retention.weekly ?? 4, 0, 104);
    const keepMonthly = clamp(retention.monthly ?? 12, 0, 120);

    const successes = await this.prisma.backupRun.findMany({
      where: { configId: cfg.id, status: 'success' },
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        startedAt: true,
        dumpPath: true,
        manifestPath: true,
      },
    });

    if (successes.length === 0) return;

    const keepIds = new Set<string>();
    // Always keep the most recent successful run, period — operators
    // never lose a recovery anchor to retention.
    keepIds.add(successes[0]!.id);

    // Bucket-agnostic floor: always retain the N most-recent successful
    // runs regardless of GFS bucket assignment. Without this, multiple
    // runs inside the same day (manual triggers, testing) collapse
    // into a single daily slot and earlier ones get pruned the moment
    // the next run completes.
    for (let i = 0; i < Math.min(keepLast, successes.length); i += 1) {
      keepIds.add(successes[i]!.id);
    }

    pickGfs(successes, 'day', keepDaily, keepIds);
    pickGfs(successes, 'week', keepWeekly, keepIds);
    pickGfs(successes, 'month', keepMonthly, keepIds);

    const toRemove = successes.filter((r) => !keepIds.has(r.id));
    for (const r of toRemove) {
      try {
        if (r.dumpPath) await fs.rm(r.dumpPath, { force: true });
        if (r.manifestPath) await fs.rm(r.manifestPath, { force: true });
      } catch (err) {
        this.logger.warn(
          `Could not delete pruned backup ${r.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      await this.prisma.backupRun
        .update({
          where: { id: r.id },
          data: { dumpPath: null, manifestPath: null },
        })
        .catch(() => undefined);
    }

    if (toRemove.length > 0) {
      this.logger.log(
        `Pruned ${toRemove.length} old backup(s) for schedule ${cfg.id}`,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * Compute a stable hash of the prisma migrations directory so the
 * manifest can flag a restored dump that doesn't match the schema
 * version baked into the running image. In production the worker
 * Dockerfile copies the migrations to `/app/packages/db/prisma/
 * migrations`; in `pnpm dev` the worker runs from `apps/worker` so
 * the same directory lives two levels up. We probe a small list of
 * candidate roots and use the first that exists. Fails open on read
 * errors — the hash becomes `unknown:<reason>` so an operator can
 * still see *something*.
 */
async function readPrismaMigrationHash(): Promise<string> {
  const candidates = [
    '/app/packages/db/prisma/migrations',
    path.resolve(process.cwd(), 'packages/db/prisma/migrations'),
    path.resolve(process.cwd(), '../../packages/db/prisma/migrations'),
  ];
  let root: string | null = null;
  for (const c of candidates) {
    try {
      const stat = await fs.stat(c);
      if (stat.isDirectory()) {
        root = c;
        break;
      }
    } catch {
      // candidate doesn't exist — keep looking
    }
  }
  if (!root) {
    return `unknown:migrations directory not found (cwd=${process.cwd()})`;
  }
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const hash = createHash('sha256');
    for (const d of dirs) {
      hash.update(d);
      hash.update('\n');
      const sql = path.join(root, d, 'migration.sql');
      try {
        const buf = await fs.readFile(sql);
        hash.update(buf);
      } catch {
        // Migration directory without a migration.sql file is
        // unusual but not a hard error — keep going.
      }
    }
    return `sha256:${hash.digest('hex')}`;
  } catch (err) {
    return `unknown:${err instanceof Error ? err.message : 'read-failed'}`;
  }
}

function parseDatabaseHostname(url: string | undefined): string {
  if (!url) return 'unknown';
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(2)} ${units[i]}`;
}

/**
 * GFS bucket selector. Walks `runs` newest-first, picks one row per
 * bucket (yyyy-mm-dd / yyyy-Www / yyyy-mm) until `count` runs have
 * been retained. Mutates `keep` in place.
 */
function pickGfs(
  runs: Array<{ id: string; startedAt: Date | null }>,
  bucket: 'day' | 'week' | 'month',
  count: number,
  keep: Set<string>,
): void {
  if (count <= 0) return;
  const seen = new Set<string>();
  for (const r of runs) {
    if (seen.size >= count) break;
    if (!r.startedAt) continue;
    const key = bucketKey(r.startedAt, bucket);
    if (seen.has(key)) continue;
    seen.add(key);
    keep.add(r.id);
  }
}

function bucketKey(d: Date, bucket: 'day' | 'week' | 'month'): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  if (bucket === 'day') {
    return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  if (bucket === 'month') {
    return `${y}-${String(m).padStart(2, '0')}`;
  }
  // ISO week — Monday-based, matches operator intuition for "weekly".
  const target = new Date(Date.UTC(y, m - 1, day));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
