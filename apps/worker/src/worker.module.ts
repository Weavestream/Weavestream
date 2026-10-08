import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import {
  ConfigModule,
  EnvService,
  PrismaModule,
  RedisModule,
  AuditModule,
  StorageModule,
  CryptoModule,
  EmailModule,
  QueuesProducerModule,
  RbacModule,
} from '@weavestream/api/runtime';
import { DomainsModule } from '@weavestream/api/domains';
import { IntegrationsCoreModule } from '@weavestream/api/integrations';
import { AlertsModule } from '@weavestream/api/alerts';
import { ExportDataModule } from '@weavestream/api/exports';
import { AiModule } from '@weavestream/api/ai';
import { DomainChecksWorker } from './domain-checks/domain-checks.processor.js';
import { PwnedCheckWorker } from './pwned-check/pwned-check.processor.js';
import { CompanyPdfExportWorker } from './company-pdf-export/company-pdf-export.processor.js';
import { IntegrationSyncOrchestratorWorker } from './integration-sync/integration-sync-orchestrator.processor.js';
import { IntegrationSyncMappingWorker } from './integration-sync/integration-sync-mapping.processor.js';
import { CloudflareDriftSweepWorker } from './cloudflare/cloudflare-drift-sweep.processor.js';
import { AlertsWorker } from './alerts/alerts.processor.js';
import { BackupWorker } from './backup/backup.processor.js';
import { UploadReaperWorker } from './uploads/upload-reaper.processor.js';
import { ArticleSummaryWorker } from './article-summary/article-summary.processor.js';

/**
 * Worker-side composition root. Imports only the service-only shared
 * modules the API uses (ConfigModule, PrismaModule, RedisModule,
 * AuditModule, DomainsModule). No HTTP controllers — the worker
 * consumes BullMQ queues, it does not serve requests.
 *
 * We deliberately do NOT import SearchModule / FieldTypesModule /
 * QueuesModule here:
 *   - SearchModule / FieldTypesModule aren't used by the worker's
 *     code path (domain checks don't touch the search index from
 *     app code — the `monitored_domains` trigger handles that on
 *     the DB side).
 *   - QueuesModule contains `DomainChecksQueueRegistrar`, which
 *     registers the cron repeatable job on API boot. Running it a
 *     second time inside the worker would be redundant and could
 *     cause duplicate registrations. The processor builds its own
 *     short-lived Queue when it needs to fan out scheduled jobs.
 *
 * The worker reuses `apps/api` modules directly via the extended
 * `include` in `apps/worker/tsconfig.json`, so any change to
 * `DomainsService` / `AuditLogService` picks up on both sides
 * without a cross-package publish step.
 */
@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [EnvService],
      useFactory: (env: EnvService) => ({
        pinoHttp: {
          level: env.values.LOG_LEVEL,
          genReqId: () => randomUUID(),
          transport:
            env.values.NODE_ENV === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
        },
      }),
    }),
    RedisModule,
    PrismaModule,
    CryptoModule,
    StorageModule,
    AuditModule,
    DomainsModule,
    ExportDataModule,
    IntegrationsCoreModule,
    // AssetsModule (pulled in for the integration asset writers) declares
    // AssetsController, which needs PermissionService for the copy target
    // check. The controller is inert here, but Nest still resolves it.
    RbacModule,
    // Alerts feature: the worker hosts the `alerts:scan` (cron tick)
    // and `alerts:send` consumers. We import `QueuesProducerModule`
    // (not `QueuesModule`) so the alerts:scan handler can enqueue
    // child `alerts:send` jobs without re-running the API-only
    // `DomainChecksQueueRegistrar`. `EmailModule` brings in
    // `EmailService` for the actual SMTP send.
    QueuesProducerModule,
    EmailModule,
    AlertsModule,
    // Mobile Phase 4: the article-summary consumer reads the
    // auto-summaries gate + resolved endpoint config
    // (AiSettingsService) and runs one-shot completions
    // (AiCompletionService). The module's AiSettingsController is
    // inert here — the worker never creates an HTTP server (the
    // AlertsModule precedent). CryptoModule above already provides
    // the key decryptor.
    AiModule,
  ],
  providers: [
    DomainChecksWorker,
    PwnedCheckWorker,
    CompanyPdfExportWorker,
    IntegrationSyncOrchestratorWorker,
    IntegrationSyncMappingWorker,
    CloudflareDriftSweepWorker,
    AlertsWorker,
    BackupWorker,
    UploadReaperWorker,
    ArticleSummaryWorker,
  ],
})
export class WorkerModule {}
