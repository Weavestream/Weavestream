import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import {
  BackupJobNames,
  QueueNames,
  type BackupJob,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { QueuesService } from '../queues/queues.service.js';

/**
 * Scheduler ids are colon-free and prefixed so the boot sweep can tell
 * our registrations apart from anything else in BullMQ's shared
 * `repeat` zset (legacy entries live there as opaque md5 hashes).
 */
const SCHEDULER_ID_PREFIX = 'backup-config-';

/**
 * Registers a BullMQ v5 Job Scheduler for every enabled `BackupConfig`
 * row on API boot, and reconciles a single config after every CRUD
 * mutation via `reassert(configId)`.
 *
 * Pattern mirrors `IntegrationSyncSchedulerService`. Job Schedulers
 * (`upsertJobScheduler` / `removeJobScheduler`) key the registration by
 * id, so removal is deterministic. The legacy `add(..., { repeat,
 * jobId })` path this replaces stores entries under a hashed key, and
 * in BullMQ 5.76 `getRepeatableJobs()` returns them without any `id`
 * field — the previous id-matching removal here could never match, so
 * disabling, editing, or deleting a schedule never actually
 * unregistered it and disabled schedules kept dumping.
 *
 * Two deliberate deviations from the integrations precedent:
 *  - Boot-sweep failures are not swallowed per entry. A legacy
 *    repeatable that survives the sweep while we register the new
 *    scheduler would fire twice per cron tick until the next restart,
 *    so a failed sweep aborts the pass before any registration.
 *  - `tz` is always passed, falling back to `Etc/UTC`. With `tz`
 *    omitted BullMQ's cron-parser fires in the process-local timezone,
 *    which violates the documented "Empty = Etc/UTC" contract (admin
 *    UI help text + Prisma schema comment).
 *
 * Using `OnApplicationBootstrap` (not `OnModuleInit`) guarantees the
 * queue map populated by `QueuesService.onModuleInit` is ready before
 * we touch the queue.
 */
@Injectable()
export class BackupQueueRegistrar implements OnApplicationBootstrap {
  private readonly logger = new Logger(BackupQueueRegistrar.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const queue = this.queues.get(QueueNames.backup);

    // Sweep before registering, and abort registration if the sweep
    // fails — a surviving legacy repeatable next to a fresh scheduler
    // is the duplicate-execution bug all over again. Order matters:
    // schedulers and legacy repeatables share one Redis zset, and
    // `removeRepeatableByKey` would remove a just-registered scheduler
    // as readily as a legacy entry.
    try {
      // 1. Our own Job Schedulers — stale ids from configs deleted or
      //    disabled while the API was down. BullMQ 5.76 lists them
      //    under `key`, not `id`.
      const schedulers = await queue.getJobSchedulers();
      for (const s of schedulers) {
        const id =
          (s as { id?: string; key?: string }).id ??
          (s as { key?: string }).key;
        if (typeof id === 'string' && id.startsWith(SCHEDULER_ID_PREFIX)) {
          await queue.removeJobScheduler(id);
        }
      }
      // 2. Legacy `add({ repeat })` entries. Their id is reliably
      //    undefined in BullMQ 5.76, so no filter is possible — but
      //    the backup queue only ever held our own registrations, so
      //    removing every remaining entry is safe.
      const repeatables = await queue.getRepeatableJobs();
      for (const r of repeatables) {
        await queue.removeRepeatableByKey(r.key);
      }
    } catch (err) {
      this.logger.error(
        `Backup schedule sweep failed — skipping registration until the next API restart so a leftover legacy repeatable cannot double-fire: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    const configs = await this.prisma.backupConfig.findMany({
      where: { enabled: true },
    });
    let registered = 0;
    for (const cfg of configs) {
      try {
        await this.upsert(cfg.id, cfg.cron, cfg.timezone);
        registered += 1;
      } catch (err) {
        // A single malformed row (bad cron/timezone predating the
        // CRUD-time validation) must not block the other schedules or
        // API startup.
        this.logger.error(
          `Could not register backup schedule ${cfg.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    this.logger.log(`Registered ${registered} backup schedule(s) on boot`);
  }

  /**
   * Reconcile the scheduler for a single config with its database row.
   * Called by `BackupsService` after create/update/delete so a flipped
   * enabled flag, an edited cron, or a delete take effect immediately
   * without waiting for the next API restart.
   *
   * Errors are logged and swallowed — the DB write has already
   * committed by the time we run, so a Redis hiccup must not fail the
   * HTTP request; the boot sweep re-asserts. The remove comes first
   * and is deliberately not caught on its own: if it fails we must not
   * upsert, or an edited schedule could exist twice until reboot.
   */
  async reassert(configId: string): Promise<void> {
    try {
      const queue = this.queues.get(QueueNames.backup);
      await queue.removeJobScheduler(this.schedulerIdFor(configId));

      const cfg = await this.prisma.backupConfig.findUnique({
        where: { id: configId },
      });
      if (!cfg || !cfg.enabled) {
        this.logger.log(`Backup schedule ${configId} disabled or removed`);
        return;
      }
      await this.upsert(cfg.id, cfg.cron, cfg.timezone);
    } catch (err) {
      this.logger.error(
        `Could not reassert backup schedule ${configId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async upsert(
    configId: string,
    cron: string,
    timezone: string | null,
  ): Promise<void> {
    const queue = this.queues.get(QueueNames.backup);
    const tz = timezone ?? 'Etc/UTC';
    const payload: BackupJob = {
      kind: 'run',
      configId,
      // Scheduler-fired ticks intentionally omit `backupRunId` — the
      // worker mints a `SCHEDULED` `BackupRun` row inline. Manual runs
      // from the UI go through `BackupsService.runNow`, which
      // pre-allocates the row + passes its id so the UI can poll.
    };
    await queue.upsertJobScheduler(
      this.schedulerIdFor(configId),
      { pattern: cron, tz },
      { name: BackupJobNames.run, data: payload },
    );
    this.logger.log(
      `Registered backup schedule ${configId} with cron "${cron}" tz=${tz}`,
    );
  }

  private schedulerIdFor(configId: string): string {
    return `${SCHEDULER_ID_PREFIX}${configId}`;
  }
}
