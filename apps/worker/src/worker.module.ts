import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { ConfigModule } from '../../api/src/config/config.module.js';
import { EnvService } from '../../api/src/config/env.service.js';
import { PrismaModule } from '../../api/src/prisma/prisma.module.js';
import { RedisModule } from '../../api/src/redis/redis.module.js';
import { AuditModule } from '../../api/src/audit/audit.module.js';
import { DomainsModule } from '../../api/src/domains/domains.module.js';
import { StorageModule } from '../../api/src/storage/storage.module.js';
import { CryptoModule } from '../../api/src/crypto/crypto.module.js';
import { ExportDataModule } from '../../api/src/exports/export-data.module.js';
import { IntegrationsCoreModule } from '../../api/src/integrations/integrations-core.module.js';
import { DomainChecksWorker } from './domain-checks/domain-checks.processor.js';
import { PwnedCheckWorker } from './pwned-check/pwned-check.processor.js';
import { CompanyPdfExportWorker } from './company-pdf-export/company-pdf-export.processor.js';
import { IntegrationSyncOrchestratorWorker } from './integration-sync/integration-sync-orchestrator.processor.js';
import { IntegrationSyncMappingWorker } from './integration-sync/integration-sync-mapping.processor.js';

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
  ],
  providers: [
    DomainChecksWorker,
    PwnedCheckWorker,
    CompanyPdfExportWorker,
    IntegrationSyncOrchestratorWorker,
    IntegrationSyncMappingWorker,
  ],
})
export class WorkerModule {}
