import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module.js';
import { BackupsController } from './backups.controller.js';
import { BackupsService } from './backups.service.js';
import { BackupQueueRegistrar } from './backup-queue.registrar.js';

/**
 * Scheduled Postgres export feature.
 *
 * - `BackupsService`         — config CRUD + run history + dump download.
 * - `BackupsController`      — admin REST surface gated by `backup.manage`.
 * - `BackupQueueRegistrar`   — owns the BullMQ Job Scheduler
 *                              registrations for the `backup_config`
 *                              table: boot-time sweep + re-register,
 *                              and per-config reconcile after every
 *                              CRUD mutation.
 *
 * `EmailModule` is imported here only for symmetry with the worker
 * notify path; the API itself does not send notification emails. The
 * registrar depends on `QueuesService` (global) and `PrismaService`
 * (global), so no extra wiring is required.
 */
@Module({
  imports: [EmailModule],
  controllers: [BackupsController],
  providers: [BackupsService, BackupQueueRegistrar],
  exports: [BackupsService],
})
export class BackupsModule {}
