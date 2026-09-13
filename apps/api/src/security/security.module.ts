import { Module } from '@nestjs/common';
import { SecurityController } from './security.controller.js';
import { SecurityService } from './security.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { IpRulesModule } from '../ip-rules/ip-rules.module.js';

/**
 * Read-only Security Center backend. Audit/Prisma/Redis/Env are all
 * `@Global()` modules already, so we don't re-import them here — Nest
 * hands them to the service from the root container. `AuthModule` is
 * imported for `StepUpService` so session-revoke can clear the step-up
 * window bound to the killed session. `IpRulesModule` supplies
 * `IpRulesService` for the IP rule coverage read, which uses the same
 * cached ruleset `IpRuleGuard` enforces.
 */
@Module({
  imports: [AuthModule, IpRulesModule],
  controllers: [SecurityController],
  providers: [SecurityService],
  exports: [SecurityService],
})
export class SecurityModule {}
