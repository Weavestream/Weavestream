import { Injectable } from '@nestjs/common';
import type { MembershipRole, UserRole } from '@weavestream/shared';
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
}

export interface PermissionTarget {
  companyId?: string;
}

export interface PermissionDecision {
  allowed: boolean;
  reason?: string;
}

const CACHE_KEY_PREFIX = 'user:';
const CACHE_KEY_SUFFIX = ':memberships:full:v1';
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
    if (user.role === 'SUPER_ADMIN') {
      return { allowed: true };
    }

    const rule = PERMISSIONS[action];
    if (!rule) {
      return { allowed: false, reason: `unknown action ${action as string}` };
    }

    if (rule.scope === 'global') {
      if (rule.allowGlobal.includes(user.role)) {
        return { allowed: true };
      }
      return { allowed: false, reason: `global role ${user.role} not permitted for ${action}` };
    }

    if (rule.scope === 'self') {
      // Self-scoped actions are always authored inside the service
      // (e.g. /me PATCH). The caller passes their own id for symmetry.
      return { allowed: true };
    }

    // scope === 'company'
    const { companyId } = target;
    if (!companyId) {
      return {
        allowed: false,
        reason: `company-scoped action ${action} called without companyId`,
      };
    }

    const memberships = await this.loadMemberships(user.id);
    const now = new Date();
    const membership = memberships.find(
      (m) =>
        m.companyId === companyId &&
        m.revokedAt === null &&
        (m.expiresAt === null || m.expiresAt > now),
    );

    if (!membership) {
      // SUPER_ADMIN already returned; every other role requires a live
      // membership.
      return {
        allowed: false,
        reason: `no active membership for company ${companyId}`,
      };
    }

    if (rule.requireNonExpiredMembership) {
      // Already filtered above, but this branch remains for symmetry
      // with non-expired-only read actions if we ever flip one.
      if (membership.expiresAt !== null && membership.expiresAt <= now) {
        return { allowed: false, reason: 'membership expired' };
      }
    }

    if (rule.allowGlobal.includes(user.role)) {
      return { allowed: true };
    }
    if (rule.allowMembership.includes(membership.role)) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `role ${user.role}/${membership.role} not permitted for ${action} on ${companyId}`,
    };
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

    if (rule.scope === 'global') {
      return rule.allowGlobal.includes(user.role)
        ? { allowed: true }
        : { allowed: false, reason: `global role ${user.role} not permitted for ${action}` };
    }

    if (rule.scope === 'self') return { allowed: true };

    const { companyId } = target;
    if (!companyId) {
      return {
        allowed: false,
        reason: `company-scoped action ${action} called without companyId`,
      };
    }

    const membership = memberships.find(
      (m) =>
        m.companyId === companyId &&
        m.revokedAt === null &&
        (m.expiresAt === null || m.expiresAt > now),
    );
    if (!membership) {
      return { allowed: false, reason: `no active membership for ${companyId}` };
    }

    if (rule.allowGlobal.includes(user.role)) return { allowed: true };
    if (rule.allowMembership.includes(membership.role)) return { allowed: true };

    return {
      allowed: false,
      reason: `role ${user.role}/${membership.role} not permitted for ${action}`,
    };
  }
}
