import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  alertConfigInputSchema,
  alertConfigPatchSchema,
  alertTestSchema,
  type AlertConfig,
  type AlertConfigInput,
  type AlertConfigPatch,
  type AlertTestInput,
} from '@weavestream/shared';
import { AlertsService } from './alerts.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { requestMetaOf } from '../common/request-meta.js';

@Controller({ path: 'alerts', version: '1' })
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  @RequirePermission('alert.manage')
  async list(): Promise<AlertConfig[]> {
    return this.alerts.list();
  }

  @Get(':id')
  @RequirePermission('alert.manage')
  async get(@Param('id') id: string): Promise<AlertConfig> {
    return this.alerts.getById(id);
  }

  @Post()
  @RequirePermission('alert.manage')
  async create(
    @CurrentUser() actor: AuthedUser,
    @Body(new ZodBody(alertConfigInputSchema)) dto: AlertConfigInput,
    @Req() req: Request,
  ): Promise<AlertConfig> {
    return this.alerts.create(actor, dto, requestMetaOf(req));
  }

  @Patch(':id')
  @RequirePermission('alert.manage')
  async update(
    @CurrentUser() actor: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(alertConfigPatchSchema)) dto: AlertConfigPatch,
    @Req() req: Request,
  ): Promise<AlertConfig> {
    return this.alerts.update(actor, id, dto, requestMetaOf(req));
  }

  @Delete(':id')
  @RequirePermission('alert.manage')
  async archive(
    @CurrentUser() actor: AuthedUser,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    return this.alerts.archive(actor, id, requestMetaOf(req));
  }

  @Post(':id/test')
  @RequirePermission('alert.manage')
  async test(
    @CurrentUser() actor: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(alertTestSchema)) dto: AlertTestInput,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    return this.alerts.sendTest(actor, id, dto, requestMetaOf(req));
  }
}
