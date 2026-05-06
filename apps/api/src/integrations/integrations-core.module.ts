import { Module } from '@nestjs/common';
import { IntegrationsService } from './integrations.service.js';
import { IntegrationCompanyMappingService } from './company-mapping.service.js';
import { IntegrationSyncService } from './integration-sync.service.js';
import { IntegrationSyncRunnerService } from './integration-sync-runner.service.js';
import { MatchResolverService } from './match-resolver.service.js';
import { IntegrationDriverRegistry } from './drivers/integration-driver.registry.js';
import { IntegrationSyncSchedulerService } from './integration-sync-scheduler.service.js';
import { CloudflareListsService } from './cloudflare/cloudflare-lists.service.js';
import { FieldTypesModule } from '../field-types/field-types.module.js';
import { SearchModule } from '../search/search.module.js';
import { QueuesProducerModule } from '../queues/queues-producer.module.js';

/**
 * Phase 11 — shared integration services.
 *
 * Imported by both the API (`IntegrationsModule`, which adds the
 * controller + cron registrar) and the worker (which only needs the
 * services to drive the BullMQ processors). Splitting the module this
 * way keeps the worker free of the controller / registrar — the
 * registrar must only run on the API side so the cron registrations
 * are owned in exactly one place.
 */
@Module({
  imports: [FieldTypesModule, SearchModule, QueuesProducerModule],
  providers: [
    IntegrationDriverRegistry,
    IntegrationsService,
    IntegrationCompanyMappingService,
    IntegrationSyncService,
    IntegrationSyncRunnerService,
    IntegrationSyncSchedulerService,
    MatchResolverService,
    CloudflareListsService,
  ],
  exports: [
    IntegrationDriverRegistry,
    IntegrationsService,
    IntegrationCompanyMappingService,
    IntegrationSyncService,
    IntegrationSyncRunnerService,
    IntegrationSyncSchedulerService,
    MatchResolverService,
    CloudflareListsService,
  ],
})
export class IntegrationsCoreModule {}
