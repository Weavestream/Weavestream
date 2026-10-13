import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { microsoftReportNamesActionSchema, type MicrosoftReportNamesAction } from '@weavestream/shared';
import { ZodBody } from '../../common/zod-validation.pipe.js';
import { CurrentUser, type AuthedUser } from '../../common/current-user.decorator.js';
import { RequirePermission } from '../../rbac/require-permission.decorator.js';
import { RequireStepUp } from '../../auth/step-up/require-step-up.decorator.js';
import { InteractiveOnly } from '../../auth/interactive-only.decorator.js';
import { requestMetaOf as meta } from '../../common/request-meta.js';
import { MicrosoftReportNamesService } from './microsoft-report-names.service.js';

/**
 * Microsoft 365 report concealment choice. Interactive sessions only; a
 * change needs a fresh step-up. The POST is the only route that can write
 * to a customer tenant, and only the one report setting.
 *
 * The choice is per connection (client tenant).
 *
 *   - GET  /admin/integrations/:id/connections/:connectionId/microsoft/report-names   current value + choice
 *   - POST /admin/integrations/:id/connections/:connectionId/microsoft/report-names   { action: show | conceal | keep }
 */
@Controller({ path: 'admin/integrations', version: '1' })
@InteractiveOnly()
export class MicrosoftReportNamesController {
  constructor(private readonly reportNames: MicrosoftReportNamesService) {}

  @Get(':id/connections/:connectionId/microsoft/report-names')
  @RequirePermission('integration.manage')
  @Throttle({ global: { limit: 20, ttl: 60_000 } })
  status(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('connectionId', new ParseUUIDPipe()) connectionId: string,
  ) {
    return this.reportNames.status(id, connectionId);
  }

  @Post(':id/connections/:connectionId/microsoft/report-names')
  @RequirePermission('integration.manage')
  @RequireStepUp()
  @Throttle({ global: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  apply(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('connectionId', new ParseUUIDPipe()) connectionId: string,
    @Body(new ZodBody(microsoftReportNamesActionSchema)) dto: MicrosoftReportNamesAction,
    @Req() req: Request,
  ) {
    return this.reportNames.apply(user, id, connectionId, dto, meta(req));
  }
}
