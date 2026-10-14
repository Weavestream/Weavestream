import { Injectable } from '@nestjs/common';
import type {
  GlobalAccess,
  MembershipRole,
  PlatformCapability,
  UserRole,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { MembershipCacheService } from '../cache/membership-cache.service.js';
import { isProgrammatic } from '../common/current-user.decorator.js';
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
  /**
   * Programmatic-principal markers, carried through from `AuthedUser`. When
   * either is set the membership cache is bypassed (see `loadMemberships`).
   */
  apiKeyId?: string;
  mcpConnectionId?: string;
}

export interface PermissionTarget {
  companyId?: string;
}

export interface PermissionDecision {
  allowed: boolean;
  reason?: string;
}

@Injectable()
export class PermissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: MembershipCacheService,
  ) {}

  /**
   * Load every membership for a user (active + revoked are both fetched
   * so callers can make context-aware decisions; the scope-eval code
   * filters revoked rows itself).
   *
   * `fresh` skips Redis entirely. Programmatic principals pass it: a key or
   * MCP connection runs unattended, so a membership revoked or downgraded a
   * moment ago must bite on its next request. Interactive sessions use the
   * generation-checked cache (`MembershipCacheService.readThrough`), which
   * never serves rows loaded before the last `invalidate`.
   */
  async loadMemberships(
    userId: string,
    { fresh = false }: { fresh?: boolean } = {},
  ): Promise<MembershipSnapshot[]> {
    return this.cache.readThrough(
      userId,
      MembershipCacheService.snapshotKey(userId),
      () =>
        this.prisma.membership.findMany({
          where: { userId },
          select: {
            companyId: true,
            role: true,
            expiresAt: true,
            revokedAt: true,
          },
        }),
      { fresh, revive: reviveSnapshots },
    );
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

    const memberships = await this.loadMemberships(user.id, {
      fresh: isProgrammatic(user),
    });
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

/**
 * Which companies may `actor` see on list/feed surfaces? Returns
 * `null` for "no filter — sees every company" (SUPER_ADMIN, and
 * OPERATOR with non-NONE globalAccess: a membership only ever
 * *upgrades* access, and WS-016 makes expiry revert to globalAccess,
 * so this branch must never narrow such an operator). Otherwise the
 * set of allowed company ids. The nullable-vs-Set distinction lets
 * callers skip the `{ in: [...] }` Prisma clause entirely for
 * unfiltered actors, avoiding the Postgres empty-`IN ()` edge case.
 *
 * This is the list-surface companion to `resolveEffectiveAccess`
 * above, and the ONLY home of the membership predicate for list
 * scoping — `CompaniesService.list`, `StarsService`, and
 * `RecentCompaniesService` all consume it, so tenant filtering
 * cannot drift per surface. Expiry matters as much as revocation:
 * the resolver only counts a membership while `expiresAt` is null or
 * still in the future, and filtering on `revokedAt` alone would keep
 * serving metadata to a member whose access has lapsed. Strict `gt`
 * mirrors the resolver's `expiresAt > now`.
 *
 * Deliberately queries Prisma directly rather than the Redis-cached
 * `loadMemberships` above: list scoping reacts to a revocation
 * immediately, while the per-action resolver tolerates the 60s
 * membership cache for interactive sessions (programmatic principals
 * bypass it). A free function (like `resolveEffectiveAccess`)
 * rather than a service method so consumers pass the PrismaService
 * they already hold and their constructors stay unchanged.
 */
export async function allowedCompanyIds(
  prisma: PrismaService,
  actor: Pick<PermissionInput, 'id' | 'role' | 'globalAccess'>,
): Promise<Set<string> | null> {
  if (actor.role === 'SUPER_ADMIN') return null;
  if (
    actor.role === 'OPERATOR' &&
    actor.globalAccess !== null &&
    actor.globalAccess !== 'NONE'
  ) {
    return null;
  }
  const memberships = await prisma.membership.findMany({
    where: {
      userId: actor.id,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { companyId: true },
  });
  return new Set(memberships.map((m) => m.companyId));
}

/** Rebuild snapshot Dates from their cached JSON form. */
function reviveSnapshots(raw: unknown): MembershipSnapshot[] {
  return (raw as Array<{
    companyId: string;
    role: MembershipRole;
    expiresAt: string | null;
    revokedAt: string | null;
  }>).map((r) => ({
    companyId: r.companyId,
    role: r.role,
    expiresAt: r.expiresAt ? new Date(r.expiresAt) : null,
    revokedAt: r.revokedAt ? new Date(r.revokedAt) : null,
  }));
}
