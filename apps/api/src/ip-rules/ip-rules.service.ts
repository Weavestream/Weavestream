import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { IpRule as IpRuleRow } from '@prisma/client';
import {
  type IpRule,
  type IpRuleInput,
  type IpRulePatch,
  type IpRuleLike,
  matchIpRule,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import type { RequestMeta } from '../common/request-meta.js';
import { IpRuleCacheService } from './ip-rule-cache.service.js';

/**
 * CRUD service for `IpRule` rows.
 *
 * Rules are evaluated in priority order (ascending) by `IpRuleGuard`.
 * The first matching rule wins; if no rules match, access is allowed
 * (default-allow policy).
 *
 * Every write invalidates the shared rule cache so the next request
 * observes the new ruleset without waiting for the TTL.
 */
@Injectable()
export class IpRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly cache: IpRuleCacheService,
  ) {}

  async list(): Promise<IpRule[]> {
    const rows = await this.prisma.ipRule.findMany({
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });
    return rows.map(toDto);
  }

  async getById(id: string): Promise<IpRule> {
    const row = await this.prisma.ipRule.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('IP rule not found');
    return toDto(row);
  }

  async create(
    actor: AuthedUser,
    input: IpRuleInput,
    meta: RequestMeta,
  ): Promise<IpRule> {
    if (input.enabled) {
      const existing = await this.loadEnabledRules();
      const future = sortByPriority([
        ...existing,
        { cidr: input.cidr, action: input.action, priority: input.priority },
      ]);
      this.assertWouldNotSelfBlock(meta.ip, future);
    }

    const row = await this.prisma.ipRule.create({
      data: {
        cidr: input.cidr,
        action: input.action,
        note: input.note ?? null,
        priority: input.priority,
        enabled: input.enabled,
        createdBy: actor.id,
      },
    });
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.security.ipRuleCreate,
      entityType: 'IpRule',
      entityId: row.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: toAuditPayload(row),
    });
    this.cache.invalidate();
    return toDto(row);
  }

  async update(
    actor: AuthedUser,
    id: string,
    patch: IpRulePatch,
    meta: RequestMeta,
  ): Promise<IpRule> {
    const before = await this.prisma.ipRule.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('IP rule not found');

    const data: Partial<IpRuleRow> = {};
    if (patch.cidr !== undefined) data.cidr = patch.cidr;
    if (patch.action !== undefined) data.action = patch.action;
    if (patch.note !== undefined) data.note = patch.note;
    if (patch.priority !== undefined) data.priority = patch.priority;
    if (patch.enabled !== undefined) data.enabled = patch.enabled;

    const futureEnabled = patch.enabled ?? before.enabled;
    const others = await this.loadEnabledRulesExcluding(id);
    const future = futureEnabled
      ? sortByPriority([
          ...others,
          {
            cidr: patch.cidr ?? before.cidr,
            action: patch.action ?? (before.action as IpRule['action']),
            priority: patch.priority ?? before.priority,
          },
        ])
      : sortByPriority(others);
    this.assertWouldNotSelfBlock(meta.ip, future);

    const row = await this.prisma.ipRule.update({
      where: { id },
      data,
    });

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.security.ipRuleUpdate,
      entityType: 'IpRule',
      entityId: row.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: toAuditPayload(before),
      after: toAuditPayload(row),
    });

    this.cache.invalidate();
    return toDto(row);
  }

  async delete(
    actor: AuthedUser,
    id: string,
    meta: RequestMeta,
  ): Promise<{ ok: true }> {
    const before = await this.prisma.ipRule.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('IP rule not found');

    if (before.enabled) {
      const future = await this.loadEnabledRulesExcluding(id);
      this.assertWouldNotSelfBlock(meta.ip, sortByPriority(future));
    }

    await this.prisma.ipRule.delete({ where: { id } });

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.security.ipRuleDelete,
      entityType: 'IpRule',
      entityId: id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: toAuditPayload(before),
      after: null,
    });

    this.cache.invalidate();
    return { ok: true };
  }

  /**
   * Load enabled rules ordered by priority for the IpRuleGuard.
   * The guard caches this list and only calls back through after the
   * cache TTL expires (or after a write invalidates the cache), so
   * this query is cheap in practice even on hot paths.
   */
  async loadEnabledRules(): Promise<Array<{ cidr: string; action: string; priority: number }>> {
    return this.prisma.ipRule.findMany({
      where: { enabled: true },
      orderBy: { priority: 'asc' },
      select: { cidr: true, action: true, priority: true },
    });
  }

  /**
   * Same as `loadEnabledRules()` but routes through `IpRuleCacheService`
   * so callers share a single in-memory copy with `IpRuleGuard`. Used
   * by the `/ip-rules/active` endpoint the Next.js `proxy.ts` polls so
   * that DENY rules also block page renders, not just API calls.
   */
  async getActiveRulesCached(): Promise<
    Array<{ cidr: string; action: string; priority: number }>
  > {
    const cached = this.cache.get();
    if (cached !== null) return cached;
    const rules = await this.loadEnabledRules();
    this.cache.set(rules);
    return rules;
  }

  private async loadEnabledRulesExcluding(
    excludeId: string,
  ): Promise<Array<{ cidr: string; action: string; priority: number }>> {
    return this.prisma.ipRule.findMany({
      where: { enabled: true, id: { not: excludeId } },
      orderBy: { priority: 'asc' },
      select: { cidr: true, action: true, priority: true },
    });
  }

  /**
   * Refuse a create/update/delete that would leave the requesting
   * admin's own IP under a DENY rule. Without this, an admin can
   * lock themselves out of `/admin/ip-rules` with a single typo
   * (e.g. an over-broad CIDR, or deleting the ALLOW that was
   * protecting them) and the only recovery is shell on the API host
   * or a direct DB write — neither of which a typical operator has
   * to hand.
   *
   * The check evaluates the *post-change* ruleset against the IP the
   * admin is currently connecting from, so it correctly catches:
   *   - adding a DENY whose CIDR contains the admin
   *   - editing an existing rule to broaden its CIDR or flip ALLOW→DENY
   *   - deleting / disabling an ALLOW that was shielding the admin
   *
   * Escape hatch: an admin who genuinely wants to block their own
   * range can add a higher-priority ALLOW for their specific IP
   * first, then add the broad DENY — the resulting ruleset matches
   * ALLOW before DENY and the check passes.
   */
  private assertWouldNotSelfBlock(
    actorIp: string,
    futureRules: Array<{ cidr: string; action: string; priority: number }>,
  ): void {
    const hit = matchIpRule(actorIp, futureRules as IpRuleLike[]);
    if (hit?.action === 'DENY') {
      throw new BadRequestException(
        `This change would block your current IP (${actorIp}) via rule ${hit.cidr}. Add a higher-priority ALLOW rule for your IP first, or make the change from a different network.`,
      );
    }
  }
}

function sortByPriority<R extends { priority: number }>(rules: R[]): R[] {
  return [...rules].sort((a, b) => a.priority - b.priority);
}

function toDto(row: IpRuleRow): IpRule {
  return {
    id: row.id,
    cidr: row.cidr,
    action: row.action as IpRule['action'],
    note: row.note,
    priority: row.priority,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAuditPayload(row: IpRuleRow) {
  return {
    cidr: row.cidr,
    action: row.action,
    priority: row.priority,
    enabled: row.enabled,
    note: row.note,
  };
}
