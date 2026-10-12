import { Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationsCoreModule } from './integrations-core.module.js';
import { IntegrationSyncQueueRegistrar } from './integration-sync-queue.registrar.js';
import { CloudflareListsController } from './cloudflare/cloudflare-lists.controller.js';
import { TicketsGlobalController } from './tickets-global.controller.js';
import { IntegrationOAuthController } from './oauth/integration-oauth.controller.js';
import { IntegrationOAuthService } from './oauth/integration-oauth.service.js';
import { AssetLayoutsModule } from '../asset-layouts/asset-layouts.module.js';
import { IntegrationMatchFieldController } from './integration-match-field.controller.js';
import { IntegrationMatchFieldService } from './integration-match-field.service.js';
import { AssetsModule } from '../assets/assets.module.js';
import {
  AssetIntegrationDifferencesController,
  IntegrationDifferencesController,
} from './integration-differences.controller.js';
import { IntegrationDifferencesService } from './integration-differences.service.js';
import { IntegrationPriorityController } from './integration-priority.controller.js';
import { IntegrationPriorityService } from './integration-priority.service.js';

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
  imports: [IntegrationsCoreModule, AssetLayoutsModule, AssetsModule],
  controllers: [
    IntegrationsController,
    CloudflareListsController,
    TicketsGlobalController,
    IntegrationOAuthController,
    IntegrationMatchFieldController,
    IntegrationDifferencesController,
    AssetIntegrationDifferencesController,
    IntegrationPriorityController,
  ],
  providers: [
    IntegrationSyncQueueRegistrar,
    IntegrationOAuthService,
    IntegrationMatchFieldService,
    IntegrationDifferencesService,
    IntegrationPriorityService,
  ],
  exports: [IntegrationsCoreModule],
})
export class IntegrationsModule {}
