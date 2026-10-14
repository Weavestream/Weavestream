import { Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { McpConnectionSummary } from '@weavestream/shared';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { AuthedOnly } from '../rbac/require-permission.decorator.js';
import { InteractiveOnly } from '../auth/interactive-only.decorator.js';
import { requestMetaOf } from '../common/request-meta.js';
import { McpConnectionsService } from './mcp-connections.service.js';

/**
 * A user's own remote AI connections. Scoped to the acting user in the
 * query; no user id is ever taken from the client, and another user's
 * connection id is a 404 (CLAUDE.md §1). Interactive only: neither a key nor
 * a connection may list or revoke connections.
 */
@Controller({ path: 'me/mcp-connections', version: '1' })
export class MeMcpConnectionsController {
  constructor(private readonly connections: McpConnectionsService) {}

  @Get()
  @AuthedOnly()
  @InteractiveOnly()
  list(@CurrentUser() actor: AuthedUser): Promise<McpConnectionSummary[]> {
    return this.connections.listForUser(actor.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AuthedOnly()
  @InteractiveOnly()
  async revoke(
    @CurrentUser() actor: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.connections.revokeOwn(actor, id, requestMetaOf(req));
  }
}
