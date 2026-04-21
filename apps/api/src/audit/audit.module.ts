import { Global, Module } from '@nestjs/common';
import { AuditLogService } from './audit.service.js';

/**
 * Service-only audit module. The HTTP controller (`AuditController`)
 * is registered on the API side via `AppModule.controllers` so that
 * `apps/worker` — which also needs `AuditLogService` to record
 * scheduled/manual domain checks — can import this module without
 * dragging the controller's `PermissionService` dependency into the
 * worker's DI graph.
 */
@Global()
@Module({
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AuditModule {}
