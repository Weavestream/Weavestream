import { Module } from '@nestjs/common';
import { DomainsService } from './domains.service.js';

/**
 * Phase 8 — DomainsModule.
 *
 * Service-only module. Holds the tenant-scoped CRUD + engine-result
 * persistence logic that is reused by both the API controller (thin
 * REST wrapper) and the worker processor (scheduled + manual runs).
 *
 * HTTP controllers (`DomainsController`, `DomainsAlertsController`)
 * are registered on the API side via `AppModule.controllers` so that
 * the worker can import this module without dragging the controllers'
 * `PermissionService` dependency into its DI graph.
 */
@Module({
  providers: [DomainsService],
  exports: [DomainsService],
})
export class DomainsModule {}
