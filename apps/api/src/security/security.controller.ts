import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { ipOf, userAgentOf as uaOf } from '../common/request-meta.js';
import { SecurityService } from './security.service.js';

/**
 * Admin Security Center read endpoints.
 *
 * Every read here is gated by the `security.read` action, which maps
 * to the `SECURITY_READ` platform capability — SUPER_ADMIN holds it
 * implicitly, OPERATORs only when delegated. Session revocation lives
 * on the same surface for UX reasons but escalates to the
 * `user.manage` capability so we don't accidentally let a viewer
 * boot people off the platform.
 */
@Controller({ path: 'security', version: '1' })
export class SecurityController {
  constructor(private readonly security: SecurityService) {}

  @Get('login-activity')
  @RequirePermission('security.read')
  async loginActivity(@Query('windowHours') windowHours?: string) {
    const parsed = windowHours ? parseInt(windowHours, 10) : 24;
    return this.security.loginActivity(Number.isFinite(parsed) ? parsed : 24);
  }

  @Get('lockouts')
  @RequirePermission('security.read')
  async lockouts() {
    return this.security.activeLockouts();
  }

  @Get('throttle-blocks')
  @RequirePermission('security.read')
  async throttleBlocks() {
    return this.security.activeThrottleBlocks();
  }

  @Get('sessions')
  @RequirePermission('security.read')
  async sessions(
    @Query('userId') userId?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit ? parseInt(limit, 10) : undefined;
    return {
      items: await this.security.listActiveSessions({
        userId,
        limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      }),
    };
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('user.manage')
  async revokeSession(
    @CurrentUser() actor: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.security.revokeSession(actor, id, {
      ip: ipOf(req),
      userAgent: uaOf(req),
    });
  }
}
