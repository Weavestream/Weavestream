import { Module } from '@nestjs/common';
import { SecurityController } from './security.controller.js';
import { SecurityService } from './security.service.js';

/**
 * Read-only Security Center backend. Audit/Prisma/Redis/Env are all
 * `@Global()` modules already, so we don't re-import them here — Nest
 * hands them to the service from the root container.
 */
@Module({
  controllers: [SecurityController],
  providers: [SecurityService],
  exports: [SecurityService],
})
export class SecurityModule {}
