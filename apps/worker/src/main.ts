// SPDX-License-Identifier: AGPL-3.0-or-later
import './load-env.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module.js';
import { DomainChecksWorker } from './domain-checks/domain-checks.processor.js';
import { PwnedCheckWorker } from './pwned-check/pwned-check.processor.js';
import { CompanyPdfExportWorker } from './company-pdf-export/company-pdf-export.processor.js';
import { IntegrationSyncOrchestratorWorker } from './integration-sync/integration-sync-orchestrator.processor.js';
import { IntegrationSyncMappingWorker } from './integration-sync/integration-sync-mapping.processor.js';
import { AlertsWorker } from './alerts/alerts.processor.js';

/**
 * apps/worker bootstrap.
 *
 * Uses `createApplicationContext` — no HTTP listener — because the
 * worker's job is to consume BullMQ queues, not to serve requests.
 * Shared modules (ConfigModule, PrismaModule, RedisModule,
 * AuditModule, DomainsModule, SearchModule) come in via WorkerModule
 * so the service layer is identical to apps/api.
 *
 * Graceful shutdown:
 *   - SIGTERM / SIGINT triggers NestFactory's own hook, which in turn
 *     calls `onModuleDestroy` on PrismaService, RedisService, and the
 *     DomainChecksWorker (bullmq consumer). The bullmq Worker's
 *     `close()` drains in-flight jobs before the process exits so no
 *     domain check is silently dropped.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const logger = app.get(Logger);

  const domainChecks = app.get(DomainChecksWorker);
  await domainChecks.start();

  const pwnedCheck = app.get(PwnedCheckWorker);
  await pwnedCheck.start();

  const companyPdfExport = app.get(CompanyPdfExportWorker);
  await companyPdfExport.start();

  const integrationSyncOrchestrator = app.get(IntegrationSyncOrchestratorWorker);
  await integrationSyncOrchestrator.start();

  const integrationSyncMapping = app.get(IntegrationSyncMappingWorker);
  await integrationSyncMapping.start();

  const alerts = app.get(AlertsWorker);
  await alerts.start();

  logger.log('Worker online — bullmq consumers started', 'WorkerBootstrap');

  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`Received ${signal}, draining queues…`, 'WorkerBootstrap');
    try {
      await app.close();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Shutdown error:', err);
      process.exitCode = 1;
    } finally {
      process.exit();
    }
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal worker boot error:', err);
  process.exit(1);
});
