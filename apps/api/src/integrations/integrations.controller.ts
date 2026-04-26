import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  createIntegrationCompanyMappingSchema,
  createIntegrationSchema,
  replaceFieldMappingsSchema,
  triggerSyncSchema,
  updateIntegrationCompanyMappingSchema,
  updateIntegrationSchema,
  type CreateIntegrationCompanyMappingInput,
  type CreateIntegrationInput,
  type ReplaceFieldMappingsInput,
  type TriggerSyncInput,
  type UpdateIntegrationCompanyMappingInput,
  type UpdateIntegrationInput,
} from '@weavestream/shared';
import { ZodBody } from '../common/zod-validation.pipe.js';
import {
  CurrentUser,
  type AuthedUser,
} from '../common/current-user.decorator.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { IntegrationsService } from './integrations.service.js';
import { IntegrationCompanyMappingService } from './company-mapping.service.js';
import { IntegrationSyncService } from './integration-sync.service.js';
import { IntegrationDriverRegistry } from './drivers/integration-driver.registry.js';
import {
  DriverAuthError,
  DriverRateLimitError,
  type IntegrationContext,
} from './drivers/integration-driver.js';
import { EnvService } from '../config/env.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

/**
 * Phase 11 — admin integrations API.
 *
 * Two top-level resources mounted under `/v1/admin/integrations`:
 *   - GET    /drivers                                    — list available drivers
 *   - GET    /                                           — list integrations
 *   - POST   /                                           — create integration
 *   - GET    /:id                                        — get integration
 *   - PATCH  /:id                                        — update integration
 *   - DELETE /:id                                        — delete + release assets
 *   - POST   /:id/test                                   — driver.testConnection
 *   - GET    /:id/source-orgs                            — driver.listSourceOrgs
 *   - GET    /:id/source-fields?externalOrgId=…          — driver.listSourceFields
 *   - GET    /:id/mappings                               — list company mappings
 *   - POST   /:id/mappings                               — create mapping
 *   - GET    /:id/mappings/:mappingId
 *   - PATCH  /:id/mappings/:mappingId
 *   - DELETE /:id/mappings/:mappingId
 *   - GET    /:id/field-mappings                         — list GLOBAL field mappings
 *   - PATCH  /:id/field-mappings                         — replace-all
 *   - POST   /:id/sync                                   — trigger manual sync
 *   - GET    /:id/runs
 *   - GET    /:id/runs/:runId
 *
 * Every route is gated by `integration.manage` (SUPER_ADMIN-only) except
 * the run-trigger which uses `sync.trigger` (also SUPER_ADMIN-only).
 */
@Controller({ path: 'admin/integrations', version: '1' })
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly mappings: IntegrationCompanyMappingService,
    private readonly sync: IntegrationSyncService,
    private readonly drivers: IntegrationDriverRegistry,
    private readonly env: EnvService,
    private readonly audit: AuditLogService,
  ) {}

  // -------------------------------------------------------------------
  // Driver registry
  // -------------------------------------------------------------------

  @Get('drivers')
  @RequirePermission('integration.manage')
  listDrivers() {
    return { drivers: this.integrations.listDrivers() };
  }

  // -------------------------------------------------------------------
  // Integration CRUD
  // -------------------------------------------------------------------

  @Get()
  @RequirePermission('integration.manage')
  list() {
    return this.integrations.list();
  }

  @Post()
  @RequirePermission('integration.manage')
  create(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(createIntegrationSchema)) dto: CreateIntegrationInput,
    @Req() req: Request,
  ) {
    return this.integrations.create(user, dto, meta(req));
  }

  @Get(':id')
  @RequirePermission('integration.manage')
  get(@Param('id') id: string) {
    return this.integrations.get(id);
  }

  @Patch(':id')
  @RequirePermission('integration.manage')
  update(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(updateIntegrationSchema)) dto: UpdateIntegrationInput,
    @Req() req: Request,
  ) {
    return this.integrations.update(user, id, dto, meta(req));
  }

  @Delete(':id')
  @RequirePermission('integration.manage')
  @HttpCode(204)
  async delete(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.integrations.delete(user, id, meta(req));
  }

  // -------------------------------------------------------------------
  // Driver helpers (UI flow)
  // -------------------------------------------------------------------

  @Post(':id/test')
  @RequirePermission('integration.manage')
  async testConnection(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    const ctx = await this.integrations.loadDriverContext(id);
    const driver = this.drivers.get(ctx.driver);
    const integrationCtx: IntegrationContext = {
      config: ctx.config,
      secret: ctx.secret,
      http: this.httpDefaults(),
      correlationId: randomUUID(),
    };
    try {
      const result = await driver.testConnection(integrationCtx);
      await this.audit.log({
        actorId: user.id,
        action: AUDIT_ACTIONS.integration.testConnection,
        entityType: 'Integration',
        entityId: id,
        ip: meta(req).ip,
        userAgent: meta(req).userAgent,
        before: null,
        after: { ok: true, details: result.details ?? null },
      });
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.audit.log({
        actorId: user.id,
        action: AUDIT_ACTIONS.integration.testConnection,
        entityType: 'Integration',
        entityId: id,
        ip: meta(req).ip,
        userAgent: meta(req).userAgent,
        before: null,
        after: { ok: false, error: message.slice(0, 500) },
      });
      if (e instanceof DriverAuthError || e instanceof DriverRateLimitError) {
        throw new BadRequestException(message);
      }
      throw new BadRequestException(`Connection test failed: ${message}`);
    }
  }

  @Get(':id/source-orgs')
  @RequirePermission('integration.manage')
  async listSourceOrgs(@Param('id') id: string) {
    const ctx = await this.integrations.loadDriverContext(id);
    const driver = this.drivers.get(ctx.driver);
    const integrationCtx: IntegrationContext = {
      config: ctx.config,
      secret: ctx.secret,
      http: this.httpDefaults(),
      correlationId: randomUUID(),
    };
    return { orgs: await driver.listSourceOrgs(integrationCtx) };
  }

  @Get(':id/source-fields')
  @RequirePermission('integration.manage')
  async listSourceFields(
    @Param('id') id: string,
    @Query('externalOrgId') externalOrgId?: string,
  ) {
    const ctx = await this.integrations.loadDriverContext(id);
    const driver = this.drivers.get(ctx.driver);
    // The global field-mapping editor doesn't always have a specific
    // org in mind — most drivers (Action1, IT Glue) return a uniform
    // schema regardless. If the caller didn't pass one, fall back to
    // the first existing per-company mapping so the driver still gets
    // a non-empty `externalOrgId` when it needs one.
    let resolvedOrgId = externalOrgId;
    if (!resolvedOrgId) {
      const firstMapping = await this.mappings.list(id);
      resolvedOrgId = firstMapping[0]?.externalOrgId;
    }
    if (!resolvedOrgId) {
      throw new BadRequestException(
        'No organization mappings exist yet. Map at least one upstream organization to load its source fields.',
      );
    }
    const integrationCtx: IntegrationContext & { externalOrgId: string } = {
      config: ctx.config,
      secret: ctx.secret,
      http: this.httpDefaults(),
      correlationId: randomUUID(),
      externalOrgId: resolvedOrgId,
    };
    return { fields: await driver.listSourceFields(integrationCtx) };
  }

  // -------------------------------------------------------------------
  // Company mappings
  // -------------------------------------------------------------------

  @Get(':id/mappings')
  @RequirePermission('integration.manage')
  listMappings(@Param('id') id: string) {
    return this.mappings.list(id);
  }

  @Post(':id/mappings')
  @RequirePermission('integration.manage')
  createMapping(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(createIntegrationCompanyMappingSchema))
    dto: CreateIntegrationCompanyMappingInput,
    @Req() req: Request,
  ) {
    return this.mappings.create(user, id, dto, meta(req));
  }

  @Get(':id/mappings/:mappingId')
  @RequirePermission('integration.manage')
  getMapping(@Param('id') id: string, @Param('mappingId') mappingId: string) {
    return this.mappings.get(id, mappingId);
  }

  @Patch(':id/mappings/:mappingId')
  @RequirePermission('integration.manage')
  updateMapping(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Param('mappingId') mappingId: string,
    @Body(new ZodBody(updateIntegrationCompanyMappingSchema))
    dto: UpdateIntegrationCompanyMappingInput,
    @Req() req: Request,
  ) {
    return this.mappings.update(user, id, mappingId, dto, meta(req));
  }

  @Delete(':id/mappings/:mappingId')
  @RequirePermission('integration.manage')
  @HttpCode(204)
  async deleteMapping(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Param('mappingId') mappingId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.mappings.delete(user, id, mappingId, meta(req));
  }

  // -------------------------------------------------------------------
  // Field mappings (GLOBAL — one set per integration, replace-all)
  // -------------------------------------------------------------------

  @Get(':id/field-mappings')
  @RequirePermission('integration.manage')
  listFieldMappings(@Param('id') id: string) {
    return this.integrations.listFieldMappings(id);
  }

  @Patch(':id/field-mappings')
  @RequirePermission('integration.manage')
  replaceFieldMappings(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(replaceFieldMappingsSchema))
    dto: ReplaceFieldMappingsInput,
    @Req() req: Request,
  ) {
    return this.integrations.replaceFieldMappings(user, id, dto, meta(req));
  }

  // -------------------------------------------------------------------
  // Sync triggering & history
  // -------------------------------------------------------------------

  @Post(':id/sync')
  @RequirePermission('sync.trigger')
  triggerSync(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(triggerSyncSchema)) dto: TriggerSyncInput,
    @Req() req: Request,
  ) {
    return this.sync.triggerManual(user, id, dto.dryRun, meta(req));
  }

  @Get(':id/runs')
  @RequirePermission('integration.manage')
  listRuns(@Param('id') id: string) {
    return this.sync.listRuns(id);
  }

  @Get(':id/runs/:runId')
  @RequirePermission('integration.manage')
  getRun(@Param('id') id: string, @Param('runId') runId: string) {
    return this.sync.getRun(id, runId);
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  private httpDefaults() {
    return {
      timeoutMs: this.env.values.INTEGRATION_HTTP_TIMEOUT_MS,
      maxRetries: this.env.values.INTEGRATION_HTTP_MAX_RETRIES,
      backoffMs: this.env.values.INTEGRATION_HTTP_BACKOFF_MS,
    };
  }
}

function meta(req: Request): { ip: string; userAgent: string } {
  return { ip: ipOf(req), userAgent: uaOf(req) };
}
function ipOf(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]!.trim();
  return req.ip ?? '0.0.0.0';
}
function uaOf(req: Request): string {
  return (req.headers['user-agent'] ?? 'unknown').toString().slice(0, 500);
}
