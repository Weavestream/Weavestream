import { Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationsCoreModule } from './integrations-core.module.js';
import { IntegrationSyncQueueRegistrar } from './integration-sync-queue.registrar.js';
import { CloudflareListsController } from './cloudflare/cloudflare-lists.controller.js';

/**
 * Phase 11 — universal integration framework module (API side).
 *
 * Imports `IntegrationsCoreModule` to get the shared service set and
 * adds the global admin controller plus the cron registrar. The
 * registrar lives here (not in the core module) because it owns the
 * scheduled-job registrations and must only run inside the API
 * process — putting it in the core module would re-run the boot-time
 * registration inside the worker.
 */
@Module({
  imports: [IntegrationsCoreModule],
  controllers: [IntegrationsController, CloudflareListsController],
  providers: [IntegrationSyncQueueRegistrar],
  exports: [IntegrationsCoreModule],
})
export class IntegrationsModule {}
