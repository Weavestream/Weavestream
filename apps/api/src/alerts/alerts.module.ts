import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module.js';
import { AlertsService } from './alerts.service.js';
import { AlertEmitterService } from './alert-emitter.service.js';
import { AlertsRunnerService } from './alerts-runner.service.js';
import { AlertsQueueRegistrar } from './alerts-queue.registrar.js';

/**
 * Service-only AlertsModule. Mirrors the DomainsModule pattern so the
 * worker can import this module and reuse the runner / emitter
 * without dragging in HTTP controllers (controllers are registered on
 * the API side via `AppModule.controllers`).
 *
 * Providers:
 *   - `AlertsService`         — CRUD over `AlertConfig` rows.
 *   - `AlertEmitterService`   — synchronous hook into
 *                               `AuditLogService.log()` for RECORD_EVENT
 *                               and PASSWORD_EVENT.
 *   - `AlertsRunnerService`   — evaluator entry point for the three
 *                               scheduled alert types (driven by the
 *                               worker's `alerts:scan` consumer).
 *   - `AlertsQueueRegistrar`  — registers the repeatable cron tick
 *                               on API boot. Worker omits this from
 *                               its DI graph by importing only the
 *                               services it needs.
 */
@Module({
  imports: [EmailModule],
  providers: [
    AlertsService,
    AlertEmitterService,
    AlertsRunnerService,
    AlertsQueueRegistrar,
  ],
  exports: [AlertsService, AlertEmitterService, AlertsRunnerService],
})
export class AlertsModule {}
