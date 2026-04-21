import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  MembershipRoleValues,
  updateMembershipSchema,
  type MembershipRole,
  type UpdateMembershipInput,
} from '@weavestream/shared';
import { MembershipsService } from './memberships.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { AuthedOnly } from '../rbac/require-permission.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { PermissionService } from '../rbac/permission.service.js';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Consolidated membership endpoints. The membership id alone doesn't
 * reveal the companyId until we look it up, so we use AuthedOnly() and
 * re-check permissions inside the service.
 */
@Controller({ path: 'memberships', version: '1' })
export class MembershipsController {
  constructor(
    private readonly memberships: MembershipsService,
    private readonly permissions: PermissionService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @AuthedOnly()
  async list(
    @CurrentUser() user: AuthedUser,
    @Query('q') q?: string,
    @Query('role') role?: string,
    @Query('expired') expired?: string,
    @Query('expiringWithinDays') expiringWithinDays?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    if (user.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException();
    }
    return this.memberships.listAll({
      q,
      role:
        role && (MembershipRoleValues as readonly string[]).includes(role)
          ? (role as MembershipRole)
          : undefined,
      expired: expired === 'true',
      expiringWithinDays: expiringWithinDays
        ? parseInt(expiringWithinDays, 10)
        : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      cursor,
    });
  }

  @Patch(':id')
  @AuthedOnly()
  async update(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(updateMembershipSchema)) dto: UpdateMembershipInput,
    @Req() req: Request,
  ) {
    await this.assertCanManage(user, id);
    return this.memberships.update(user, id, dto, {
      ip: ipOf(req),
      userAgent: uaOf(req),
    });
  }

  @Delete(':id')
  @AuthedOnly()
  @HttpCode(HttpStatus.OK)
  async revoke(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    await this.assertCanManage(user, id);
    return this.memberships.revoke(user, id, {
      ip: ipOf(req),
      userAgent: uaOf(req),
    });
  }

  private async assertCanManage(user: AuthedUser, membershipId: string) {
    const row = await this.prisma.membership.findUnique({
      where: { id: membershipId },
      select: { companyId: true },
    });
    if (!row) throw new NotFoundException();
    const decision = await this.permissions.can(user, 'membership.manage', {
      companyId: row.companyId,
    });
    if (!decision.allowed) {
      throw new ForbiddenException(decision.reason ?? 'Forbidden');
    }
  }
}

function ipOf(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]!.trim();
  return req.ip ?? '0.0.0.0';
}
function uaOf(req: Request): string {
  return (req.headers['user-agent'] ?? 'unknown').toString().slice(0, 500);
}
