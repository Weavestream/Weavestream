import { Body, Controller, Get, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  testEmailSettingsSchema,
  updateEmailSettingsSchema,
  type TestEmailSettingsInput,
  type UpdateEmailSettingsInput,
} from '@weavestream/shared';
import { EmailSettingsService } from './email-settings.service.js';
import { EmailService } from './email.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { requestMetaOf } from '../common/request-meta.js';

@Controller({ path: 'settings/email', version: '1' })
export class EmailSettingsController {
  constructor(
    private readonly settings: EmailSettingsService,
    private readonly email: EmailService,
  ) {}

  @Get()
  @RequirePermission('settings.manage')
  async get() {
    return this.settings.get();
  }

  @Patch()
  @RequirePermission('settings.manage')
  async update(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(updateEmailSettingsSchema)) dto: UpdateEmailSettingsInput,
    @Req() req: Request,
  ) {
    return this.settings.update(user, dto, requestMetaOf(req));
  }

  @Post('test')
  @RequirePermission('settings.manage')
  async test(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(testEmailSettingsSchema)) dto: TestEmailSettingsInput,
    @Req() req: Request,
  ) {
    return this.email.sendTest(user, dto, requestMetaOf(req));
  }
}
