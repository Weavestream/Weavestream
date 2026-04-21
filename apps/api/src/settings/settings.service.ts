import { Injectable } from '@nestjs/common';
import type { UpdateSettingsInput } from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * Shape returned to clients. Prisma's `SystemSetting` is mapped onto this
 * 1:1 except `updatedAt` is serialized to an ISO string and `id` is
 * dropped — the singleton id carries no information for callers.
 */
export interface SystemSettingsDTO {
  workspaceName: string;
  workspaceSubtitle: string;
  tenantTermSingular: string;
  tenantTermPlural: string;
  tenantTermPossessive: string | null;
  updatedAt: string;
}

const SINGLETON_ID = 'singleton';

@Injectable()
export class SettingsService {
  // In-process cache. `GET /settings` runs on every authenticated page
  // load, but the row is only edited from one admin form. 5s is short
  // enough to avoid stale UI after a PATCH, long enough to shave the
  // Postgres round-trip off the hot path under burst load.
  private static readonly CACHE_TTL_MS = 5_000;
  private cache: { value: SystemSettingsDTO; expiresAt: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async get(): Promise<SystemSettingsDTO> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.value;
    }

    const row = await this.loadOrSeed();
    const value = toDto(row);
    this.cache = { value, expiresAt: now + SettingsService.CACHE_TTL_MS };
    return value;
  }

  async update(
    actor: AuthedUser,
    input: UpdateSettingsInput,
    meta: { ip: string; userAgent: string },
  ): Promise<SystemSettingsDTO> {
    const before = await this.loadOrSeed();

    const data: Record<string, unknown> = { updatedBy: actor.id };
    if (input.workspaceName !== undefined) data.workspaceName = input.workspaceName;
    if (input.workspaceSubtitle !== undefined)
      data.workspaceSubtitle = input.workspaceSubtitle;
    if (input.tenantTermSingular !== undefined)
      data.tenantTermSingular = input.tenantTermSingular;
    if (input.tenantTermPlural !== undefined)
      data.tenantTermPlural = input.tenantTermPlural;
    if (input.tenantTermPossessive !== undefined)
      data.tenantTermPossessive = input.tenantTermPossessive;

    const after = await this.prisma.systemSetting.update({
      where: { id: SINGLETON_ID },
      data,
    });

    await this.audit.log({
      actorId: actor.id,
      action: 'settings.update',
      entityType: 'SystemSetting',
      entityId: SINGLETON_ID,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: stripForAudit(before),
      after: stripForAudit(after),
    });

    // Invalidate cache on every write so the next GET reflects the new
    // values immediately in-process; other replicas reconcile within
    // CACHE_TTL_MS.
    this.cache = null;
    return toDto(after);
  }

  /**
   * Defensive: if the singleton row is missing (e.g. someone truncated
   * system_settings in dev), re-seed it with defaults rather than
   * throwing. The migration already seeds it, so this path is only
   * exercised in degenerate dev states.
   */
  private async loadOrSeed() {
    const existing = await this.prisma.systemSetting.findUnique({
      where: { id: SINGLETON_ID },
    });
    if (existing) return existing;
    return this.prisma.systemSetting.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID },
      update: {},
    });
  }
}

function toDto(row: {
  workspaceName: string;
  workspaceSubtitle: string;
  tenantTermSingular: string;
  tenantTermPlural: string;
  tenantTermPossessive: string | null;
  updatedAt: Date;
}): SystemSettingsDTO {
  return {
    workspaceName: row.workspaceName,
    workspaceSubtitle: row.workspaceSubtitle,
    tenantTermSingular: row.tenantTermSingular,
    tenantTermPlural: row.tenantTermPlural,
    tenantTermPossessive: row.tenantTermPossessive,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function stripForAudit(row: {
  workspaceName: string;
  workspaceSubtitle: string;
  tenantTermSingular: string;
  tenantTermPlural: string;
  tenantTermPossessive: string | null;
}) {
  return {
    workspaceName: row.workspaceName,
    workspaceSubtitle: row.workspaceSubtitle,
    tenantTermSingular: row.tenantTermSingular,
    tenantTermPlural: row.tenantTermPlural,
    tenantTermPossessive: row.tenantTermPossessive,
  };
}
