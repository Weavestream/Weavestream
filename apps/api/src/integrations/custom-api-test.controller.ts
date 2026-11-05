import { BadRequestException, Body, Controller, HttpCode, Logger, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import {
  customApiTestRequestSchema,
  type CustomApiTestRequest,
  type CustomApiTestResponse,
} from '@weavestream/shared';
import { InteractiveOnly } from '../auth/interactive-only.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { requestMetaOf as meta } from '../common/request-meta.js';
import { EnvService } from '../config/env.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import { IntegrationsService } from './integrations.service.js';
import { IntegrationDriverRegistry } from './drivers/integration-driver.registry.js';
import { CUSTOM_API_DRIVER_KEY } from './drivers/custom-api/custom-api.resources.js';
import { runProbe } from './drivers/custom-api/custom-api.probe.js';
import { SECRET_BOUND_ORIGIN_MESSAGE, secretBoundOriginsChanged } from './secret-bound-config.js';

/**
 * Test for one section of a Custom API definition (the definition editor's
 * **Test** button): reads 1 page from the API and returns parsed records
 * and a key list, with masked samples. Never returns, logs or stores the
 * raw response, and never echoes a secret.
 *
 *   - POST /v1/admin/integrations/custom-api/draft-test  — a new integration; secrets in the body
 *   - POST /v1/admin/integrations/:id/custom-api/test    — a saved one; may use its saved secret
 *
 * The draft route is not `custom-api/test`: that path would match
 * `POST :id/test` on IntegrationsController first and fail its UUID check.
 *
 * A saved secret is used only when the draft keeps every secret-bound URL
 * on its saved origin (the same rule as a save). Probes never use the
 * shared OAuth token cache. Each call is audited by reference only.
 */
@Controller({ path: 'admin/integrations', version: '1' })
export class CustomApiTestController {
  private readonly logger = new Logger(CustomApiTestController.name);

  constructor(
    private readonly integrations: IntegrationsService,
    private readonly drivers: IntegrationDriverRegistry,
    private readonly env: EnvService,
    private readonly audit: AuditLogService,
  ) {}

  @Post('custom-api/draft-test')
  @RequirePermission('integration.manage')
  @InteractiveOnly()
  @Throttle({ global: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  async testDraft(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(customApiTestRequestSchema)) body: CustomApiTestRequest,
    @Req() req: Request,
  ): Promise<CustomApiTestResponse> {
    return this.probe(user, req, null, body, body.secret ?? {});
  }

  @Post(':id/custom-api/test')
  @RequirePermission('integration.manage')
  @InteractiveOnly()
  @Throttle({ global: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  async testSaved(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(customApiTestRequestSchema)) body: CustomApiTestRequest,
    @Req() req: Request,
  ): Promise<CustomApiTestResponse> {
    const saved = await this.integrations.loadSavedCredentials(id);
    if (saved.driver !== CUSTOM_API_DRIVER_KEY) {
      throw new BadRequestException('This integration is not a Custom API integration.');
    }
    let secret: Record<string, unknown>;
    if (body.secret) {
      secret = body.secret;
    } else {
      // The saved secret may only go to the hosts it was saved for. With no
      // saved values (no authentication) there is nothing to send.
      const descriptor = this.drivers.describe(CUSTOM_API_DRIVER_KEY);
      if (
        Object.keys(saved.secret ?? {}).length > 0 &&
        secretBoundOriginsChanged(descriptor, saved.config, body.definition as unknown as Record<string, unknown>)
      ) {
        throw new BadRequestException(SECRET_BOUND_ORIGIN_MESSAGE);
      }
      secret = saved.secret ?? {};
    }
    return this.probe(user, req, id, body, secret);
  }

  private async probe(
    user: AuthedUser,
    req: Request,
    integrationId: string | null,
    body: CustomApiTestRequest,
    secret: Record<string, unknown>,
  ): Promise<CustomApiTestResponse> {
    const correlationId = randomUUID();
    let response: CustomApiTestResponse;
    try {
      const outcome = await runProbe({
        definition: body.definition,
        secret,
        section: body.section,
        orgId: body.orgId,
        http: {
          timeoutMs: this.env.values.INTEGRATION_HTTP_TIMEOUT_MS,
          maxRetries: this.env.values.INTEGRATION_HTTP_MAX_RETRIES,
          backoffMs: this.env.values.INTEGRATION_HTTP_BACKOFF_MS,
        },
        correlationId,
      });
      response = { ...outcome, correlationId } as CustomApiTestResponse;
    } catch (e) {
      // Not a known driver failure: fixed text out, the error class to the log.
      this.logger.error({ correlationId, integrationId, err: e instanceof Error ? e.name : typeof e }, 'custom api test failed');
      response = { ok: false, section: body.section, message: 'The test failed. Try again, or check the server log with the reference.', status: null, correlationId };
    }
    await this.audit.log({
      actorId: user.id,
      action: AUDIT_ACTIONS.integration.customApiTest,
      entityType: 'Integration',
      entityId: integrationId,
      ip: meta(req).ip,
      userAgent: meta(req).userAgent,
      before: null,
      after: response.ok
        ? { driver: CUSTOM_API_DRIVER_KEY, section: body.section, outcome: 'ok', recordCount: response.recordCount, correlationId }
        : { driver: CUSTOM_API_DRIVER_KEY, section: body.section, outcome: 'failed', status: response.status, correlationId },
    });
    return response;
  }
}
