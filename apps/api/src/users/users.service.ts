import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateUserInput,
  UpdateUserInput,
  UserRole,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { MembershipCacheService } from '../cache/membership-cache.service.js';
import { SetupTokenService } from './setup-token.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

export interface UserListOptions {
  q?: string;
  role?: UserRole;
  isActive?: boolean;
  limit?: number;
  cursor?: string;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly cache: MembershipCacheService,
    private readonly setupTokens: SetupTokenService,
  ) {}

  async list(options: UserListOptions = {}) {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const where: Record<string, unknown> = {};
    if (options.q) {
      where.OR = [
        { name: { contains: options.q, mode: 'insensitive' } },
        { email: { contains: options.q, mode: 'insensitive' } },
      ];
    }
    if (options.role) where.role = options.role;
    if (options.isActive !== undefined) where.isActive = options.isActive;

    const items = await this.prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        globalAccess: true,
        platformCapabilities: true,
        isActive: true,
        mfaEnabled: true,
        deactivatedAt: true,
        timezone: true,
        createdAt: true,
        lastLoginAt: true,
      },
    });
    const hasMore = items.length > limit;
    const slice = hasMore ? items.slice(0, limit) : items;
    return {
      items: slice,
      nextCursor: hasMore ? slice[slice.length - 1]!.id : null,
    };
  }

  async get(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        globalAccess: true,
        platformCapabilities: true,
        isActive: true,
        mfaEnabled: true,
        mfaEnforcementCompletedAt: true,
        deactivatedAt: true,
        timezone: true,
        createdAt: true,
        updatedAt: true,
        lastLoginAt: true,
        memberships: {
          where: { revokedAt: null },
          select: {
            id: true,
            role: true,
            expiresAt: true,
            createdAt: true,
            revokedAt: true,
            // `archivedAt` feeds the "archived" status chip on the
            // user's memberships table — without it the UI column
            // was always showing "active" regardless of the truth.
            company: {
              select: { id: true, name: true, slug: true, archivedAt: true },
            },
          },
        },
      },
    });
    if (!user) throw new NotFoundException();
    return user;
  }

  async create(
    actor: AuthedUser,
    input: CreateUserInput,
    meta: { ip: string; userAgent: string },
  ) {
    const existing = await this.prisma.user.findUnique({
      where: { email: input.email.toLowerCase() },
    });
    if (existing) throw new ConflictException('A user with that email already exists');

    // Hard guard: only SUPER_ADMIN can mint another SUPER_ADMIN.
    // Holding `USER_MANAGE` is intentionally insufficient — a senior
    // operator can manage every other role but cannot promote to SA.
    if (input.role === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Only SUPER_ADMIN can create SUPER_ADMIN users');
    }

    // Operator-axes consistency. The Zod schema already rejects
    // mismatched combos; we double-check here so any bypass
    // (e.g. an internal callsite that hand-crafts an input) still
    // hits the correct invariant.
    if (input.role === 'OPERATOR') {
      if (!input.globalAccess) {
        throw new BadRequestException('OPERATOR users must declare a globalAccess');
      }
    } else if (input.globalAccess !== undefined || (input.platformCapabilities?.length ?? 0) > 0) {
      throw new BadRequestException(
        'globalAccess and platformCapabilities are only valid for OPERATOR users',
      );
    }

    if (input.membership) {
      const company = await this.prisma.company.findUnique({
        where: { id: input.membership.companyId },
        select: { id: true, archivedAt: true },
      });
      if (!company) throw new NotFoundException('Company not found');
      if (company.archivedAt) {
        throw new BadRequestException('Cannot attach users to an archived company');
      }
      if (input.role === 'CLIENT_USER' && input.membership.role === 'FULL') {
        throw new BadRequestException(
          'CLIENT_USER memberships must be READONLY',
        );
      }
    }

    const { user, membership } = await this.prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          email: input.email.toLowerCase(),
          name: input.name,
          role: input.role,
          globalAccess: input.role === 'OPERATOR' ? input.globalAccess! : null,
          platformCapabilities:
            input.role === 'OPERATOR' ? (input.platformCapabilities ?? []) : [],
          // No password — invite flow creates it.
          passwordHash: null,
          mfaEnabled: false,
          mfaEnforcementCompletedAt: null,
        },
      });

      let createdMembership: { id: string; role: string; expiresAt: Date | null } | null =
        null;
      if (input.membership) {
        const expiresAt = input.membership.expiresAt
          ? new Date(input.membership.expiresAt)
          : null;
        createdMembership = await tx.membership.create({
          data: {
            userId: createdUser.id,
            companyId: input.membership.companyId,
            role: input.membership.role,
            expiresAt,
            createdBy: actor.id,
          },
          select: { id: true, role: true, expiresAt: true },
        });
      }

      return { user: createdUser, membership: createdMembership };
    });

    // Invite token + audit entries happen after the transaction — they
    // don't need to share the tx (setup tokens run their own small tx
    // and audit is fire-and-forget). The user and membership rows are
    // already durable.
    const invite = await this.setupTokens.issue(user.id, actor.id);

    await this.audit.log({
      actorId: actor.id,
      action: 'user.create',
      entityType: 'User',
      entityId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: {
        email: user.email,
        name: user.name,
        role: user.role,
        globalAccess: user.globalAccess,
        platformCapabilities: user.platformCapabilities,
      },
    });
    await this.audit.log({
      actorId: actor.id,
      action: 'user.invite.created',
      entityType: 'User',
      entityId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { expiresAt: invite.expiresAt.toISOString() },
    });

    if (membership && input.membership) {
      await this.cache.invalidate(user.id);
      await this.audit.log({
        actorId: actor.id,
        action: 'membership.create',
        entityType: 'Membership',
        entityId: membership.id,
        companyId: input.membership.companyId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: { role: membership.role, expiresAt: membership.expiresAt },
      });
    }

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        globalAccess: user.globalAccess,
        platformCapabilities: user.platformCapabilities,
      },
      setupUrl: invite.url,
      expiresAt: invite.expiresAt,
      membership: membership
        ? {
            id: membership.id,
            role: membership.role,
            expiresAt: membership.expiresAt,
            companyId: input.membership!.companyId,
          }
        : null,
    };
  }

  async update(
    actor: AuthedUser,
    id: string,
    input: UpdateUserInput,
    meta: { ip: string; userAgent: string },
  ) {
    const before = await this.prisma.user.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();

    if (input.isActive === false && before.id === actor.id) {
      throw new BadRequestException('Cannot deactivate yourself');
    }

    const isRoleChange = input.role !== undefined && input.role !== before.role;

    // SUPER_ADMIN promotion/demotion is a strict SUPER_ADMIN-only
    // operation regardless of `USER_MANAGE`. Promotion: role becomes
    // SUPER_ADMIN. Demotion: was SUPER_ADMIN, role is changing.
    if (
      isRoleChange &&
      actor.role !== 'SUPER_ADMIN' &&
      (input.role === 'SUPER_ADMIN' || before.role === 'SUPER_ADMIN')
    ) {
      throw new ForbiddenException(
        'Only SUPER_ADMIN can promote to or demote from SUPER_ADMIN',
      );
    }

    // Resolve the effective post-update role so we can validate the
    // OPERATOR axes against the right baseline.
    const nextRole = input.role ?? before.role;
    const operatorAxesTouched =
      input.globalAccess !== undefined ||
      input.platformCapabilities !== undefined;

    if (nextRole === 'OPERATOR') {
      // Non-OPERATOR -> OPERATOR transition needs an explicit
      // globalAccess; otherwise we fall back to the existing value.
      if (input.role === 'OPERATOR' && before.role !== 'OPERATOR') {
        if (!input.globalAccess) {
          throw new BadRequestException(
            'globalAccess is required when promoting a user to OPERATOR',
          );
        }
      }
    } else if (operatorAxesTouched) {
      throw new BadRequestException(
        'globalAccess and platformCapabilities are only valid for OPERATOR users',
      );
    }

    const isDeactivation =
      input.isActive === false && before.isActive === true;
    const isActivation = input.isActive === true && before.isActive === false;

    // When demoting away from OPERATOR, clear the OPERATOR axes so a
    // re-promoted user doesn't inherit a stale globalAccess/capabilities
    // set from a prior life.
    const clearOperatorAxes =
      isRoleChange && before.role === 'OPERATOR' && nextRole !== 'OPERATOR';

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.isActive !== undefined
          ? {
              isActive: input.isActive,
              deactivatedAt: input.isActive ? null : new Date(),
            }
          : {}),
        ...(clearOperatorAxes
          ? { globalAccess: null, platformCapabilities: [] }
          : {
              ...(input.globalAccess !== undefined
                ? { globalAccess: input.globalAccess }
                : {}),
              ...(input.platformCapabilities !== undefined
                ? { platformCapabilities: input.platformCapabilities }
                : {}),
            }),
      },
    });

    if (isDeactivation) {
      // Revoke all sessions so a deactivated user is signed out everywhere.
      await this.prisma.session.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.cache.invalidate(id);
    }
    if (isActivation) {
      await this.cache.invalidate(id);
    }
    if (isRoleChange) {
      await this.cache.invalidate(id);
      await this.audit.log({
        actorId: actor.id,
        action: 'user.role.change',
        entityType: 'User',
        entityId: id,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: { role: before.role },
        after: { role: updated.role },
      });
    }
    if (isDeactivation) {
      await this.audit.log({
        actorId: actor.id,
        action: 'user.deactivate',
        entityType: 'User',
        entityId: id,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: { isActive: before.isActive },
        after: { isActive: false, deactivatedAt: updated.deactivatedAt },
      });
    }

    await this.audit.log({
      actorId: actor.id,
      action: 'user.update',
      entityType: 'User',
      entityId: id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: {
        name: before.name,
        role: before.role,
        isActive: before.isActive,
        timezone: before.timezone,
        globalAccess: before.globalAccess,
        platformCapabilities: before.platformCapabilities,
      },
      after: {
        name: updated.name,
        role: updated.role,
        isActive: updated.isActive,
        timezone: updated.timezone,
        globalAccess: updated.globalAccess,
        platformCapabilities: updated.platformCapabilities,
      },
    });

    return updated;
  }

  async deactivate(
    actor: AuthedUser,
    id: string,
    meta: { ip: string; userAgent: string },
  ) {
    if (id === actor.id) {
      throw new BadRequestException('Cannot deactivate yourself');
    }
    return this.update(actor, id, { isActive: false }, meta);
  }

  async reissueInvite(
    actor: AuthedUser,
    id: string,
    meta: { ip: string; userAgent: string },
  ) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException();
    if (!user.isActive) throw new ForbiddenException('User is deactivated');

    const invite = await this.setupTokens.issue(id, actor.id);

    await this.audit.log({
      actorId: actor.id,
      action: 'user.invite.created',
      entityType: 'User',
      entityId: id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { expiresAt: invite.expiresAt.toISOString() },
    });

    return { setupUrl: invite.url, expiresAt: invite.expiresAt };
  }

  async resetMfa(
    actor: AuthedUser,
    id: string,
    meta: { ip: string; userAgent: string },
  ) {
    const before = await this.prisma.user.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();

    // The actor's recent-sign-in gate that used to live here was replaced
    // by the unified step-up mechanism: this route now carries
    // `@RequireStepUp()` (see users.controller.ts), which re-confirms a
    // fresh credential bound to the session — strictly stronger than
    // trusting a 5-minute-old `lastLoginAt`.

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: {
          mfaSecretEncrypted: null,
          mfaEnabled: false,
          mfaEnforcementCompletedAt: null,
        },
      });
      await tx.userMfaBackupCode.deleteMany({ where: { userId: id } });
      // Revoke every session so the user is forced back through login + MFA setup.
      await tx.session.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    await this.audit.log({
      actorId: actor.id,
      action: 'user.mfa.reset',
      entityType: 'User',
      entityId: id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: {
        mfaEnabled: before.mfaEnabled,
        mfaEnforcementCompletedAt: before.mfaEnforcementCompletedAt,
      },
      after: { mfaEnabled: false, mfaEnforcementCompletedAt: null },
    });

    return { ok: true };
  }
}
