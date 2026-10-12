import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import {
  startIntegrationConnectionSchema,
  updateIntegrationOAuthAppSchema,
  type StartIntegrationConnectionInput,
  type UpdateIntegrationOAuthAppInput,
} from '@weavestream/shared';
import { ZodBody } from '../../common/zod-validation.pipe.js';
import { CurrentUser, type AuthedUser } from '../../common/current-user.decorator.js';
import { RequirePermission } from '../../rbac/require-permission.decorator.js';
import { RequireStepUp } from '../../auth/step-up/require-step-up.decorator.js';
import { InteractiveOnly } from '../../auth/interactive-only.decorator.js';
import { requestMetaOf as meta } from '../../common/request-meta.js';
import { IntegrationOAuthAppService } from './integration-oauth-app.service.js';
import { IntegrationOAuthService, type OAuthCallbackQuery } from './integration-oauth.service.js';
import { OAuthCallbackRedirectFilter } from './oauth-callback-redirect.filter.js';

/**
 * The OAuth app (App tab) and client-tenant connections (Connections tab)
 * of integrations whose driver declares `oauth`. Interactive sessions only:
 * an API key can never read the app, start or complete a grant. Writing
 * the app, connecting and disconnecting need a fresh step-up; all of it is
 * audited.
 *
 *   - GET  /admin/integrations/:id/oauth-app                         app (secret masked)
 *   - PUT  /admin/integrations/:id/oauth-app                         save app
 *   - POST /admin/integrations/:id/oauth-app/check                   Check setup (app only)
 *   - GET  /admin/integrations/:id/connections                       connections
 *   - POST /admin/integrations/:id/connections/start                 authorize URL ({ connectionId? } = reconnect)
 *   - POST /admin/integrations/:id/connections/:connectionId/disconnect  revoke + delete
 *   - GET  /admin/integrations/oauth/callback                        provider redirect target
 */
@Controller({ path: 'admin/integrations', version: '1' })
@InteractiveOnly()
export class IntegrationOAuthController {
  constructor(
    private readonly oauth: IntegrationOAuthService,
    private readonly apps: IntegrationOAuthAppService,
  ) {}

  @Get('oauth/callback')
  @RequirePermission('integration.manage')
  @UseFilters(OAuthCallbackRedirectFilter)
  async callback(
    @CurrentUser() user: AuthedUser,
    @Query() query: OAuthCallbackQuery,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    res.redirect(302, await this.oauth.callback(user, query ?? {}, meta(req)));
  }

  @Get(':id/oauth-app')
  @RequirePermission('integration.manage')
  getApp(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.apps.get(id);
  }

  @Put(':id/oauth-app')
  @RequirePermission('integration.manage')
  @RequireStepUp()
  updateApp(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(updateIntegrationOAuthAppSchema)) dto: UpdateIntegrationOAuthAppInput,
    @Req() req: Request,
  ) {
    return this.apps.update(user, id, dto, meta(req));
  }

  /** Check setup: verifies the saved client against the provider (read-only). */
  @Post(':id/oauth-app/check')
  @RequirePermission('integration.manage')
  @Throttle({ global: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  checkApp(@CurrentUser() user: AuthedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.apps.check(user, id, meta(req));
  }

  @Get(':id/connections')
  @RequirePermission('integration.manage')
  listConnections(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.oauth.listConnections(id);
  }

  @Post(':id/connections/start')
  @RequirePermission('integration.manage')
  @RequireStepUp()
  @HttpCode(200)
  start(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(startIntegrationConnectionSchema)) dto: StartIntegrationConnectionInput,
  ) {
    return this.oauth.start(user, id, dto);
  }

  @Post(':id/connections/:connectionId/disconnect')
  @RequirePermission('integration.manage')
  @RequireStepUp()
  @HttpCode(204)
  async disconnect(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('connectionId', new ParseUUIDPipe()) connectionId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.oauth.disconnect(user, id, connectionId, meta(req));
  }
}
