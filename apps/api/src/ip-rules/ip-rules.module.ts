import { Module } from '@nestjs/common';
import { IpRulesController } from './ip-rules.controller.js';
import { IpRulesService } from './ip-rules.service.js';
import { IpRuleCacheService } from './ip-rule-cache.service.js';
import { InternalOnlyGuard } from '../common/internal-only.guard.js';

/**
 * IP allow/deny rules module.
 *
 * Provides:
 *   - `IpRulesService` — CRUD over `IpRule` rows.
 *   - `IpRulesController` — admin REST surface gated by `ip_rule.manage`.
 *   - `IpRuleCacheService` — shared in-memory rule cache used by both
 *     the service (writer/invalidator) and `IpRuleGuard` (reader). Lives
 *     in this module so guard and service can both depend on it without
 *     creating a circular dependency.
 *
 * `IpRuleGuard` itself is registered as a global guard in AppModule.
 */
@Module({
  controllers: [IpRulesController],
  providers: [IpRulesService, IpRuleCacheService, InternalOnlyGuard],
  exports: [IpRulesService, IpRuleCacheService],
})
export class IpRulesModule {}
