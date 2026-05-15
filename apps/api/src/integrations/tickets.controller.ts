import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ticketListFilterSchema,
  type TicketListFilter,
} from '@weavestream/shared';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { requestMetaOf as meta } from '../common/request-meta.js';
import { TicketsService } from './tickets.service.js';

/**
 * Phase 12 — company-scoped, read-only ticket browse surface backed by
 * the company's mapped ticketing integration (NinjaOne today).
 *
 * Mounted under `/v1/companies/:companyId/tickets` so the
 * PermissionGuard resolves the tenant from `params.companyId`. Both
 * endpoints are gated by `article.write` because the only reason the
 * Tickets page exists is to draft an article from a ticket — the same
 * role set that drafts articles is the audience for this surface, and
 * `article.write` is FULL-company-access-only (operators and
 * SUPER_ADMIN), which gives us the admin-only audience the plan
 * specifies while explicitly blocking CONTRACTOR / CLIENT_USER.
 *
 * Tickets are NEVER persisted; every request hits the upstream system
 * via the driver. The `TicketsService` writes a per-call audit row
 * (action `tickets.list` / `tickets.view`) so we have a record of
 * which operator looked at which ticket id — bodies / subjects are
 * never audit-logged.
 */
@Controller({ path: 'companies/:companyId/tickets', version: '1' })
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  /**
   * Sidebar-data probe: does this company have a ticketing-capable
   * integration mapped (and ACTIVE)? Used by the company-scoped layout
   * to gate the "Tickets" sidebar item without leaking the underlying
   * mapping/driver identity. The same `article.write` gate keeps
   * portal users out so the existence of a ticketing integration is
   * never disclosed to a contractor/client.
   *
   * Declared BEFORE `:ticketId` so the literal `_capability` segment
   * doesn't get swallowed by the ticket detail route.
   */
  @Get('_capability')
  @RequirePermission('article.write', { companyIdFrom: 'params.companyId' })
  async capability(
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
  ): Promise<{ enabled: boolean }> {
    return { enabled: await this.tickets.companyHasTicketing(companyId) };
  }

  @Get()
  @RequirePermission('article.write', { companyIdFrom: 'params.companyId' })
  async list(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Query() query: Record<string, string | undefined>,
    @Req() req: Request,
  ) {
    // Zod-parse only the filter keys; everything else (cursor) is
    // intentionally pass-through opaque.
    const filter: TicketListFilter = ticketListFilterSchema.parse({
      status: query['status'] || undefined,
      priority: query['priority'] || undefined,
      boardId: query['boardId'] || undefined,
      assigneeId: query['assigneeId'] || undefined,
      search: query['search'] || undefined,
    });
    const cursor = query['cursor'] ? String(query['cursor']) : null;
    return this.tickets.listTickets(actor, companyId, filter, cursor, meta(req));
  }

  @Get(':ticketId')
  @RequirePermission('article.write', { companyIdFrom: 'params.companyId' })
  async get(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('ticketId') ticketId: string,
    @Req() req: Request,
  ) {
    return this.tickets.getTicket(actor, companyId, ticketId, meta(req));
  }
}
