import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  ArticleEditorMode,
  McpClientPolicy,
  PasswordAccessMode,
  PasswordGeneratorDefaults,
  PasswordPolicyUser,
  UpdatePasswordAccessPolicyInput,
  UpdateSettingsInput,
} from '@weavestream/shared';
import {
  DEFAULT_PASSWORD_GENERATOR_DEFAULTS,
  articleEditorModeSchema,
  mcpClientPolicySchema,
  passwordAccessModeSchema,
  passwordGeneratorDefaultsSchema,
} from '@weavestream/shared';
import type { GlobalPasswordPolicy } from '../passwords/password-access-policy.js';
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
  mcpRemoteEnabled: boolean;
  mcpClientPolicy: McpClientPolicy;
  /** Mode only — the global user list never leaves `passwordAccessPolicy()`. */
  passwordAccessMode: PasswordAccessMode;
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
  private cache: {
    value: SystemSettingsDTO;
    passwordPolicy: GlobalPasswordPolicy;
    expiresAt: number;
  } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async get(): Promise<SystemSettingsDTO> {
    return (await this.cached()).value;
  }

  private async cached() {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache;
    }

    const row = await this.loadOrSeed();
    this.cache = {
      value: toDto(row),
      passwordPolicy: readPasswordAccessPolicy(row),
      expiresAt: now + SettingsService.CACHE_TTL_MS,
    };
    return this.cache;
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
    return this.setAccessSwitch('apiKeysEnabled', AUDIT_ACTIONS.settings.apiKeysToggle, actor, enabled, meta);
  }

  /**
   * Whether remote MCP connections (AI apps over OAuth) are on. Read
   * on every `/mcp` request, every internal tool call, and every token
   * exchange, through the same 5 s cache as `apiKeysEnabled()`.
   */
  async mcpRemoteEnabled(): Promise<boolean> {
    return (await this.get()).mcpRemoteEnabled;
  }

  /**
   * Turn remote MCP connections on or off. Off refuses every `/mcp` call,
   * token exchange and consent; it does not revoke connections.
   */
  async setMcpRemoteEnabled(
    actor: AuthedUser,
    enabled: boolean,
    meta: { ip: string; userAgent: string },
  ): Promise<SystemSettingsDTO> {
    return this.setAccessSwitch('mcpRemoteEnabled', AUDIT_ACTIONS.settings.mcpRemoteToggle, actor, enabled, meta);
  }

  /**
   * Which AI apps may connect to `/mcp`. Read on every client lookup, fetch,
   * consent, token exchange and `/mcp` request, through the same 5 s cache as
   * `mcpRemoteEnabled()`. It applies whether or not connections are on.
   */
  async mcpClientPolicy(): Promise<McpClientPolicy> {
    return (await this.get()).mcpClientPolicy;
  }

  /**
   * Change which AI apps may connect. Narrowing it refuses connections from
   * other apps; it does not revoke them, so widening it again restores them.
   */
  async setMcpClientPolicy(
    actor: AuthedUser,
    policy: McpClientPolicy,
    meta: { ip: string; userAgent: string },
  ): Promise<SystemSettingsDTO> {
    return this.setAccessSwitch(
      'mcpClientPolicy',
      AUDIT_ACTIONS.settings.mcpClientPolicyChange,
      actor,
      policy,
      meta,
    );
  }

  /**
   * The global password access policy (issue #110). Read by `AuthGuard` on
   * every request through the same 5 s cache as `get()`: a change takes
   * effect on this replica at once and on others within the TTL.
   */
  async passwordAccessPolicy(): Promise<GlobalPasswordPolicy> {
    return (await this.cached()).passwordPolicy;
  }

  /**
   * Users that can be picked for the global list: active super admins
   * (always pass, shown checked, never stored) and active OPERATOR /
   * CONTRACTOR users. Client users are never eligible.
   */
  async listPasswordAccessUsers(): Promise<PasswordPolicyUser[]> {
    const users = await this.prisma.user.findMany({
      where: {
        isActive: true,
        role: { in: ['SUPER_ADMIN', 'OPERATOR', 'CONTRACTOR'] },
      },
      select: { id: true, name: true, email: true, role: true },
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
    });
    return users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role as PasswordPolicyUser['role'],
      alwaysIncluded: u.role === 'SUPER_ADMIN',
    }));
  }

  /**
   * Change the global password access policy. Every listed user must be an
   * active OPERATOR or CONTRACTOR; super admins always pass and are never
   * stored. The write and its audit row commit in one transaction, the same
   * as `setAccessSwitch`, and the cache is dropped in `finally`.
   */
  async setPasswordAccessPolicy(
    actor: AuthedUser,
    input: UpdatePasswordAccessPolicyInput,
    meta: { ip: string; userAgent: string },
  ): Promise<void> {
    const userIds = Array.from(new Set(input.userIds)).sort();
    if (userIds.length > 0) {
      const eligible = await this.prisma.user.findMany({
        where: {
          id: { in: userIds },
          isActive: true,
          role: { in: ['OPERATOR', 'CONTRACTOR'] },
        },
        select: { id: true },
      });
      const eligibleIds = new Set(eligible.map((u) => u.id));
      const invalid = userIds.filter((id) => !eligibleIds.has(id));
      if (invalid.length > 0) {
        throw new BadRequestException({
          error: 'InvalidPasswordAccessUsers',
          message:
            'The password access list can only include active operators and contractors. Super admins always have access.',
          userIds: invalid,
        });
      }
    }

    await this.loadOrSeed();
    try {
      await this.prisma.$transaction(async (tx) => {
        const before = await tx.systemSetting.findUniqueOrThrow({
          where: { id: SINGLETON_ID },
          select: { passwordAccessMode: true, passwordAccessUserIds: true },
        });
        const row = await tx.systemSetting.update({
          where: { id: SINGLETON_ID },
          data: {
            passwordAccessMode: input.mode,
            passwordAccessUserIds: userIds,
            updatedBy: actor.id,
          },
          select: { passwordAccessMode: true, passwordAccessUserIds: true },
        });
        // User ids only (never names or emails) — the same class as actorId.
        await this.audit.logWithClient(tx, {
          actorId: actor.id,
          action: AUDIT_ACTIONS.settings.passwordAccessPolicyChange,
          entityType: 'SystemSetting',
          entityId: SINGLETON_ID,
          ip: meta.ip,
          userAgent: meta.userAgent,
          before: {
            mode: before.passwordAccessMode,
            userIds: before.passwordAccessUserIds,
          },
          after: {
            mode: row.passwordAccessMode,
            userIds: row.passwordAccessUserIds,
            sessionId: actor.sessionId,
          },
        });
      });
    } finally {
      this.cache = null;
    }
  }

  /**
   * Change one instance-wide access setting. The write and its audit row commit
   * in one transaction: a change to who can authenticate must never exist
   * without its record, and a failed audit must leave the policy as it was.
   * The cache is dropped in `finally`, so even an unexpected failure cannot
   * leave this replica's guards serving a value the database no longer holds.
   */
  private async setAccessSwitch<K extends AccessField>(
    field: K,
    action: string,
    actor: AuthedUser,
    value: AccessValues[K],
    meta: { ip: string; userAgent: string },
  ): Promise<SystemSettingsDTO> {
    await this.loadOrSeed();
    try {
      const after = await this.prisma.$transaction(async (tx) => {
        // Read `before` inside the transaction so the audit row describes
        // exactly the transition that committed.
        const before = await tx.systemSetting.findUniqueOrThrow({
          where: { id: SINGLETON_ID },
          select: { [field]: true } as Record<AccessField, true>,
        });
        const row = await tx.systemSetting.update({
          where: { id: SINGLETON_ID },
          data: { [field]: value, updatedBy: actor.id },
        });
        await this.audit.logWithClient(tx, {
          actorId: actor.id,
          action,
          entityType: 'SystemSetting',
          entityId: SINGLETON_ID,
          ip: meta.ip,
          userAgent: meta.userAgent,
          before: { [field]: (before as Record<string, unknown>)[field] },
          after: { [field]: row[field], sessionId: actor.sessionId },
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

/** The settings changed only through their own step-up route. */
type AccessValues = {
  apiKeysEnabled: boolean;
  mcpRemoteEnabled: boolean;
  mcpClientPolicy: McpClientPolicy;
};
type AccessField = keyof AccessValues;

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
  mcpRemoteEnabled: boolean;
  mcpClientPolicy: string;
  passwordAccessMode?: string;
  passwordAccessUserIds?: string[];
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
 * Same defence for the client policy (CHECK constraint in migration 0086):
 * an unknown value reads as the narrow default, never as `any`.
 */
function readMcpClientPolicy(value: string): McpClientPolicy {
  const parsed = mcpClientPolicySchema.safeParse(value);
  return parsed.success ? parsed.data : 'claude_chatgpt';
}

/**
 * Same defence for the password access mode (CHECK constraint in migration
 * 0090). An unknown value reads as `all_users`, which is the behaviour the
 * product had before the policy existed — the per-entry lists still apply.
 */
function readPasswordAccessMode(value: string | undefined): PasswordAccessMode {
  const parsed = passwordAccessModeSchema.safeParse(value);
  return parsed.success ? parsed.data : 'all_users';
}

/**
 * Read the global policy from a `system_settings` row. Exported so code
 * that runs outside a request (the PDF export worker) reads the same
 * rule from a fresh row.
 */
export function readPasswordAccessPolicy(row: {
  passwordAccessMode?: string;
  passwordAccessUserIds?: string[];
}): GlobalPasswordPolicy {
  return {
    mode: readPasswordAccessMode(row.passwordAccessMode),
    userIds: row.passwordAccessUserIds ?? [],
  };
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
    mcpRemoteEnabled: row.mcpRemoteEnabled,
    mcpClientPolicy: readMcpClientPolicy(row.mcpClientPolicy),
    passwordAccessMode: readPasswordAccessMode(row.passwordAccessMode),
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
    mcpRemoteEnabled: row.mcpRemoteEnabled,
    mcpClientPolicy: readMcpClientPolicy(row.mcpClientPolicy),
  };
}
