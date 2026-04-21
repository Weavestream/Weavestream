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
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  createUserSchema,
  updateUserSchema,
  UserRoleValues,
  type CreateUserInput,
  type UpdateUserInput,
  type UserRole,
} from '@weavestream/shared';
import { UsersService } from './users.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';

@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission('user.manage')
  async list(
    @Query('q') q?: string,
    @Query('role') role?: string,
    @Query('isActive') isActive?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.users.list({
      q,
      role: role && (UserRoleValues as readonly string[]).includes(role)
        ? (role as UserRole)
        : undefined,
      isActive: isActive === undefined ? undefined : isActive === 'true',
      limit: limit ? parseInt(limit, 10) : undefined,
      cursor,
    });
  }

  @Get(':id')
  @RequirePermission('user.manage')
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.users.get(id);
  }

  @Post()
  @RequirePermission('user.manage')
  async create(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(createUserSchema)) dto: CreateUserInput,
    @Req() req: Request,
  ) {
    return this.users.create(user, dto, {
      ip: ipOf(req),
      userAgent: uaOf(req),
    });
  }

  @Patch(':id')
  @RequirePermission('user.manage')
  async update(
    @CurrentUser() actor: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(updateUserSchema)) dto: UpdateUserInput,
    @Req() req: Request,
  ) {
    return this.users.update(actor, id, dto, { ip: ipOf(req), userAgent: uaOf(req) });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('user.manage')
  async deactivate(
    @CurrentUser() actor: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.users.deactivate(actor, id, { ip: ipOf(req), userAgent: uaOf(req) });
  }

  @Post(':id/invite')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('user.manage')
  async reissueInvite(
    @CurrentUser() actor: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.users.reissueInvite(actor, id, { ip: ipOf(req), userAgent: uaOf(req) });
  }

  @Post(':id/reset-mfa')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('user.manage')
  async resetMfa(
    @CurrentUser() actor: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.users.resetMfa(actor, id, { ip: ipOf(req), userAgent: uaOf(req) });
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
