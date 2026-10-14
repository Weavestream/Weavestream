import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  ADMIN_MCP_CONNECTION_DEFAULT_PAGE_SIZE,
  type AdminMcpConnectionPage,
  type McpConnectionSummary,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { lockUserForDelegatedMint } from '../auth/revoke-api-keys.js';

type Meta = { ip: string; userAgent: string };

/** Why a connection ended; recorded in the revoke audit row. */
export type McpRevokeReason = 'user' | 'admin' | 'token_reuse' | 'client_revoked' | 'grant_revoked';

const SUMMARY_SELECT = {
  id: true,
  clientId: true,
  clientName: true,
  redirectHost: true,
  allowWrite: true,
  lastUsedAt: true,
  expiresAt: true,
  createdAt: true,
} as const;

type SummaryRow = Prisma.McpConnectionGetPayload<{ select: typeof SUMMARY_SELECT }>;

function toSummary(row: SummaryRow): McpConnectionSummary {
  return {
    id: row.id,
    clientId: row.clientId,
    clientHost: hostOf(row.clientId),
    clientName: row.clientName,
    redirectHost: row.redirectHost,
    allowWrite: row.allowWrite,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** `lastUsedAt` is advisory: written at most this often per connection. */
const TOUCH_INTERVAL_MS = 5 * 60_000;

/**
 * Remote MCP connections: the server-side record of an OAuth grant a user
 * approved. `revokedAt` is the authority — every `/mcp` request, internal
 * tool call and token exchange checks it — so revoking here ends the
 * connection at once. The OAuth artifacts are deleted with it so nothing
 * usable-looking is left behind.
 *
 * Every read and write by a user is scoped to that user in the query
 * (CLAUDE.md §1). Admin paths are separate methods behind their own
 * permission.
 */
@Injectable()
export class McpConnectionsService {
  private readonly log = new Logger(McpConnectionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /** Record an approved connection and its audit row in one transaction. */
  async create(
    actor: AuthedUser,
    input: {
      clientId: string;
      clientName: string;
      redirectHost: string;
      grantId: string;
      allowWrite: boolean;
      expiresAt: Date;
    },
    meta: Meta,
  ): Promise<McpConnectionSummary> {
    return this.prisma.$transaction(async (tx) => {
      // Serialize with a concurrent role/access edit on this user, so the
      // edit's revocation either sees this connection or runs before it exists.
      await lockUserForDelegatedMint(tx, actor.id);
      const row = await tx.mcpConnection.create({
        data: { userId: actor.id, ...input },
        select: SUMMARY_SELECT,
      });
      await this.audit.logWithClient(tx, {
        actorId: actor.id,
        action: AUDIT_ACTIONS.auth.mcpConnectionCreate,
        entityType: 'McpConnection',
        entityId: row.id,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: {
          clientId: input.clientId,
          clientHost: hostOf(input.clientId),
          redirectHost: input.redirectHost,
          allowWrite: input.allowWrite,
          sessionId: actor.sessionId,
        },
      });
      return toSummary(row);
    });
  }

  /** The live connection behind a grant, with its owner, or null. */
  async findActiveByGrant(grantId: string) {
    const row = await this.prisma.mcpConnection.findUnique({
      where: { grantId },
      select: { id: true, userId: true, allowWrite: true, revokedAt: true, expiresAt: true, lastUsedAt: true },
    });
    if (!row || row.revokedAt || row.expiresAt.getTime() <= Date.now()) return null;
    return row;
  }

  /** A live connection by id, or null. */
  async findActiveById(id: string) {
    const row = await this.prisma.mcpConnection.findUnique({
      where: { id },
      select: { id: true, userId: true, allowWrite: true, revokedAt: true, expiresAt: true },
    });
    if (!row || row.revokedAt || row.expiresAt.getTime() <= Date.now()) return null;
    return row;
  }

  /** Bookkeeping only; never fails the caller. */
  touch(connection: { id: string; lastUsedAt: Date | null }): void {
    if (connection.lastUsedAt && Date.now() - connection.lastUsedAt.getTime() < TOUCH_INTERVAL_MS) return;
    void this.prisma.mcpConnection
      .update({ where: { id: connection.id }, data: { lastUsedAt: new Date() } })
      .catch((err: unknown) => {
        // lastUsedAt is advisory; losing one update is not worth a 500.
        this.log.debug(`lastUsedAt update skipped: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  async listForUser(userId: string): Promise<McpConnectionSummary[]> {
    const rows = await this.prisma.mcpConnection.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: SUMMARY_SELECT,
    });
    return rows.map(toSummary);
  }

  /** Revoke one of the actor's own connections. Another user's id is a 404. */
  async revokeOwn(actor: AuthedUser, id: string, meta: Meta): Promise<void> {
    await this.revoke({ id, userId: actor.id }, 'user', actor, meta);
  }

  /** Every live connection on the instance, newest first, one page at a time. */
  async listAll(params: { page?: number; pageSize?: number }): Promise<AdminMcpConnectionPage> {
    const pageSize = Math.min(Math.max(params.pageSize ?? ADMIN_MCP_CONNECTION_DEFAULT_PAGE_SIZE, 1), 100);
    const where = { revokedAt: null };
    const total = await this.prisma.mcpConnection.count({ where });
    const totalPages = Math.max(Math.ceil(total / pageSize), 1);
    const page = Math.min(Math.max(params.page ?? 1, 1), totalPages);
    const rows = await this.prisma.mcpConnection.findMany({
      where,
      // `id` breaks ties so a page boundary never repeats or skips a row.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { ...SUMMARY_SELECT, user: { select: { id: true, name: true, email: true } } },
    });
    return { items: rows.map((r) => ({ ...toSummary(r), user: r.user })), total, page, pageSize };
  }

  /** Revoke any user's connection (admin; the controller enforces the permission). */
  async revokeAny(actor: AuthedUser, id: string, meta: Meta): Promise<{ revoked: 1 }> {
    await this.revoke({ id }, 'admin', actor, meta);
    return { revoked: 1 };
  }

  /**
   * The authorization server ended a grant: a replayed code or refresh token,
   * or the client revoked its token. Idempotent — the library may report one
   * grant more than once.
   */
  async revokeByGrant(grantId: string, reason: McpRevokeReason): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.mcpConnection.findFirst({
        where: { grantId, revokedAt: null },
        select: { id: true, userId: true },
      });
      if (!row) return;
      const { count } = await tx.mcpConnection.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (count === 0) return;
      await tx.oAuthArtifact.deleteMany({ where: { grantId } });
      await this.audit.logWithClient(tx, {
        actorId: null,
        action: AUDIT_ACTIONS.auth.mcpConnectionRevoke,
        entityType: 'McpConnection',
        entityId: row.id,
        ip: null,
        userAgent: 'system/oauth',
        before: null,
        after: { targetUserId: row.userId, reason },
      });
    });
  }

  /**
   * Conditional on `revokedAt: null`, so two racing revokes produce one
   * revocation and one audit row; the loser gets the 404. Revocation, artifact
   * deletion and the audit row commit together.
   */
  private async revoke(
    where: { id: string; userId?: string },
    reason: 'user' | 'admin',
    actor: AuthedUser,
    meta: Meta,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.mcpConnection.findFirst({
        where: { ...where, revokedAt: null },
        select: { id: true, userId: true, grantId: true, clientId: true },
      });
      if (!row) throw new NotFoundException('Connection not found');
      const { count } = await tx.mcpConnection.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (count === 0) throw new NotFoundException('Connection not found');
      await tx.oAuthArtifact.deleteMany({ where: { grantId: row.grantId } });
      await this.audit.logWithClient(tx, {
        actorId: actor.id,
        action: AUDIT_ACTIONS.auth.mcpConnectionRevoke,
        entityType: 'McpConnection',
        entityId: row.id,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: {
          targetUserId: row.userId,
          clientHost: hostOf(row.clientId),
          reason,
          sessionId: actor.sessionId,
        },
      });
    });
  }
}
