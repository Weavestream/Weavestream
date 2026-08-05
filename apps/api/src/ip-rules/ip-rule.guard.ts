import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { matchIpRule, type IpRuleLike } from '@weavestream/shared';
import { IpRulesService } from './ip-rules.service.js';
import {
  IpRuleCacheService,
  type CachedRule,
} from './ip-rule-cache.service.js';
import { normalizeIp, userAgentOf } from '../common/request-meta.js';

/**
 * IP allow/deny guard.
 *
 * Runs before AuthGuard (registered first in AppModule). Checks the
 * client IP against enabled IpRule rows ordered by priority. The first
 * matching rule wins:
 *   - ALLOW → request proceeds to AuthGuard
 *   - DENY  → throws ForbiddenException (403)
 *
 * If no rules match, access is allowed (default-allow policy). This
 * ensures a fresh install without any rules continues to work, and
 * operators must explicitly create DENY rules to block traffic.
 *
 * Fail-safe: any error loading rules (table missing, DB down, etc.)
 * defaults to allow. Blocking every request because the rules table
 * isn't reachable would lock out admins from fixing the very thing
 * that's broken — including the migration that would create the
 * table in the first place.
 *
 * Performance: enabled rules are cached in-memory by `IpRuleCacheService`
 * (TTL = 30s) to avoid a DB round-trip on every request. The cache is
 * invalidated by `IpRulesService` writes for instant propagation within
 * a single API instance.
 *
 * The CIDR matcher itself lives in `@weavestream/shared` so the Next.js
 * `proxy.ts` can apply the same rules to page renders.
 */
@Injectable()
export class IpRuleGuard implements CanActivate {
  private readonly log = new Logger(IpRuleGuard.name);

  constructor(
    private readonly ipRules: IpRulesService,
    private readonly cache: IpRuleCacheService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const clientIp = normalizeIp(req.ip);

    let rules: CachedRule[];
    try {
      rules = await this.getRules();
    } catch (err) {
      // Fail-open: don't lock everyone out because the rules table is
      // unreachable. This is also the path taken before the migration
      // creates the table (P2021 from Prisma).
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`Could not load IP rules — defaulting to allow: ${message}`);
      return true;
    }

    const hit = matchIpRule(clientIp, rules as IpRuleLike[]);
    if (!hit) return true;
    if (hit.action === 'DENY') {
      this.log.warn(
        `IP ${clientIp} blocked by rule ${hit.cidr} (priority ${hit.priority})`,
      );
      // Detached on purpose: the 403 must not wait on Redis or Postgres.
      // The write is coalesced inside recordBlockedRequest (one audit
      // row per ip+cidr per lockout window) and feeds the "IP blocked
      // or rate limited" security alert. Observation must never change
      // the outcome — any failure here (sync or async) is logged and
      // the 403 below still throws.
      try {
        void this.ipRules
          .recordBlockedRequest(
            {
              ip: clientIp,
              cidr: hit.cidr,
              priority: hit.priority,
              path: req.originalUrl,
              userAgent: userAgentOf(req),
            },
            'api',
          )
          .catch((err) =>
            this.log.warn(
              `blocked-request audit failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      } catch (err) {
        this.log.warn(
          `blocked-request observation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      throw new ForbiddenException('Access denied by IP rule');
    }
    return true;
  }

  private async getRules(): Promise<CachedRule[]> {
    const cached = this.cache.get();
    if (cached !== null) return cached;
    const rules = await this.ipRules.loadEnabledRules();
    this.cache.set(rules);
    return rules;
  }
}
