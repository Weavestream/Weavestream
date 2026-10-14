import { Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AdminMcpConnectionPage } from '@weavestream/shared';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { InteractiveOnly } from '../auth/interactive-only.decorator.js';
import { RequireStepUp } from '../auth/step-up/require-step-up.decorator.js';
import { requestMetaOf } from '../common/request-meta.js';
import { McpConnectionsService } from './mcp-connections.service.js';

/**
 * Every user's remote AI connections, for the Security center. Same bar as
 * the admin API key list: reading needs `security.read`, revoking needs
 * `user.manage` plus a step-up, and neither is reachable with a key or a
 * connection.
 */
@Controller({ path: 'security/mcp-connections', version: '1' })
export class AdminMcpConnectionsController {
  constructor(private readonly connections: McpConnectionsService) {}

  @Get()
  @RequirePermission('security.read')
  @InteractiveOnly()
  list(@Query('page') page?: string, @Query('pageSize') pageSize?: string): Promise<AdminMcpConnectionPage> {
    const parsedPage = page ? parseInt(page, 10) : undefined;
    const parsedSize = pageSize ? parseInt(pageSize, 10) : undefined;
    return this.connections.listAll({
      page: Number.isFinite(parsedPage) ? parsedPage : undefined,
      pageSize: Number.isFinite(parsedSize) ? parsedSize : undefined,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('user.manage')
  @RequireStepUp()
  @InteractiveOnly()
  revoke(
    @CurrentUser() actor: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<{ revoked: 1 }> {
    return this.connections.revokeAny(actor, id, requestMetaOf(req));
  }
}
