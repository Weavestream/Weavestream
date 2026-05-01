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
 * Registers BullMQ repeatable jobs for every enabled `BackupConfig`
 * row on API boot, and re-asserts after every CRUD mutation via
 * `reassert(configId)`.
 *
 * Pattern mirrors `DomainChecksQueueRegistrar` and
 * `AlertsQueueRegistrar`: the API is the single source of truth for
 * the schedule, the worker just consumes whatever shows up. Using
 * `OnApplicationBootstrap` (not `OnModuleInit`) guarantees the queue
 * map populated by `QueuesService.onModuleInit` is ready before we
 * try to add jobs.
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

    // Drop every existing repeatable on the lane — boot is the
    // authoritative re-assertion point. CRUD-time `reassert(id)` only
    // touches a single jobId.
    const existing = await queue.getRepeatableJobs();
    for (const r of existing) {
      if (r.id?.startsWith('backup:cfg:')) {
        await queue.removeRepeatableByKey(r.key).catch(() => undefined);
      }
    }

    const configs = await this.prisma.backupConfig.findMany({
      where: { enabled: true },
    });
    for (const cfg of configs) {
      await this.add(cfg.id, cfg.cron, cfg.timezone);
    }
    this.logger.log(
      `Registered ${configs.length} backup schedule(s) on boot`,
    );
  }

  /**
   * Re-assert the repeatable for a single config. Called by
   * `BackupsService` after create/update/delete so a flipped enabled
   * flag, an edited cron, or a delete take effect immediately without
   * waiting for the next API restart.
   */
  async reassert(configId: string): Promise<void> {
    const queue = this.queues.get(QueueNames.backup);
    const jobId = `backup:cfg:${configId}`;

    const repeatables = await queue.getRepeatableJobs();
    for (const r of repeatables) {
      if (r.id === jobId) {
        await queue.removeRepeatableByKey(r.key).catch(() => undefined);
      }
    }

    const cfg = await this.prisma.backupConfig.findUnique({
      where: { id: configId },
    });
    if (!cfg || !cfg.enabled) {
      this.logger.log(`Backup schedule ${configId} disabled or removed`);
      return;
    }
    await this.add(cfg.id, cfg.cron, cfg.timezone);
  }

  private async add(
    configId: string,
    cron: string,
    timezone: string | null,
  ): Promise<void> {
    const queue = this.queues.get(QueueNames.backup);
    const jobId = `backup:cfg:${configId}`;
    const payload: BackupJob = {
      kind: 'run',
      configId,
      // Cron-fired ticks intentionally omit `backupRunId` — the
      // worker mints a `SCHEDULED` `BackupRun` row inline. Manual
      // runs from the UI go through `BackupsService.runNow`, which
      // pre-allocates the row + passes its id so the UI can poll.
    };
    await queue.add(BackupJobNames.run, payload, {
      jobId,
      repeat: timezone
        ? { pattern: cron, tz: timezone }
        : { pattern: cron },
    });
    this.logger.log(
      `Registered backup schedule ${configId} with cron "${cron}" tz=${timezone ?? 'Etc/UTC'}`,
    );
  }
}
