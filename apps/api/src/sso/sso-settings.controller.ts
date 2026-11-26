import { Body, Controller, Get, Patch, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  testSsoSettingsSchema,
  updateSsoSettingsSchema,
  type TestSsoSettingsInput,
  type UpdateSsoSettingsInput,
} from '@weavestream/shared';
import { SsoSettingsService } from './sso-settings.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { RequireStepUp } from '../auth/step-up/require-step-up.decorator.js';
import { InteractiveOnly } from '../auth/interactive-only.decorator.js';
import { requestMetaOf } from '../common/request-meta.js';

/**
 * Instance-wide single sign-on configuration. Interactive-only as a whole:
 * it holds the identity-provider client secret and the test route makes the
 * server fetch an admin-chosen URL, and no API key or AI connection needs
 * either. The secret is write-only: no response ever carries it.
 */
@Controller({ path: 'settings/sso', version: '1' })
@InteractiveOnly()
export class SsoSettingsController {
  constructor(private readonly settings: SsoSettingsService) {}

  @Get()
  @RequirePermission('settings.manage')
  async get() {
    return this.settings.get();
  }

  @Patch()
  @RequirePermission('settings.manage')
  @RequireStepUp()
  async update(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(updateSsoSettingsSchema)) dto: UpdateSsoSettingsInput,
    @Req() req: Request,
  ) {
    return this.settings.update(user, dto, requestMetaOf(req));
  }

  @Post('test')
  @RequirePermission('settings.manage')
  @Throttle({ global: { limit: 10, ttl: 60_000 } })
  async test(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(testSsoSettingsSchema)) dto: TestSsoSettingsInput,
    @Req() req: Request,
  ) {
    return this.settings.test(user, requestMetaOf(req), dto);
  }
}
