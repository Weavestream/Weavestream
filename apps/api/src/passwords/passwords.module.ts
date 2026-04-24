import { Module } from '@nestjs/common';
import { QueuesModule } from '../queues/queues.module.js';
import { StarsModule } from '../stars/stars.module.js';
import { PasswordsService } from './passwords.service.js';

/**
 * Phase 10 — PasswordsModule.
 *
 * Service-only. Controllers are registered on the API side via
 * `AppModule.controllers` so the worker can import this module (for
 * the future pwned-check worker) without dragging the controllers'
 * HTTP-only dependencies (PermissionService, RequirePermission) into
 * its DI graph — mirrors the DomainsModule pattern.
 */
@Module({
  imports: [QueuesModule, StarsModule],
  providers: [PasswordsService],
  exports: [PasswordsService],
})
export class PasswordsModule {}
