import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

export interface AuditEntry {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  companyId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  before?: unknown;
  after?: unknown;
}

/**
 * Snapshot of a freshly persisted audit row. Passed to any registered
 * hook so downstream consumers (currently `AlertEmitterService` for
 * the alerts feature) can react to the event without `audit.service.ts`
 * needing to know about them — keeps the Audit module dependency-free
 * and breaks the circular import chain that would otherwise form
 * (Alerts → Audit → Alerts).
 */
export interface PersistedAuditEntry {
  id: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  companyId: string | null;
  createdAt: Date;
  before: unknown;
  after: unknown;
}

export type AuditHook = (entry: PersistedAuditEntry) => void | Promise<void>;

export interface LogChangeOptions {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  companyId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /**
   * Full `before` state — caller passes the row it loaded pre-write.
   * We diff it against `after` to produce a minimal audit payload.
   */
  before: Record<string, unknown> | null;
  /** Full `after` state — caller passes the row after the write. */
  after: Record<string, unknown> | null;
  /**
   * Optional allow-list of fields to compare. Keeps the diff stable
   * across schema changes — e.g. we don't want `updatedAt` showing up
   * in every company update because it always differs.
   */
  fields?: readonly string[];
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);
  private readonly hooks: AuditHook[] = [];

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Register a side-effect that fires after every audit row is
   * persisted. Used by `AlertEmitterService` (alerts feature) to
   * dispatch real-time RECORD_EVENT / PASSWORD_EVENT alerts. Hook
   * exceptions are swallowed and logged so a misbehaving consumer
   * cannot fail the originating user request.
   */
  registerHook(hook: AuditHook): void {
    this.hooks.push(hook);
  }

  async log(entry: AuditEntry): Promise<void> {
    // Secondary plaintext store — before/after snapshots persist here.
    // See docs/security/data-retention.md.
    const row = await this.prisma.auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        companyId: entry.companyId ?? null,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
        before: (entry.before ?? null) as never,
        after: (entry.after ?? null) as never,
      },
      select: {
        id: true,
        actorId: true,
        action: true,
        entityType: true,
        entityId: true,
        companyId: true,
        createdAt: true,
        before: true,
        after: true,
      },
    });

    if (this.hooks.length === 0) return;
    const persisted: PersistedAuditEntry = {
      id: row.id,
      actorId: row.actorId,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      companyId: row.companyId,
      createdAt: row.createdAt,
      before: row.before,
      after: row.after,
    };
    for (const hook of this.hooks) {
      try {
        const ret = hook(persisted);
        if (ret && typeof (ret as Promise<unknown>).then === 'function') {
          (ret as Promise<unknown>).catch((err) => {
            this.logger.warn(
              `audit hook rejected: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
      } catch (err) {
        this.logger.warn(
          `audit hook threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  async logWithClient(
    client: Prisma.TransactionClient,
    entry: AuditEntry,
  ): Promise<void> {
    await client.auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        companyId: entry.companyId ?? null,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
        before: (entry.before ?? null) as never,
        after: (entry.after ?? null) as never,
      },
    });
  }

  async logManyWithClient(
    client: Prisma.TransactionClient,
    entries: readonly AuditEntry[],
  ): Promise<void> {
    for (let offset = 0; offset < entries.length; offset += 500) {
      await client.auditLog.createMany({
        data: entries.slice(offset, offset + 500).map((entry) => ({
          actorId: entry.actorId ?? null,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId ?? null,
          companyId: entry.companyId ?? null,
          ip: entry.ip ?? null,
          userAgent: entry.userAgent ?? null,
          before: (entry.before ?? null) as never,
          after: (entry.after ?? null) as never,
        })),
      });
    }
  }

  async assertIntegrationActor(actorId: string, companyId: string): Promise<void> {
    const now = new Date();
    const actor = await this.prisma.user.findFirst({
      where: {
        id: actorId,
        isActive: true,
        deactivatedAt: null,
        OR: [
          { role: 'SUPER_ADMIN' },
          {
            role: 'OPERATOR',
            OR: [
              {
                memberships: {
                  some: {
                    companyId,
                    role: 'FULL',
                    revokedAt: null,
                    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                  },
                },
              },
              {
                globalAccess: 'FULL',
                memberships: {
                  none: {
                    companyId,
                    revokedAt: null,
                    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                  },
                },
              },
            ],
          },
        ],
      },
      select: { id: true },
    });
    if (!actor) {
      throw new ForbiddenException('Integration audit actor is not active or authorized.');
    }
  }

  /**
   * Phase 9a: diff-aware helper for update-style actions. Writes an
   * audit row only when `before` and `after` actually differ on at
   * least one of the tracked fields. Keeps payloads small by pruning
   * keys whose values are unchanged — the UI shows a clean field-level
   * diff rather than the full serialised row.
   *
   * Skips writing entirely for no-op updates so the timeline doesn't
   * fill up with `entity.update` rows that produced no observable
   * change (e.g. a PATCH that only set fields to their existing value).
   */
  async logChange(options: LogChangeOptions): Promise<void> {
    const keys = options.fields ?? collectKeys(options.before, options.after);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    let changed = false;
    for (const k of keys) {
      const b = options.before?.[k] ?? null;
      const a = options.after?.[k] ?? null;
      if (!equalish(b, a)) {
        before[k] = b;
        after[k] = a;
        changed = true;
      }
    }
    if (!changed) return;
    await this.log({
      actorId: options.actorId,
      action: options.action,
      entityType: options.entityType,
      entityId: options.entityId,
      companyId: options.companyId ?? null,
      ip: options.ip ?? null,
      userAgent: options.userAgent ?? null,
      before,
      after,
    });
  }
}

function collectKeys(
  a: Record<string, unknown> | null,
  b: Record<string, unknown> | null,
): string[] {
  const set = new Set<string>();
  if (a) for (const k of Object.keys(a)) set.add(k);
  if (b) for (const k of Object.keys(b)) set.add(k);
  return Array.from(set);
}

/**
 * Value comparison that treats Date instances and stringifiable objects
 * the same as their canonical representation. Good enough for audit
 * diffing — we don't need full structural equality here.
 */
function equalish(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date && typeof b === 'string')
    return a.toISOString() === b;
  if (b instanceof Date && typeof a === 'string')
    return b.toISOString() === a;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (typeof a === 'object' && typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}
