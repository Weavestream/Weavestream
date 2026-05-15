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

  /**
   * Returns `true` when the company has at least one enabled mapping
   * pointing at an ACTIVE integration whose driver advertises
   * `capabilities.ticketing`. Used by the web layer to gate the
   * "Tickets" sidebar item without exposing a separate full-resolve
   * round-trip.
   */
  async companyHasTicketing(companyId: string): Promise<boolean> {
    try {
      await this.resolveTicketingMapping(companyId);
      return true;
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof BadRequestException) {
        return false;
      }
      throw e;
    }
  }

  async listTickets(
    actor: AuthedUser,
    companyId: string,
    filter: TicketListFilter,
    cursor: string | null,
    meta: TicketAuditMeta,
  ): Promise<TicketListResponse> {
    const { driver, ctx, mapping } = await this.loadDriverFor(companyId);
    const correlationId = randomUUID();
    try {
      const result = await driver.listTickets(
        {
          config: ctx.config,
          secret: ctx.secret,
          http: this.httpDefaults(),
          correlationId,
          integrationId: ctx.integrationId,
          externalOrgId: mapping.externalOrgId,
        } satisfies TicketContext,
        filter,
        cursor,
      );
      await this.audit.log({
        actorId: actor.id,
        action: AUDIT_ACTIONS.tickets.list,
        entityType: 'Ticket',
        entityId: null,
        companyId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: {
          driver: ctx.driver,
          integrationId: ctx.integrationId,
          externalOrgId: mapping.externalOrgId,
          filter: this.sanitizeFilterForAudit(filter),
          cursor: cursor ? cursorFingerprint(cursor) : null,
          rows: result.records.length,
          ok: true,
        },
      });
      return result;
    } catch (e) {
      await this.audit.log({
        actorId: actor.id,
        action: AUDIT_ACTIONS.tickets.list,
        entityType: 'Ticket',
        entityId: null,
        companyId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: {
          driver: ctx.driver,
          integrationId: ctx.integrationId,
          externalOrgId: mapping.externalOrgId,
          filter: this.sanitizeFilterForAudit(filter),
          cursor: cursor ? cursorFingerprint(cursor) : null,
          ok: false,
          error: shortError(e),
        },
      });
      throw this.translateDriverError(e);
    }
  }

  async getTicket(
    actor: AuthedUser,
    companyId: string,
    ticketId: string,
    meta: TicketAuditMeta,
  ): Promise<TicketDetailDto> {
    const safeTicketId = sanitizeTicketId(ticketId);
    const { driver, ctx, mapping } = await this.loadDriverFor(companyId);
    const correlationId = randomUUID();
    try {
      const detail = await driver.getTicket(
        {
          config: ctx.config,
          secret: ctx.secret,
          http: this.httpDefaults(),
          correlationId,
          integrationId: ctx.integrationId,
          externalOrgId: mapping.externalOrgId,
        } satisfies TicketContext,
        safeTicketId,
      );
      await this.audit.log({
        actorId: actor.id,
        action: AUDIT_ACTIONS.tickets.view,
        entityType: 'Ticket',
        entityId: safeTicketId,
        companyId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: {
          driver: ctx.driver,
          integrationId: ctx.integrationId,
          externalOrgId: mapping.externalOrgId,
          activityCount: detail.activities.length,
          ok: true,
        },
      });
      return detail;
    } catch (e) {
      await this.audit.log({
        actorId: actor.id,
        action: AUDIT_ACTIONS.tickets.view,
        entityType: 'Ticket',
        entityId: safeTicketId,
        companyId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: {
          driver: ctx.driver,
          integrationId: ctx.integrationId,
          externalOrgId: mapping.externalOrgId,
          ok: false,
          error: shortError(e),
        },
      });
      throw this.translateDriverError(e);
    }
  }

  // -------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------

  private async loadDriverFor(companyId: string) {
    const mapping = await this.resolveTicketingMapping(companyId);
    const ctx = await this.integrations.loadDriverContext(mapping.integrationId);
    const driver = this.drivers.get(ctx.driver);
    if (!isTicketingDriver(driver)) {
      // Capability flipped off between the mapping resolution and the
      // call. Surface as 400 — the operator can re-check the integration
      // status from the admin UI.
      throw new BadRequestException(
        'The integration mapped to this company no longer advertises ticketing support.',
      );
    }
    return { driver, ctx, mapping };
  }

  /**
   * Resolve the single ACTIVE, ENABLED mapping for `companyId` that
   * points at an integration whose driver advertises
   * `capabilities.ticketing`. Throws 404 when no such mapping exists.
   */
  private async resolveTicketingMapping(companyId: string) {
    // We verify the company exists up front so callers can distinguish
    // "bad company id" (404) from "company exists but has no ticketing
    // mapping" (also 404 but with a different message — the
    // PermissionGuard still gates by tenant first).
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true, archivedAt: true },
    });
    if (!company) {
      throw new NotFoundException(`Company ${companyId} not found`);
    }
    if (company.archivedAt) {
      throw new BadRequestException(
        `Company ${companyId} is archived; ticketing access is disabled.`,
      );
    }
    const mappings = await this.prisma.integrationCompanyMapping.findMany({
      where: {
        companyId,
        enabled: true,
        integration: { status: 'ACTIVE' },
      },
      include: { integration: { select: { driver: true, name: true } } },
      orderBy: [{ integration: { name: 'asc' } }, { externalOrgId: 'asc' }],
    });
    const ticketingMappings = mappings.filter((m) => {
      if (!this.drivers.has(m.integration.driver)) return false;
      const descriptor = this.drivers.describe(m.integration.driver);
      return descriptor.capabilities.ticketing === true;
    });
    const [picked, ...extras] = ticketingMappings;
    if (!picked) {
      throw new NotFoundException(
        'No ticketing-capable integration is mapped to this company.',
      );
    }
    if (extras.length > 0) {
      // Deterministic pick: alphabetically by integration name. The web
      // sidebar gating uses the same resolver, so the same provider is
      // picked everywhere for a given company. A future multi-provider
      // UX can replace this with an explicit selector.
      this.logger.warn(
        `Company ${companyId} has ${ticketingMappings.length} ticketing-capable mappings; using "${picked.integration.name}".`,
      );
    }
    return picked;
  }

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
      return new BadRequestException(`Ticket fetch failed: ${e.message}`);
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
  if (e instanceof Error) return e.message.slice(0, 500);
  return String(e).slice(0, 500);
}
