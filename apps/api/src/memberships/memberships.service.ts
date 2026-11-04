import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  readMembershipPasswordAccess,
  type CreateMembershipInput,
  type MembershipPasswordAccess,
  type UpdateMembershipInput,
  type MembershipRole,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { isUniqueConstraintError } from '../prisma/prisma-errors.js';
import { AuditLogService } from '../audit/audit.service.js';
import { MembershipCacheService } from '../cache/membership-cache.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import type { MembershipStepUpState } from './membership-step-up.js';

/**
 * Runs on the locked membership row, inside the write transaction, before
 * the write. The controller uses it for the step-up decision, so the
 * decision and the write see the same row: a concurrent change cannot
 * slip between them. Throwing rolls the transaction back (no write).
 */
export type MembershipChangeGate = (current: MembershipStepUpState) => Promise<void>;

@Injectable()
export class MembershipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly cache: MembershipCacheService,
  ) {}

  async listForCompany(companyId: string) {
    const rows = await this.prisma.membership.findMany({
      where: { companyId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        role: true,
        expiresAt: true,
        passwordAccess: true,
        createdAt: true,
        updatedAt: true,
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            isActive: true,
            mfaEnabled: true,
          },
        },
      },
    });
    return rows;
  }

  async listAll(options: {
    q?: string;
    expiringWithinDays?: number;
    expired?: boolean;
    role?: MembershipRole;
    limit?: number;
    cursor?: string;
  } = {}) {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const now = new Date();
    const where: Record<string, unknown> = { revokedAt: null };

    if (options.role) where.role = options.role;
    if (options.expired) {
      where.expiresAt = { lte: now };
    } else if (options.expiringWithinDays !== undefined) {
      const bound = new Date(now.getTime() + options.expiringWithinDays * 86_400_000);
      where.expiresAt = { gt: now, lte: bound };
    }
    if (options.q) {
      where.OR = [
        { user: { name: { contains: options.q, mode: 'insensitive' } } },
        { user: { email: { contains: options.q, mode: 'insensitive' } } },
        { company: { name: { contains: options.q, mode: 'insensitive' } } },
        { company: { slug: { contains: options.q.toLowerCase() } } },
      ];
    }

    const items = await this.prisma.membership.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        role: true,
        expiresAt: true,
        passwordAccess: true,
        createdAt: true,
        user: { select: { id: true, email: true, name: true, role: true } },
        company: { select: { id: true, name: true, slug: true } },
      },
    });
    const hasMore = items.length > limit;
    const slice = hasMore ? items.slice(0, limit) : items;
    return {
      items: slice,
      nextCursor: hasMore ? slice[slice.length - 1]!.id : null,
    };
  }

  async create(
    actor: AuthedUser,
    companyId: string,
    input: CreateMembershipInput,
    meta: { ip: string; userAgent: string },
  ) {
    const [user, company] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: input.userId } }),
      this.prisma.company.findUnique({ where: { id: companyId } }),
    ]);
    if (!user) throw new NotFoundException('User not found');
    if (!company) throw new NotFoundException('Company not found');
    if (!user.isActive) throw new BadRequestException('User is deactivated');

    // CLIENT_USER memberships are always read-only — the role only
    // grants the per-row `visibleToClients` view of company data and
    // never CRUD. Catch the misconfiguration here rather than letting
    // a stray `FULL` row drift past the schema and into production.
    if (user.role === 'CLIENT_USER' && input.role === 'FULL') {
      throw new BadRequestException(
        'CLIENT_USER memberships must be READONLY',
      );
    }

    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    // A reactivated row starts from `inherit` unless the request says
    // otherwise: an old override must never come back by itself.
    const passwordAccess: MembershipPasswordAccess = input.passwordAccess ?? 'inherit';
    assertPasswordAccessAllowed(user.role, passwordAccess);

    // If a revoked row exists for (user, company) reactivate it; the partial
    // unique index permits this because the existing row's revokedAt is not
    // null. If an active row exists already, 409.
    const existing = await this.prisma.membership.findFirst({
      where: { userId: input.userId, companyId, revokedAt: null },
    });
    if (existing) throw new ConflictException('Membership already exists');

    const revoked = await this.prisma.membership.findFirst({
      where: { userId: input.userId, companyId, revokedAt: { not: null } },
      orderBy: { createdAt: 'desc' },
    });

    const membership = revoked
      ? await this.reactivate(revoked.id, {
          role: input.role,
          expiresAt,
          passwordAccess,
          createdBy: actor.id,
        })
      : await this.prisma.membership
          .create({
            data: {
              userId: input.userId,
              companyId,
              role: input.role,
              expiresAt,
              passwordAccess,
              createdBy: actor.id,
            },
          })
          .catch((error: unknown) => {
            // A concurrent create won: the partial unique index allows 1
            // active row per (user, company).
            if (isUniqueConstraintError(error)) {
              throw new ConflictException('Membership already exists');
            }
            throw error;
          });

    await this.cache.invalidate(input.userId);
    await this.audit.log({
      actorId: actor.id,
      action: 'membership.create',
      entityType: 'Membership',
      entityId: membership.id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: revoked
        ? {
            revokedAt: revoked.revokedAt,
            role: revoked.role,
            expiresAt: revoked.expiresAt,
            passwordAccess: revoked.passwordAccess,
          }
        : null,
      after: {
        role: membership.role,
        expiresAt: membership.expiresAt,
        passwordAccess: membership.passwordAccess,
      },
    });

    return membership;
  }

  /**
   * Reactivate a revoked row, only if it is STILL revoked. Without the
   * condition, a concurrent create that reactivated the same row first
   * (for example with a `deny` override, after step-up) would be
   * overwritten by this request's values without step-up. The partial
   * unique index cannot catch this: both requests update the same row.
   * `updateMany` + the read run in 1 transaction, so the row returned is
   * the row this request wrote.
   */
  private async reactivate(
    membershipId: string,
    data: {
      role: MembershipRole;
      expiresAt: Date | null;
      passwordAccess: MembershipPasswordAccess;
      createdBy: string;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.membership.updateMany({
        where: { id: membershipId, revokedAt: { not: null } },
        data: { ...data, revokedAt: null },
      });
      if (count === 0) throw new ConflictException('Membership already exists');
      return tx.membership.findUniqueOrThrow({ where: { id: membershipId } });
    });
  }

  async bulkCreate(
    actor: AuthedUser,
    companyId: string,
    memberships: CreateMembershipInput[],
    meta: { ip: string; userAgent: string },
  ) {
    const results: Array<Awaited<ReturnType<MembershipsService['create']>>> = [];
    for (const m of memberships) {
      results.push(await this.create(actor, companyId, m, meta));
    }
    return { created: results.length };
  }

  async update(
    actor: AuthedUser,
    membershipId: string,
    input: UpdateMembershipInput,
    meta: { ip: string; userAgent: string },
    gate: MembershipChangeGate,
  ) {
    // Scope check: SUPER_ADMIN bypasses, otherwise the actor must hold
    // the MEMBERSHIP_MANAGE platform capability. The PermissionGuard
    // already verified this on the controller path, but we re-check
    // here because the direct `/memberships/:id` route resolves
    // companyId from the row, not the URL, and we want a single
    // source of truth.
    if (actor.role !== 'SUPER_ADMIN') {
      if (!actor.platformCapabilities.includes('MEMBERSHIP_MANAGE')) {
        throw new ForbiddenException('Missing MEMBERSHIP_MANAGE capability');
      }
    }

    const expiresAt = input.expiresAt === undefined
      ? undefined
      : input.expiresAt === null
        ? null
        : new Date(input.expiresAt);

    // Lock, read, gate, and write in 1 transaction, so the step-up
    // decision (`gate`) sees the row that the write changes.
    const { before, updated } = await this.prisma.$transaction(async (tx) => {
      await lockMembership(tx, membershipId);
      const before = await tx.membership.findUnique({
        where: { id: membershipId },
        include: { user: { select: { role: true } } },
      });
      if (!before) throw new NotFoundException();
      if (before.revokedAt) throw new BadRequestException('Membership is revoked');

      if (
        input.role === 'FULL' &&
        before.user.role === 'CLIENT_USER'
      ) {
        throw new BadRequestException('CLIENT_USER memberships must be READONLY');
      }
      if (input.passwordAccess !== undefined) {
        assertPasswordAccessAllowed(before.user.role, input.passwordAccess);
      }

      await gate(stepUpStateOf(before));

      const updated = await tx.membership.update({
        where: { id: membershipId },
        data: {
          ...(input.role !== undefined ? { role: input.role } : {}),
          ...(expiresAt !== undefined ? { expiresAt } : {}),
          ...(input.passwordAccess !== undefined
            ? { passwordAccess: input.passwordAccess }
            : {}),
        },
      });
      return { before, updated };
    });

    await this.cache.invalidate(before.userId);
    await this.audit.log({
      actorId: actor.id,
      action: 'membership.update',
      entityType: 'Membership',
      entityId: membershipId,
      companyId: before.companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: {
        role: before.role,
        expiresAt: before.expiresAt,
        passwordAccess: before.passwordAccess,
      },
      after: {
        role: updated.role,
        expiresAt: updated.expiresAt,
        passwordAccess: updated.passwordAccess,
      },
    });

    return updated;
  }

  async revoke(
    actor: AuthedUser,
    membershipId: string,
    meta: { ip: string; userAgent: string },
    gate: MembershipChangeGate,
  ) {
    if (actor.role !== 'SUPER_ADMIN') {
      if (!actor.platformCapabilities.includes('MEMBERSHIP_MANAGE')) {
        throw new ForbiddenException('Missing MEMBERSHIP_MANAGE capability');
      }
    }

    // Same lock-read-gate-write order as `update`: revoking a membership
    // that became `deny` after the caller looked must still ask for step-up.
    const { before, updated } = await this.prisma.$transaction(async (tx) => {
      await lockMembership(tx, membershipId);
      const before = await tx.membership.findUnique({
        where: { id: membershipId },
      });
      if (!before) throw new NotFoundException();
      if (before.revokedAt) throw new BadRequestException('Already revoked');

      await gate(stepUpStateOf(before));

      const updated = await tx.membership.update({
        where: { id: membershipId },
        data: { revokedAt: new Date() },
      });
      return { before, updated };
    });

    await this.cache.invalidate(before.userId);
    await this.audit.log({
      actorId: actor.id,
      action: 'membership.revoke',
      entityType: 'Membership',
      entityId: membershipId,
      companyId: before.companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      // `passwordAccess` is recorded because revoking an override changes
      // the member's password access (it falls back to the global policy).
      before: { revokedAt: null, passwordAccess: before.passwordAccess },
      after: { revokedAt: updated.revokedAt },
    });

    return updated;
  }
}

/**
 * Client users are governed only by `visibleToClients`, so a company
 * password override has no meaning for them. Refuse it rather than store
 * a value that would look effective in the UI.
 */
function assertPasswordAccessAllowed(
  userRole: string,
  passwordAccess: MembershipPasswordAccess,
): void {
  if (userRole === 'CLIENT_USER' && passwordAccess !== 'inherit') {
    throw new BadRequestException(
      'Password access overrides do not apply to client users',
    );
  }
}

/**
 * Row lock for the rest of the transaction. A concurrent update or revoke
 * of the same membership waits here, then reads the committed row.
 */
async function lockMembership(tx: Prisma.TransactionClient, membershipId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT 1 FROM "memberships"
    WHERE "id" = ${membershipId}::uuid
    FOR UPDATE
  `;
}

function stepUpStateOf(row: { passwordAccess: string; expiresAt: Date | null }): MembershipStepUpState {
  return {
    passwordAccess: readMembershipPasswordAccess(row.passwordAccess),
    expiresAt: row.expiresAt,
  };
}
