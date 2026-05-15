import { Controller, Get, Param, Query, Req } from '@nestjs/common';
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
 * Phase 12+ — GLOBAL admin ticket browse surface.
 *
 * Aggregates every ticket the system's ticketing integration can see
 * (currently single-provider; multi-provider UX deferred), with each
 * row stitched server-side to a resolved Weavestream company. There
 * is no `companyId` in the URL, so IDOR-by-URL-tampering is
 * impossible — the controller is gated by the `tickets.read.global`
 * permission (capability `TICKETS_READ`, granted to SUPER_ADMIN
 * implicitly and to elevated OPERATORs via the manager preset).
 *
 * Tickets are NEVER persisted in Weavestream. Every request hits the
 * upstream system via the driver; `TicketsService` records a per-call
 * audit row (`tickets.list` / `tickets.view`) with `companyId: null`
 * — bodies / subjects are never audit-logged.
 *
 * Capability probe (`/_capability`) is published so the admin sidebar
 * can decide whether to render the Tickets entry without leaking the
 * underlying mapping. The same `tickets.read.global` gate keeps it
 * out of the portal entirely.
 */
@Controller({ path: 'tickets', version: '1' })
export class TicketsGlobalController {
  constructor(private readonly tickets: TicketsService) {}

  /**
   * Sidebar-data probe: does the system have any ticketing-capable
   * integration ACTIVE? Declared BEFORE `:ticketId` so the literal
   * `_capability` segment doesn't get swallowed by the ticket detail
   * route.
   */
  @Get('_capability')
  @RequirePermission('tickets.read.global')
  async capability(): Promise<{ enabled: boolean }> {
    return { enabled: await this.tickets.anyCompanyHasTicketing() };
  }

  @Get()
  @RequirePermission('tickets.read.global')
  async list(
    @CurrentUser() actor: AuthedUser,
    @Query() query: Record<string, string | undefined>,
    @Req() req: Request,
  ) {
    // Zod-parse only the filter keys; cursor is opaque pass-through.
    const filter: TicketListFilter = ticketListFilterSchema.parse({
      status: query['status'] || undefined,
      priority: query['priority'] || undefined,
      boardId: query['boardId'] || undefined,
      // Note: assigneeId filter is kept on the DTO for the legacy
      // per-company surface but the global UI no longer surfaces it
      // (assignees come back as opaque NinjaOne user ids).
      assigneeId: query['assigneeId'] || undefined,
      search: query['search'] || undefined,
    });
    const cursor = query['cursor'] ? String(query['cursor']) : null;
    return this.tickets.listAllTickets(actor, filter, cursor, meta(req));
  }

  @Get(':ticketId')
  @RequirePermission('tickets.read.global')
  async get(
    @CurrentUser() actor: AuthedUser,
    @Param('ticketId') ticketId: string,
    @Req() req: Request,
  ) {
    return this.tickets.getAnyTicket(actor, ticketId, meta(req));
  }
}
