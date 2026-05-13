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
import { CloudflareDriftSweepWorker } from './cloudflare/cloudflare-drift-sweep.processor.js';
import { AlertsWorker } from './alerts/alerts.processor.js';
import { BackupWorker } from './backup/backup.processor.js';
import { UploadReaperWorker } from './uploads/upload-reaper.processor.js';
import { configureEgressGuard } from '../../api/src/common/egress/safe-fetch.js';
import { EnvService } from '../../api/src/config/env.service.js';
import { AuditLogService } from '../../api/src/audit/audit.service.js';
import { AUDIT_ACTIONS } from '../../api/src/audit/audit-actions.js';

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

  // Phase 6 — wire the egress / SSRF guard. Same posture as the API:
  // every outbound HTTP request from the worker (HIBP range checks,
  // domain probes, RDAP, integration syncs) flows through `safeFetch`
  // and any refusal lands in the audit log.
  const env = app.get(EnvService).values;
  const audit = app.get(AuditLogService);
  configureEgressGuard({
    allowPrivateNetworks: env.EGRESS_ALLOW_PRIVATE_NETWORKS,
    allowedPrivateCidrs: env.EGRESS_ALLOWED_PRIVATE_CIDRS,
    onBlocked: (info) => {
      void audit
        .log({
          actorId: null,
          action: AUDIT_ACTIONS.security.egressBlocked,
          entityType: 'Egress',
          entityId: null,
          ip: '127.0.0.1',
          userAgent: 'worker/egress-guard',
          before: null,
          after: {
            url: info.url,
            hostname: info.hostname,
            resolvedIps: info.resolvedIps,
            reason: info.reason,
            matchedCidr: info.matchedCidr,
          },
        })
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.error('Failed to audit egress block:', err);
        });
    },
  });

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

  const cloudflareDriftSweep = app.get(CloudflareDriftSweepWorker);
  await cloudflareDriftSweep.start();

  const alerts = app.get(AlertsWorker);
  await alerts.start();

  const backup = app.get(BackupWorker);
  await backup.start();

  const uploadReaper = app.get(UploadReaperWorker);
  await uploadReaper.start();

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
