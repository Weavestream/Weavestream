import { Injectable } from '@nestjs/common';
import type {
  ArticleEditorMode,
  PasswordGeneratorDefaults,
  UpdateSettingsInput,
} from '@weavestream/shared';
import {
  DEFAULT_PASSWORD_GENERATOR_DEFAULTS,
  articleEditorModeSchema,
  passwordGeneratorDefaultsSchema,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
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
  passwordGeneratorDefaults: PasswordGeneratorDefaults;
  articleAutosaveEnabled: boolean;
  articleDefaultEditorMode: ArticleEditorMode;
  apiKeysEnabled: boolean;
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

  /**
   * The write and its audit row commit in one transaction, so a settings
   * change can never exist without its record. The cache is dropped in
   * `finally`, so a failure cannot leave this replica serving a value the
   * database no longer holds.
   */
  async update(
    actor: AuthedUser,
    input: UpdateSettingsInput,
    meta: { ip: string; userAgent: string },
  ): Promise<SystemSettingsDTO> {
    await this.loadOrSeed();

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
    if (input.passwordGeneratorDefaults !== undefined)
      data.passwordGeneratorDefaults = input.passwordGeneratorDefaults;
    if (input.articleAutosaveEnabled !== undefined)
      data.articleAutosaveEnabled = input.articleAutosaveEnabled;
    if (input.articleDefaultEditorMode !== undefined)
      data.articleDefaultEditorMode = input.articleDefaultEditorMode;

    try {
      const after = await this.prisma.$transaction(async (tx) => {
        // Read `before` inside the transaction so the audit row describes
        // exactly the transition that committed.
        const before = await tx.systemSetting.findUniqueOrThrow({
          where: { id: SINGLETON_ID },
        });
        const row = await tx.systemSetting.update({
          where: { id: SINGLETON_ID },
          data,
        });
        await this.audit.logWithClient(tx, {
          actorId: actor.id,
          action: AUDIT_ACTIONS.settings.update,
          entityType: 'SystemSetting',
          entityId: SINGLETON_ID,
          ip: meta.ip,
          userAgent: meta.userAgent,
          before: stripForAudit(before),
          after: stripForAudit(row),
        });
        return row;
      });
      return toDto(after);
    } finally {
      // Invalidate cache on every write attempt so the next GET reflects
      // the database immediately in-process; other replicas reconcile
      // within CACHE_TTL_MS.
      this.cache = null;
    }
  }

  /**
   * Whether API key authentication is on. Read on every Bearer request by
   * `AuthGuard`, so it goes through the same 5 s cache as `get()`: a switch-off
   * takes effect on this replica at once and on others within the TTL.
   */
  async apiKeysEnabled(): Promise<boolean> {
    return (await this.get()).apiKeysEnabled;
  }

  /**
   * Turn API key authentication on or off. Off refuses every key and every
   * mint; it does not revoke, so turning it back on restores existing keys.
   *
   * The write and its audit row commit in one transaction: a change to who
   * can authenticate must never exist without its record, and a failed audit
   * must leave the policy as it was. The cache is dropped in `finally`, so
   * even an unexpected failure cannot leave this replica's `AuthGuard`
   * serving a value the database no longer holds.
   */
  async setApiKeysEnabled(
    actor: AuthedUser,
    enabled: boolean,
    meta: { ip: string; userAgent: string },
  ): Promise<SystemSettingsDTO> {
    await this.loadOrSeed();
    try {
      const after = await this.prisma.$transaction(async (tx) => {
        // Read `before` inside the transaction so the audit row describes
        // exactly the transition that committed.
        const before = await tx.systemSetting.findUniqueOrThrow({
          where: { id: SINGLETON_ID },
          select: { apiKeysEnabled: true },
        });
        const row = await tx.systemSetting.update({
          where: { id: SINGLETON_ID },
          data: { apiKeysEnabled: enabled, updatedBy: actor.id },
        });
        await this.audit.logWithClient(tx, {
          actorId: actor.id,
          action: AUDIT_ACTIONS.settings.apiKeysToggle,
          entityType: 'SystemSetting',
          entityId: SINGLETON_ID,
          ip: meta.ip,
          userAgent: meta.userAgent,
          before: { apiKeysEnabled: before.apiKeysEnabled },
          after: { apiKeysEnabled: row.apiKeysEnabled, sessionId: actor.sessionId },
        });
        return row;
      });
      return toDto(after);
    } finally {
      this.cache = null;
    }
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

type SystemSettingRow = {
  workspaceName: string;
  workspaceSubtitle: string;
  tenantTermSingular: string;
  tenantTermPlural: string;
  tenantTermPossessive: string | null;
  passwordGeneratorDefaults?: unknown;
  articleAutosaveEnabled: boolean;
  articleDefaultEditorMode: string;
  apiKeysEnabled: boolean;
  updatedAt: Date;
};

/**
 * Coerce the persisted free-form string back through the discriminator
 * schema so a stray legacy or hand-edited value can never poison the
 * settings DTO. The DB-side CHECK constraint (migration 0047) already
 * prevents this on writes, but readers should still defend against a
 * pre-constraint row showing up after a partial restore.
 */
function readDefaultEditorMode(value: string): ArticleEditorMode {
  const parsed = articleEditorModeSchema.safeParse(value);
  return parsed.success ? parsed.data : 'tiptap';
}

/**
 * Reads the JSONB column through the zod schema and falls back to the
 * static default if the value is null or malformed. Matches the pattern
 * `MeService` uses for `searchDefaults` — a stale/partial row can never
 * leak into the UI as an invalid object.
 */
function readGeneratorDefaults(value: unknown): PasswordGeneratorDefaults {
  if (value == null) return DEFAULT_PASSWORD_GENERATOR_DEFAULTS;
  const parsed = passwordGeneratorDefaultsSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_PASSWORD_GENERATOR_DEFAULTS;
}

function toDto(row: SystemSettingRow): SystemSettingsDTO {
  return {
    workspaceName: row.workspaceName,
    workspaceSubtitle: row.workspaceSubtitle,
    tenantTermSingular: row.tenantTermSingular,
    tenantTermPlural: row.tenantTermPlural,
    tenantTermPossessive: row.tenantTermPossessive,
    passwordGeneratorDefaults: readGeneratorDefaults(
      row.passwordGeneratorDefaults,
    ),
    articleAutosaveEnabled: row.articleAutosaveEnabled,
    articleDefaultEditorMode: readDefaultEditorMode(row.articleDefaultEditorMode),
    apiKeysEnabled: row.apiKeysEnabled,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function stripForAudit(row: SystemSettingRow) {
  return {
    workspaceName: row.workspaceName,
    workspaceSubtitle: row.workspaceSubtitle,
    tenantTermSingular: row.tenantTermSingular,
    tenantTermPlural: row.tenantTermPlural,
    tenantTermPossessive: row.tenantTermPossessive,
    passwordGeneratorDefaults: readGeneratorDefaults(
      row.passwordGeneratorDefaults,
    ),
    articleAutosaveEnabled: row.articleAutosaveEnabled,
    articleDefaultEditorMode: readDefaultEditorMode(row.articleDefaultEditorMode),
    apiKeysEnabled: row.apiKeysEnabled,
  };
}
