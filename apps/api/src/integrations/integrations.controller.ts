import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  createIntegrationCompanyMappingSchema,
  createIntegrationResourceSchema,
  createIntegrationSchema,
  replaceFieldMappingsSchema,
  triggerSyncSchema,
  updateIntegrationCompanyMappingSchema,
  updateIntegrationResourceSchema,
  updateIntegrationSchema,
  type CreateIntegrationCompanyMappingInput,
  type CreateIntegrationInput,
  type CreateIntegrationResourceInput,
  type ReplaceFieldMappingsInput,
  type TriggerSyncInput,
  type UpdateIntegrationCompanyMappingInput,
  type UpdateIntegrationInput,
  type UpdateIntegrationResourceInput,
} from '@weavestream/shared';
import { ZodBody } from '../common/zod-validation.pipe.js';
import {
  CurrentUser,
  type AuthedUser,
} from '../common/current-user.decorator.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { RequireStepUp } from '../auth/step-up/require-step-up.decorator.js';
import { IntegrationsService } from './integrations.service.js';
import { requestMetaOf as meta } from '../common/request-meta.js';
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
 * Top-level resources mounted under `/v1/admin/integrations`:
 *   - GET    /drivers
 *   - GET    /                                                    — list integrations
 *   - POST   /                                                    — create integration
 *   - GET    /:id
 *   - PATCH  /:id
 *   - DELETE /:id
 *   - POST   /:id/test                                            — driver.testConnection
 *   - GET    /:id/source-orgs                                     — driver.listSourceOrgs
 *   - GET    /:id/mappings                                        — list company mappings
 *   - POST   /:id/mappings
 *   - GET    /:id/mappings/:mappingId
 *   - PATCH  /:id/mappings/:mappingId
 *   - DELETE /:id/mappings/:mappingId
 *
 * Phase 11.1 — per-resource configuration:
 *   - GET    /:id/resources                                       — list resources
 *   - POST   /:id/resources                                       — enable a resource
 *   - GET    /:id/resources/:resourceKey
 *   - PATCH  /:id/resources/:resourceKey                          — layout / match keys / enabled
 *   - GET    /:id/resources/:resourceKey/source-fields            — driver.listSourceFields
 *   - GET    /:id/resources/:resourceKey/field-mappings
 *   - PATCH  /:id/resources/:resourceKey/field-mappings           — replace-all per resource
 *   - POST   /:id/sync                                            — trigger manual sync
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
  @RequireStepUp()
  create(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(createIntegrationSchema)) dto: CreateIntegrationInput,
    @Req() req: Request,
  ) {
    return this.integrations.create(user, dto, meta(req));
  }

  @Get(':id')
  @RequirePermission('integration.manage')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.integrations.get(id);
  }

  @Patch(':id')
  @RequirePermission('integration.manage')
  @RequireStepUp()
  update(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(updateIntegrationSchema)) dto: UpdateIntegrationInput,
    @Req() req: Request,
  ) {
    return this.integrations.update(user, id, dto, meta(req));
  }

  @Delete(':id')
  @RequirePermission('integration.manage')
  @RequireStepUp()
  @HttpCode(204)
  async delete(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
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
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    const ctx = await this.integrations.loadDriverContext(id);
    const correlationId = randomUUID();
    const http = this.httpDefaults();
    try {
      const result =
        this.drivers.kindOf(ctx.driver) === 'security'
          ? await this.drivers
              .getSecurity(ctx.driver)
              .testConnection(ctx.config, ctx.secret, http, correlationId)
          : await this.drivers.get(ctx.driver).testConnection({
              config: ctx.config,
              secret: ctx.secret,
              http,
              correlationId,
            } satisfies IntegrationContext);
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
  async listSourceOrgs(@Param('id', new ParseUUIDPipe()) id: string) {
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

  // -------------------------------------------------------------------
  // Company mappings
  // -------------------------------------------------------------------

  @Get(':id/mappings')
  @RequirePermission('integration.manage')
  listMappings(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.mappings.list(id);
  }

  @Post(':id/mappings')
  @RequirePermission('integration.manage')
  createMapping(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(createIntegrationCompanyMappingSchema))
    dto: CreateIntegrationCompanyMappingInput,
    @Req() req: Request,
  ) {
    return this.mappings.create(user, id, dto, meta(req));
  }

  @Get(':id/mappings/:mappingId')
  @RequirePermission('integration.manage')
  getMapping(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('mappingId', new ParseUUIDPipe()) mappingId: string,
  ) {
    return this.mappings.get(id, mappingId);
  }

  @Patch(':id/mappings/:mappingId')
  @RequirePermission('integration.manage')
  updateMapping(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('mappingId', new ParseUUIDPipe()) mappingId: string,
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
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('mappingId', new ParseUUIDPipe()) mappingId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.mappings.delete(user, id, mappingId, meta(req));
  }

  // -------------------------------------------------------------------
  // Resources (per-(integration, resourceKey) configuration container)
  // -------------------------------------------------------------------

  @Get(':id/resources')
  @RequirePermission('integration.manage')
  listResources(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.integrations.listResources(id);
  }

  @Post(':id/resources')
  @RequirePermission('integration.manage')
  createResource(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(createIntegrationResourceSchema))
    dto: CreateIntegrationResourceInput,
    @Req() req: Request,
  ) {
    return this.integrations.createResource(user, id, dto, meta(req));
  }

  @Get(':id/resources/:resourceKey')
  @RequirePermission('integration.manage')
  getResource(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('resourceKey') resourceKey: string,
  ) {
    return this.integrations.getResource(id, resourceKey);
  }

  @Patch(':id/resources/:resourceKey')
  @RequirePermission('integration.manage')
  updateResource(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('resourceKey') resourceKey: string,
    @Body(new ZodBody(updateIntegrationResourceSchema))
    dto: UpdateIntegrationResourceInput,
    @Req() req: Request,
  ) {
    return this.integrations.updateResource(user, id, resourceKey, dto, meta(req));
  }

  @Get(':id/resources/:resourceKey/source-fields')
  @RequirePermission('integration.manage')
  async listResourceSourceFields(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('resourceKey') resourceKey: string,
    @Query('externalOrgId') externalOrgId?: string,
  ) {
    const ctx = await this.integrations.loadDriverContext(id);
    const driver = this.drivers.get(ctx.driver);
    // Multi-resource drivers branch on `resourceKey`, but most still
    // need an `externalOrgId` to probe a real tenant. Fall back to the
    // first existing per-company mapping so the UI doesn't have to
    // pre-pick one.
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
    const integrationCtx: IntegrationContext & {
      externalOrgId: string;
      resourceKey: string;
    } = {
      config: ctx.config,
      secret: ctx.secret,
      http: this.httpDefaults(),
      correlationId: randomUUID(),
      externalOrgId: resolvedOrgId,
      resourceKey,
    };
    return { fields: await driver.listSourceFields(integrationCtx) };
  }

  @Get(':id/resources/:resourceKey/field-mappings')
  @RequirePermission('integration.manage')
  listResourceFieldMappings(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('resourceKey') resourceKey: string,
  ) {
    return this.integrations.listFieldMappings(id, resourceKey);
  }

  @Patch(':id/resources/:resourceKey/field-mappings')
  @RequirePermission('integration.manage')
  replaceResourceFieldMappings(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('resourceKey') resourceKey: string,
    @Body(new ZodBody(replaceFieldMappingsSchema))
    dto: ReplaceFieldMappingsInput,
    @Req() req: Request,
  ) {
    return this.integrations.replaceFieldMappings(
      user,
      id,
      resourceKey,
      dto,
      meta(req),
    );
  }

  // -------------------------------------------------------------------
  // Sync triggering & history
  // -------------------------------------------------------------------

  @Post(':id/sync')
  @RequirePermission('sync.trigger')
  triggerSync(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(triggerSyncSchema)) dto: TriggerSyncInput,
    @Req() req: Request,
  ) {
    return this.sync.triggerManual(user, id, dto.dryRun, meta(req));
  }

  @Get(':id/runs')
  @RequirePermission('integration.manage')
  listRuns(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.sync.listRuns(id);
  }

  @Get(':id/runs/:runId')
  @RequirePermission('integration.manage')
  getRun(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('runId', new ParseUUIDPipe()) runId: string,
  ) {
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
