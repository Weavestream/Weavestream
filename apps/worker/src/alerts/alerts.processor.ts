import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import {
  AlertsJobNames,
  QueueNames,
  alertsJobSchema,
  type AlertsJob,
  type AlertsSendJob,
} from '@weavestream/shared';
import { EnvService } from '../../../api/src/config/env.service.js';
import { RedisService } from '../../../api/src/redis/redis.service.js';
import { PrismaService } from '../../../api/src/prisma/prisma.service.js';
import { AuditLogService } from '../../../api/src/audit/audit.service.js';
import { AUDIT_ACTIONS } from '../../../api/src/audit/audit-actions.js';
import { EmailService } from '../../../api/src/email/email.service.js';
import { AlertsRunnerService } from '../../../api/src/alerts/alerts-runner.service.js';

const SYSTEM_META = {
  ip: '127.0.0.1',
  userAgent: 'weavestream-worker/alerts',
};

/**
 * BullMQ consumer for the `alerts` queue. Two job shapes:
 *
 *   - `scan` — invokes `AlertsRunnerService.runOnce()` which
 *              evaluates SINGLE_EXPIRATION / EXPIRATION_LIST /
 *              WEBSITE_DOWN configs and enqueues per-match `send`
 *              jobs. A failure here is logged but never thrown
 *              upstream — BullMQ treats it as job failure and retries
 *              on the next cron tick.
 *   - `send` — actually delivers the email via `EmailService.send`
 *              and writes an `alert.fired` audit row on success. The
 *              dedup `AlertTrigger` row was already written before
 *              the job was enqueued, so retries here are safe (they
 *              re-send the email but never re-fire on a separate
 *              underlying event).
 */
@Injectable()
export class AlertsWorker implements OnModuleDestroy {
  private readonly logger = new Logger(AlertsWorker.name);
  private worker: Worker | null = null;

  constructor(
    private readonly env: EnvService,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly email: EmailService,
    private readonly runner: AlertsRunnerService,
  ) {}

  async start(): Promise<void> {
    if (this.worker) return;
    this.worker = new Worker(
      QueueNames.alerts,
      async (job) => this.handle(job),
      {
        connection: this.redis.bullmqConnection(),
        concurrency: 2,
      },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(
        `alerts job ${job?.id ?? '<unknown>'} failed: ${err?.message ?? err}`,
      );
    });
    await this.worker.waitUntilReady();
    this.logger.log('Worker ready — alerts queue consumer started');
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.worker) return;
    await this.worker.close();
    this.worker = null;
  }

  private async handle(job: Job<unknown, unknown, string>): Promise<unknown> {
    const parsed = alertsJobSchema.safeParse(job.data);
    if (!parsed.success) {
      throw new Error(`invalid alerts job payload: ${parsed.error.message}`);
    }
    const payload: AlertsJob = parsed.data;

    if (job.name === AlertsJobNames.scan || payload.kind === 'scan') {
      return this.runner.runOnce();
    }
    return this.handleSend(payload as AlertsSendJob);
  }

  private async handleSend(
    payload: AlertsSendJob,
  ): Promise<{ sent: true } | null> {
    // Confirm the config still exists and is enabled — an admin may
    // have archived it after the trigger row was written. We DON'T
    // delete the trigger row here so a subsequent re-enable + re-fire
    // is still deduped against the same underlying event.
    const config = await this.prisma.alertConfig.findFirst({
      where: { id: payload.alertConfigId, archivedAt: null, enabled: true },
      select: { id: true, companyId: true },
    });
    if (!config) {
      this.logger.warn(
        `alerts:send skipped — config ${payload.alertConfigId} archived or disabled`,
      );
      return null;
    }

    let success = false;
    let error: string | null = null;
    try {
      await this.email.send({
        to: payload.recipientEmails,
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
      });
      success = true;
      return { sent: true };
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      await this.audit.log({
        actorId: null,
        action: AUDIT_ACTIONS.alert.fired,
        entityType: 'AlertConfig',
        entityId: config.id,
        companyId: config.companyId,
        ip: SYSTEM_META.ip,
        userAgent: SYSTEM_META.userAgent,
        before: null,
        after: {
          recipients: payload.recipientEmails,
          subject: payload.subject,
          triggerKey: payload.triggerKey,
          success,
          error,
        },
      });
    }
  }
}
