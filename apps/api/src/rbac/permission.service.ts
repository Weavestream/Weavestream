import { Injectable } from '@nestjs/common';
import type {
  GlobalAccess,
  MembershipRole,
  PlatformCapability,
  UserRole,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { PERMISSIONS, type Action } from './permissions.js';

export interface MembershipSnapshot {
  companyId: string;
  role: MembershipRole;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export interface PermissionInput {
  id: string;
  role: UserRole;
  /** OPERATOR-only; null for SUPER_ADMIN / CONTRACTOR / CLIENT_USER. */
  globalAccess: GlobalAccess | null;
  /**
   * Granular platform-admin capabilities. SUPER_ADMIN implicitly holds
   * every capability — callers may pass an empty array for SAs and the
   * resolver will still allow capability-gated actions.
   */
  platformCapabilities: PlatformCapability[];
}

export interface PermissionTarget {
  companyId?: string;
}

export interface PermissionDecision {
  allowed: boolean;
  reason?: string;
}

const CACHE_KEY_PREFIX = 'user:';
// v2: bumped when the membership-role enum collapsed to FULL/READONLY
// so any leftover v1 entries with `OPERATOR_FULL` etc. are ignored.
const CACHE_KEY_SUFFIX = ':memberships:full:v2';
const CACHE_TTL_SEC = 60;

@Injectable()
export class PermissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Load every membership for a user (active + revoked are both fetched
   * so callers can make context-aware decisions; the scope-eval code
   * filters revoked rows itself).
   */
  async loadMemberships(userId: string): Promise<MembershipSnapshot[]> {
    const cacheKey = `${CACHE_KEY_PREFIX}${userId}${CACHE_KEY_SUFFIX}`;
    const cached = await this.redis.client.get(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as Array<{
          companyId: string;
          role: MembershipRole;
          expiresAt: string | null;
          revokedAt: string | null;
        }>;
        return parsed.map((r) => ({
          companyId: r.companyId,
          role: r.role,
          expiresAt: r.expiresAt ? new Date(r.expiresAt) : null,
          revokedAt: r.revokedAt ? new Date(r.revokedAt) : null,
        }));
      } catch {
        // fall through and refetch
      }
    }

    const rows = await this.prisma.membership.findMany({
      where: { userId },
      select: {
        companyId: true,
        role: true,
        expiresAt: true,
        revokedAt: true,
      },
    });
    await this.redis.client.set(
      cacheKey,
      JSON.stringify(rows),
      'EX',
      CACHE_TTL_SEC,
    );
    return rows;
  }

  async can(
    user: PermissionInput,
    action: Action,
    target: PermissionTarget = {},
  ): Promise<PermissionDecision> {
    if (user.role === 'SUPER_ADMIN') return { allowed: true };

    const rule = PERMISSIONS[action];
    if (!rule) {
      return { allowed: false, reason: `unknown action ${action as string}` };
    }

    // Platform-admin gate: a held capability satisfies the rule on its
    // own. For company-scoped capability rules we still require a
    // companyId in the target so audit logs can record what was
    // touched, but we do NOT additionally require a membership — an
    // elevated operator can manage any company's roster / read any
    // company's audit, mirroring SUPER_ADMIN.
    if (rule.requiredCapability) {
      if (!user.platformCapabilities.includes(rule.requiredCapability)) {
        return {
          allowed: false,
          reason: `missing capability ${rule.requiredCapability} for ${action}`,
        };
      }
      if (rule.scope === 'company' && !target.companyId) {
        return {
          allowed: false,
          reason: `company-scoped action ${action} called without companyId`,
        };
      }
      return { allowed: true };
    }

    if (rule.scope === 'global') {
      // Without a `requiredCapability`, a non-SA cannot satisfy a
      // global rule. (Currently every global rule has one; this branch
      // is defensive for future additions.)
      return { allowed: false, reason: `global action ${action} requires SUPER_ADMIN or a capability` };
    }

    if (rule.scope === 'self') {
      return { allowed: true };
    }

    // scope === 'company' without a capability gate: classic
    // FULL/READONLY membership check.
    const { companyId } = target;
    if (!companyId) {
      return {
        allowed: false,
        reason: `company-scoped action ${action} called without companyId`,
      };
    }

    const memberships = await this.loadMemberships(user.id);
    const effective = resolveEffectiveAccess(user, memberships, companyId);
    return decideFromEffective(action, rule, user.role, effective);
  }

  /**
   * Synchronous variant for unit tests: supply memberships explicitly.
   * Keeps the permission matrix test pure (no DB/Redis).
   */
  static evaluate(
    user: PermissionInput,
    action: Action,
    memberships: MembershipSnapshot[],
    target: PermissionTarget = {},
    now: Date = new Date(),
  ): PermissionDecision {
    if (user.role === 'SUPER_ADMIN') return { allowed: true };

    const rule = PERMISSIONS[action];
    if (!rule) return { allowed: false, reason: `unknown action ${action as string}` };

    if (rule.requiredCapability) {
      if (!user.platformCapabilities.includes(rule.requiredCapability)) {
        return {
          allowed: false,
          reason: `missing capability ${rule.requiredCapability} for ${action}`,
        };
      }
      if (rule.scope === 'company' && !target.companyId) {
        return {
          allowed: false,
          reason: `company-scoped action ${action} called without companyId`,
        };
      }
      return { allowed: true };
    }

    if (rule.scope === 'global') {
      return {
        allowed: false,
        reason: `global action ${action} requires SUPER_ADMIN or a capability`,
      };
    }

    if (rule.scope === 'self') return { allowed: true };

    const { companyId } = target;
    if (!companyId) {
      return {
        allowed: false,
        reason: `company-scoped action ${action} called without companyId`,
      };
    }

    const effective = resolveEffectiveAccess(user, memberships, companyId, now);
    return decideFromEffective(action, rule, user.role, effective);
  }
}

/** Effective access for a (user, companyId) pair, encoding the
 *  membership-wins-then-globalAccess rule. Returns:
 *    - 'FULL' / 'READONLY'  — usable level
 *    - 'NONE'               — explicitly no access (operator with
 *                             globalAccess=NONE and no membership)
 *    - null                 — caller is a CONTRACTOR or CLIENT_USER
 *                             without an active membership; treated
 *                             as DENY at the rule layer.
 */
export function resolveEffectiveAccess(
  user: Pick<PermissionInput, 'role' | 'globalAccess'>,
  memberships: MembershipSnapshot[],
  companyId: string,
  now: Date = new Date(),
): GlobalAccess | null {
  const membership = memberships.find(
    (m) =>
      m.companyId === companyId &&
      m.revokedAt === null &&
      (m.expiresAt === null || m.expiresAt > now),
  );
  if (membership) return membership.role;

  if (user.role === 'OPERATOR') {
    return user.globalAccess ?? 'NONE';
  }

  // CONTRACTOR / CLIENT_USER without a membership.
  return null;
}

function decideFromEffective(
  action: Action,
  rule: { allowFull: boolean; allowReadonly: boolean },
  role: UserRole,
  effective: GlobalAccess | null,
): PermissionDecision {
  if (effective === null) {
    return { allowed: false, reason: `no active membership for ${role}` };
  }
  if (effective === 'NONE') {
    return { allowed: false, reason: `effective access NONE for ${action}` };
  }
  if (effective === 'FULL' && rule.allowFull) return { allowed: true };
  if (effective === 'READONLY' && rule.allowReadonly) return { allowed: true };
  return {
    allowed: false,
    reason: `effective ${effective} not permitted for ${action}`,
  };
}
