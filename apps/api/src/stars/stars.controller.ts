import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { StarsService } from './stars.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { AuthedOnly } from '../rbac/require-permission.decorator.js';

/**
 * Phase 9b.3 — star / unstar a company for the signed-in user.
 *
 * Mounted under `/me/stars` so it reads naturally on the frontend and
 * sits alongside `/me` preferences. Uses `@AuthedOnly` because the
 * resource scope (stars for the caller) is implicit; the service
 * applies a per-company access check.
 */
@Controller({ path: 'me/stars', version: '1' })
@AuthedOnly()
export class StarsController {
  constructor(private readonly stars: StarsService) {}

  @Get()
  async list(@CurrentUser() user: AuthedUser) {
    return this.stars.list(user);
  }

  @Put(':companyId')
  @HttpCode(HttpStatus.OK)
  async star(
    @CurrentUser() user: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Req() req: Request,
  ) {
    return this.stars.star(user, companyId, {
      ip: ipOf(req),
      userAgent: uaOf(req),
    });
  }

  @Delete(':companyId')
  @HttpCode(HttpStatus.OK)
  async unstar(
    @CurrentUser() user: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Req() req: Request,
  ) {
    return this.stars.unstar(user, companyId, {
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
