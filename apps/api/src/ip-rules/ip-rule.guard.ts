import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { IpRulesService } from './ip-rules.service.js';
import {
  IpRuleCacheService,
  type CachedRule,
} from './ip-rule-cache.service.js';
import { normalizeIp } from '../common/request-meta.js';

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
 * Supports IPv4 single addresses (192.168.1.1) and CIDR ranges
 * (10.0.0.0/8). IPv6 is accepted but won't match any IPv4 CIDR rules.
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
    const clientIp = this.extractClientIp(req);

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

    if (rules.length === 0) {
      return true; // default-allow when no rules exist
    }

    for (const rule of rules) {
      if (this.matches(clientIp, rule.cidr)) {
        if (rule.action === 'DENY') {
          this.log.warn(
            `IP ${clientIp} blocked by rule ${rule.cidr} (priority ${rule.priority})`,
          );
          throw new ForbiddenException('Access denied by IP rule');
        }
        // ALLOW: proceed to next guard
        return true;
      }
    }

    // No rule matched: default-allow
    return true;
  }

  private async getRules(): Promise<CachedRule[]> {
    const cached = this.cache.get();
    if (cached !== null) return cached;
    const rules = await this.ipRules.loadEnabledRules();
    this.cache.set(rules);
    return rules;
  }

  /**
   * Extract the client IP from the request. Uses req.ip (set by
   * Express trust proxy) consistently with the rest of the codebase
   * and collapses IPv4-mapped IPv6 (`::ffff:1.2.3.4`) down to plain
   * v4 so rules like `192.168.1.50/32` match dual-stack clients.
   */
  private extractClientIp(req: Request): string {
    return normalizeIp(req.ip);
  }

  /**
   * Check if an IP matches a CIDR or single IP pattern.
   */
  private matches(ip: string, cidr: string): boolean {
    // Normalize to lowercase for consistency
    const target = ip.trim().toLowerCase();
    const pattern = cidr.trim().toLowerCase();

    // Single IP exact match
    if (!pattern.includes('/')) {
      return target === pattern;
    }

    // CIDR range match
    const [subnet, prefixStr] = pattern.split('/');
    if (!subnet || !prefixStr) return false;

    const prefix = parseInt(prefixStr, 10);
    if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return false;

    return this.isIpInCidr(target, subnet, prefix);
  }

  /**
   * Check if an IPv4 address falls within a CIDR range.
   */
  private isIpInCidr(ip: string, subnet: string, prefix: number): boolean {
    const ipNum = this.ipToNumber(ip);
    const subnetNum = this.ipToNumber(subnet);
    if (ipNum === null || subnetNum === null) return false;

    const mask = 0xffffffff << (32 - prefix);
    return (ipNum & mask) === (subnetNum & mask);
  }

  /**
   * Convert IPv4 address to 32-bit number.
   */
  private ipToNumber(ip: string): number | null {
    const parts = ip.split('.').map((p) => parseInt(p, 10));
    if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
      return null;
    }
    // Safe to cast after the length check
    const [a, b, c, d] = parts as [number, number, number, number];
    return (a << 24) | (b << 16) | (c << 8) | d;
  }
}
