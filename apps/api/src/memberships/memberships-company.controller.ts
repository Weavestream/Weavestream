import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  bulkCreateMembershipSchema,
  createMembershipSchema,
  type BulkCreateMembershipInput,
  type CreateMembershipInput,
} from '@weavestream/shared';
import { MembershipsService } from './memberships.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';

/**
 * Company-scoped membership endpoints. companyId is in the URL path so
 * the PermissionGuard can resolve `companyIdFrom: 'params.id'`.
 */
@Controller({ path: 'companies/:id/memberships', version: '1' })
export class MembershipsCompanyController {
  constructor(private readonly memberships: MembershipsService) {}

  @Get()
  // Reading the roster only requires FULL/READONLY effective access on
  // the company — anyone who can see the company can see who else has
  // access. Adding/removing members is gated on `membership.manage`.
  @RequirePermission('membership.read', { companyIdFrom: 'params.id' })
  async list(@Param('id', new ParseUUIDPipe()) companyId: string) {
    return this.memberships.listForCompany(companyId);
  }

  @Post()
  @RequirePermission('membership.manage', { companyIdFrom: 'params.id' })
  async create(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) companyId: string,
    @Body(new ZodBody(createMembershipSchema)) dto: CreateMembershipInput,
    @Req() req: Request,
  ) {
    return this.memberships.create(user, companyId, dto, {
      ip: ipOf(req),
      userAgent: uaOf(req),
    });
  }

  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('user.manage')
  async bulk(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) companyId: string,
    @Body(new ZodBody(bulkCreateMembershipSchema)) dto: BulkCreateMembershipInput,
    @Req() req: Request,
  ) {
    return this.memberships.bulkCreate(user, companyId, dto.memberships, {
      ip: ipOf(req),
      userAgent: uaOf(req),
    });
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
