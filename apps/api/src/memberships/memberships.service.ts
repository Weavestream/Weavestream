import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateMembershipInput,
  UpdateMembershipInput,
  MembershipRole,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { MembershipCacheService } from '../cache/membership-cache.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

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
      ? await this.prisma.membership.update({
          where: { id: revoked.id },
          data: {
            role: input.role,
            expiresAt,
            revokedAt: null,
            createdBy: actor.id,
          },
        })
      : await this.prisma.membership.create({
          data: {
            userId: input.userId,
            companyId,
            role: input.role,
            expiresAt,
            createdBy: actor.id,
          },
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
        ? { revokedAt: revoked.revokedAt, role: revoked.role, expiresAt: revoked.expiresAt }
        : null,
      after: { role: membership.role, expiresAt: membership.expiresAt },
    });

    return membership;
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
  ) {
    const before = await this.prisma.membership.findUnique({
      where: { id: membershipId },
      include: { user: { select: { role: true } } },
    });
    if (!before) throw new NotFoundException();
    if (before.revokedAt) throw new BadRequestException('Membership is revoked');

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

    if (
      input.role === 'FULL' &&
      before.user.role === 'CLIENT_USER'
    ) {
      throw new BadRequestException('CLIENT_USER memberships must be READONLY');
    }

    const expiresAt = input.expiresAt === undefined
      ? undefined
      : input.expiresAt === null
        ? null
        : new Date(input.expiresAt);

    const updated = await this.prisma.membership.update({
      where: { id: membershipId },
      data: {
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      },
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
      before: { role: before.role, expiresAt: before.expiresAt },
      after: { role: updated.role, expiresAt: updated.expiresAt },
    });

    return updated;
  }

  async revoke(
    actor: AuthedUser,
    membershipId: string,
    meta: { ip: string; userAgent: string },
  ) {
    const before = await this.prisma.membership.findUnique({
      where: { id: membershipId },
    });
    if (!before) throw new NotFoundException();
    if (before.revokedAt) throw new BadRequestException('Already revoked');

    if (actor.role !== 'SUPER_ADMIN') {
      if (!actor.platformCapabilities.includes('MEMBERSHIP_MANAGE')) {
        throw new ForbiddenException('Missing MEMBERSHIP_MANAGE capability');
      }
    }

    const updated = await this.prisma.membership.update({
      where: { id: membershipId },
      data: { revokedAt: new Date() },
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
      before: { revokedAt: null },
      after: { revokedAt: updated.revokedAt },
    });

    return updated;
  }
}
