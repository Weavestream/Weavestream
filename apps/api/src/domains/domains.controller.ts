import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  createMonitoredDomainSchema,
  updateMonitoredDomainSchema,
  QueueNames,
  type CreateMonitoredDomainInput,
  type DomainStatusValue,
  type UpdateMonitoredDomainInput,
} from '@weavestream/shared';
import { DomainsService } from './domains.service.js';
import { QueuesService } from '../queues/queues.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { requestMetaOf as meta } from '../common/request-meta.js';
import { EnvService } from '../config/env.service.js';

const ALLOWED_STATUSES: DomainStatusValue[] = [
  'OK',
  'EXPIRING',
  'EXPIRED',
  'FAIL',
  'UNKNOWN',
];

/**
 * Phase 8 — Domains REST controller (per-company).
 *
 * Path: `/v1/companies/:companyId/domains`. Client users get the
 * `domain.read` permission so they can see the filtered public list;
 * everything that mutates state (create/update/archive/restore/check)
 * requires `domain.manage`, which is OPERATOR_FULL or SUPER_ADMIN only.
 */
@Controller({ path: 'companies/:companyId/domains', version: '1' })
export class DomainsController {
  private readonly logger = new Logger(DomainsController.name);

  constructor(
    private readonly domains: DomainsService,
    private readonly queues: QueuesService,
    private readonly env: EnvService,
  ) {}

  @Get()
  @RequirePermission('domain.read', { companyIdFrom: 'params.companyId' })
  async list(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('includeArchived') includeArchived?: string,
    @Query('limit') rawLimit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const parsedStatus =
      status && ALLOWED_STATUSES.includes(status as DomainStatusValue)
        ? (status as DomainStatusValue)
        : undefined;
    return this.domains.list(actor, companyId, {
      q,
      status: parsedStatus,
      includeArchived: includeArchived === 'true',
      limit: rawLimit ? parseInt(rawLimit, 10) : undefined,
      cursor,
    });
  }

  @Get(':id')
  @RequirePermission('domain.read', { companyIdFrom: 'params.companyId' })
  async get(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.domains.getById(actor, companyId, id);
  }

  @Get(':id/checks')
  @RequirePermission('domain.read', { companyIdFrom: 'params.companyId' })
  async checks(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('limit') rawLimit?: string,
  ) {
    const limit = rawLimit ? parseInt(rawLimit, 10) : 30;
    return this.domains.listChecks(actor, companyId, id, limit);
  }

  @Post()
  @RequirePermission('domain.manage', { companyIdFrom: 'params.companyId' })
  async create(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Body(new ZodBody(createMonitoredDomainSchema)) dto: CreateMonitoredDomainInput,
    @Req() req: Request,
  ) {
    return this.domains.create(actor, companyId, dto, meta(req));
  }

  @Patch(':id')
  @RequirePermission('domain.manage', { companyIdFrom: 'params.companyId' })
  async update(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(updateMonitoredDomainSchema)) dto: UpdateMonitoredDomainInput,
    @Req() req: Request,
  ) {
    return this.domains.update(actor, companyId, id, dto, meta(req));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('domain.manage', { companyIdFrom: 'params.companyId' })
  async archive(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.domains.archive(actor, companyId, id, meta(req));
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('domain.manage', { companyIdFrom: 'params.companyId' })
  async restore(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.domains.restore(actor, companyId, id, meta(req));
  }

  /**
   * Trigger an ad-hoc "check now" run. The endpoint blocks until the
   * BullMQ job completes (or times out), and then re-reads the domain
   * so the caller sees the refreshed `latestStatus` + expiry fields.
   */
  @Post(':id/check')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('domain.manage', { companyIdFrom: 'params.companyId' })
  async check(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const domain = await this.domains.getById(actor, companyId, id);
    const jobId = await this.queues.enqueueDomainCheck({
      kind: 'single',
      domainId: domain.id,
      actorId: actor.id,
    });
    const { DOMAIN_CHECK_TIMEOUT_MS, DOMAIN_CHECK_ATTEMPTS } = this.env.values;
    const budget = DOMAIN_CHECK_TIMEOUT_MS * DOMAIN_CHECK_ATTEMPTS + 2_000;
    const outcome = await this.queues.waitForJob(QueueNames.domainChecks, jobId, budget);
    if (outcome === 'timeout') {
      this.logger.warn(
        `Manual check for ${domain.hostname} exceeded ${budget}ms — job continues in background`,
      );
    }
    const fresh = await this.domains.getById(actor, companyId, id);
    const checks = await this.domains.listChecks(actor, companyId, id, 1);
    return {
      outcome,
      domain: fresh,
      latestCheck: checks[0] ?? null,
    };
  }
}

/**
 * Cross-company domain alerts feed.
 *
 * Mounted OUTSIDE the per-company controller so the alert badge on the
 * global admin dashboard can aggregate across every tenant. We guard
 * it by requiring the SUPER_ADMIN role explicitly — no RBAC action
 * covers "read everybody's data" without a tenant scope, because that
 * would be a footgun for future handlers.
 */
@Controller({ path: 'domains', version: '1' })
export class DomainsAlertsController {
  constructor(private readonly domains: DomainsService) {}

  @Get('alerts')
  @RequirePermission('domain.read')
  async alerts(
    @CurrentUser() actor: AuthedUser,
    @Query('limit') rawLimit?: string,
  ) {
    if (actor.role !== 'SUPER_ADMIN') {
      // Belt-and-braces: domain.read is tenant-scoped, but this feed is
      // cross-tenant. SUPER_ADMINs are the only legitimate consumers.
      throw new ForbiddenException('cross-company alerts feed is SUPER_ADMIN-only');
    }
    const limit = rawLimit ? parseInt(rawLimit, 10) : 50;
    return { items: await this.domains.listAlertsAcrossCompanies(limit) };
  }
}

