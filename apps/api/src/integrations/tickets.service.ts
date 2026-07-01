import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  TicketDetailDto,
  TicketListFilter,
  TicketListResponse,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { EnvService } from '../config/env.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { IntegrationsService } from './integrations.service.js';
import { IntegrationDriverRegistry } from './drivers/integration-driver.registry.js';
import {
  DriverAuthError,
  DriverRateLimitError,
  isTicketingDriver,
  type TicketContext,
} from './drivers/integration-driver.js';
import { describeError } from '../common/describe-error.js';

export interface TicketAuditMeta {
  ip: string;
  userAgent: string;
}

/**
 * Phase 12 — real-time external-ticket browse surface.
 *
 * Tickets are NEVER persisted in the Weavestream database. This
 * service resolves the company's active ticketing-capable integration
 * mapping, loads the decrypted driver context, and forwards the call
 * to the driver. The result flows straight back to the controller
 * (and from there to the web UI) without touching Postgres.
 *
 * Single-provider-per-company today: a company is expected to map at
 * most one ticketing-capable integration. If multiple are configured
 * we pick the first ACTIVE one deterministically (by integration name)
 * and surface a warning in the logs — the UI never exposes a picker
 * because the rest of the chat plumbing assumes one ticket source per
 * company. The cross-provider UX bridge is intentionally deferred
 * (see plan: "we'll cross the multi-provider UX bridge when a second
 * driver ships").
 */
@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly audit: AuditLogService,
    private readonly integrations: IntegrationsService,
    private readonly drivers: IntegrationDriverRegistry,
  ) {}

  // -------------------------------------------------------------------
  // Phase 12+ — global admin browse
  // -------------------------------------------------------------------

  /**
   * Returns `true` when at least one enabled mapping in the system
   * points at an ACTIVE integration whose driver advertises
   * `capabilities.ticketing`. The admin sidebar uses this to decide
   * whether to surface the global Tickets link.
   */
  async anyCompanyHasTicketing(): Promise<boolean> {
    try {
      const mapping = await this.resolveGlobalTicketingMapping();
      return mapping !== null;
    } catch {
      return false;
    }
  }

  /**
   * Global ticket browse: aggregate every visible ticket across the
   * system, with each row stitched to its resolved Weavestream
   * company (when an `IntegrationCompanyMapping` exists for the
   * upstream client). This is admin-only by controller-level
   * permission; the service intentionally does NOT check tenant
   * scope because there is no tenant in the URL.
   */
  async listAllTickets(
    actor: AuthedUser,
    filter: TicketListFilter,
    cursor: string | null,
    meta: TicketAuditMeta,
  ): Promise<TicketListResponse> {
    const resolved = await this.resolveGlobalTicketingMapping();
    if (!resolved) {
      throw new NotFoundException(
        'No ticketing-capable integration is enabled in this system.',
      );
    }
    const { driver, integrationId, clientMap } = resolved;
    const ctx = await this.integrations.loadDriverContext(integrationId);
    const correlationId = randomUUID();
    try {
      const result = await driver.listTickets(
        {
          config: ctx.config,
          secret: ctx.secret,
          http: this.httpDefaults(),
          correlationId,
          integrationId: ctx.integrationId,
          externalOrgId: null,
        } satisfies TicketContext,
        filter,
        cursor,
      );
      // Stitch resolved company info onto each row in-place. Rows
      // whose upstream client isn't mapped to a Weavestream company
      // keep `companyId/companyName: null` and the UI renders an
      // "unmapped client" label.
      const stitched = result.records.map((r) => {
        const company = r.externalClientId
          ? (clientMap.get(r.externalClientId) ?? null)
          : null;
        return company
          ? { ...r, companyId: company.id, companyName: company.name }
          : r;
      });
      await this.audit.log({
        actorId: actor.id,
        action: AUDIT_ACTIONS.tickets.list,
        entityType: 'Ticket',
        entityId: null,
        companyId: null,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: {
          driver: ctx.driver,
          integrationId: ctx.integrationId,
          scope: 'global',
          filter: this.sanitizeFilterForAudit(filter),
          cursor: cursor ? cursorFingerprint(cursor) : null,
          rows: stitched.length,
          ok: true,
        },
      });
      return { records: stitched, cursor: result.cursor };
    } catch (e) {
      await this.audit.log({
        actorId: actor.id,
        action: AUDIT_ACTIONS.tickets.list,
        entityType: 'Ticket',
        entityId: null,
        companyId: null,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: {
          driver: ctx.driver,
          integrationId: ctx.integrationId,
          scope: 'global',
          filter: this.sanitizeFilterForAudit(filter),
          cursor: cursor ? cursorFingerprint(cursor) : null,
          ok: false,
          error: shortError(e),
        },
      });
      throw this.translateDriverError(e);
    }
  }

  /**
   * Global ticket detail: fetches one ticket from the system's
   * ticketing integration, stitches the resolved Weavestream company
   * onto the response. No IDOR check at this layer — admin-only.
   */
  async getAnyTicket(
    actor: AuthedUser,
    ticketId: string,
    meta: TicketAuditMeta,
  ): Promise<TicketDetailDto> {
    const safeTicketId = sanitizeTicketId(ticketId);
    const resolved = await this.resolveGlobalTicketingMapping();
    if (!resolved) {
      throw new NotFoundException(
        'No ticketing-capable integration is enabled in this system.',
      );
    }
    const { driver, integrationId, clientMap } = resolved;
    const ctx = await this.integrations.loadDriverContext(integrationId);
    const correlationId = randomUUID();
    try {
      const detail = await driver.getTicket(
        {
          config: ctx.config,
          secret: ctx.secret,
          http: this.httpDefaults(),
          correlationId,
          integrationId: ctx.integrationId,
          externalOrgId: null,
        } satisfies TicketContext,
        safeTicketId,
      );
      const company = detail.externalClientId
        ? (clientMap.get(detail.externalClientId) ?? null)
        : null;
      const stitched: TicketDetailDto = company
        ? { ...detail, companyId: company.id, companyName: company.name }
        : detail;
      await this.audit.log({
        actorId: actor.id,
        action: AUDIT_ACTIONS.tickets.view,
        entityType: 'Ticket',
        entityId: safeTicketId,
        companyId: stitched.companyId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: {
          driver: ctx.driver,
          integrationId: ctx.integrationId,
          scope: 'global',
          externalClientId: detail.externalClientId,
          activityCount: stitched.activities.length,
          ok: true,
        },
      });
      return stitched;
    } catch (e) {
      await this.audit.log({
        actorId: actor.id,
        action: AUDIT_ACTIONS.tickets.view,
        entityType: 'Ticket',
        entityId: safeTicketId,
        companyId: null,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: {
          driver: ctx.driver,
          integrationId: ctx.integrationId,
          scope: 'global',
          ok: false,
          error: shortError(e),
        },
      });
      throw this.translateDriverError(e);
    }
  }

  /**
   * Resolves the single ACTIVE ticketing integration deployed in the
   * system and builds a `{ externalClientId -> {companyId, companyName} }`
   * map from every enabled mapping it owns. The map is the source of
   * truth for converting NinjaOne `clientId` rows into Weavestream
   * company chips on the admin UI.
   *
   * Returns null when there is no ticketing-capable integration.
   * Multiple ticketing integrations: picks the first one
   * alphabetically by `Integration.name` and logs a warning so a
   * future multi-provider UX can replace this behaviour.
   */
  private async resolveGlobalTicketingMapping(): Promise<{
    driver: ReturnType<IntegrationDriverRegistry['get']> &
      Required<
        Pick<
          ReturnType<IntegrationDriverRegistry['get']>,
          'listTickets' | 'getTicket'
        >
      >;
    integrationId: string;
    integrationName: string;
    clientMap: Map<string, { id: string; name: string }>;
  } | null> {
    const integrations = await this.prisma.integration.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        driver: true,
        name: true,
        companyMappings: {
          where: {
            enabled: true,
            company: { archivedAt: null },
          },
          select: {
            externalOrgId: true,
            company: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { name: 'asc' },
    });
    const ticketingIntegrations = integrations.filter((i) => {
      if (!this.drivers.has(i.driver)) return false;
      const descriptor = this.drivers.describe(i.driver);
      return descriptor.capabilities.ticketing === true;
    });
    const [picked, ...extras] = ticketingIntegrations;
    if (!picked) return null;
    if (extras.length > 0) {
      this.logger.warn(
        `System has ${ticketingIntegrations.length} ticketing-capable integrations; admin browse picked "${picked.name}". Multi-provider UX is deferred.`,
      );
    }
    const driver = this.drivers.get(picked.driver);
    if (!isTicketingDriver(driver)) return null;
    const clientMap = new Map<string, { id: string; name: string }>();
    for (const m of picked.companyMappings) {
      if (m.externalOrgId && m.company) {
        clientMap.set(m.externalOrgId, {
          id: m.company.id,
          name: m.company.name,
        });
      }
    }
    return {
      driver,
      integrationId: picked.id,
      integrationName: picked.name,
      clientMap,
    };
  }

  // -------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------

  private translateDriverError(e: unknown): Error {
    if (e instanceof DriverAuthError) {
      // 403 is the right shape: the credentials don't work, retrying
      // won't help. Operator must re-auth the integration.
      return new ForbiddenException(e.message);
    }
    if (e instanceof DriverRateLimitError) {
      return new BadRequestException(`Rate limited: ${e.message}`);
    }
    if (e instanceof NotFoundException || e instanceof BadRequestException) {
      return e;
    }
    if (e instanceof Error) {
      return new BadRequestException(`Ticket fetch failed: ${describeError(e)}`);
    }
    return new BadRequestException('Ticket fetch failed');
  }

  private httpDefaults() {
    return {
      timeoutMs: this.env.values.INTEGRATION_HTTP_TIMEOUT_MS,
      maxRetries: this.env.values.INTEGRATION_HTTP_MAX_RETRIES,
      backoffMs: this.env.values.INTEGRATION_HTTP_BACKOFF_MS,
    };
  }

  /**
   * Audit payload sanitiser — keep filter identifiers (status, board,
   * etc.) but cap the free-text search to its length only. Subjects /
   * customer content never enter the audit log.
   */
  private sanitizeFilterForAudit(
    filter: TicketListFilter,
  ): Record<string, unknown> {
    return {
      status: filter.status ?? null,
      priority: filter.priority ?? null,
      boardId: filter.boardId ?? null,
      assigneeId: filter.assigneeId ?? null,
      searchLen: filter.search ? filter.search.length : 0,
    };
  }
}

/**
 * Pagination cursors are driver-defined opaque strings. We log only a
 * length + short prefix so the audit log can prove a paginated request
 * occurred without storing the (potentially state-revealing) cursor
 * payload.
 */
function cursorFingerprint(cursor: string): string {
  const trimmed = cursor.slice(0, 8);
  return `${trimmed}…(${cursor.length})`;
}

/**
 * Soft-bound the inbound ticket id. The driver is the source of truth
 * for the actual id shape, but we hard-reject anything that's clearly
 * not an opaque token before round-tripping it to the upstream API.
 */
function sanitizeTicketId(id: string): string {
  if (typeof id !== 'string') {
    throw new BadRequestException('Invalid ticket id.');
  }
  const trimmed = id.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    throw new BadRequestException('Invalid ticket id.');
  }
  if (!/^[A-Za-z0-9._\-:]+$/.test(trimmed)) {
    throw new BadRequestException('Invalid ticket id.');
  }
  return trimmed;
}

function shortError(e: unknown): string {
  // Include the `cause` chain — a bare "fetch failed" is useless in the
  // ticket audit trail without the underlying network/driver reason.
  return describeError(e, 500);
}
