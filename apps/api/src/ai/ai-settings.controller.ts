import { Body, Controller, Get, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  testAiSettingsSchema,
  updateAiSettingsSchema,
  type TestAiSettingsInput,
  type UpdateAiSettingsInput,
} from '@weavestream/shared';
import { AiSettingsService } from './ai-settings.service.js';
import { AiService } from './ai.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { RequireStepUp } from '../auth/step-up/require-step-up.decorator.js';
import { requestMetaOf } from '../common/request-meta.js';

@Controller({ path: 'settings/ai', version: '1' })
export class AiSettingsController {
  constructor(
    private readonly settings: AiSettingsService,
    private readonly ai: AiService,
  ) {}

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
    @Body(new ZodBody(updateAiSettingsSchema)) dto: UpdateAiSettingsInput,
    @Req() req: Request,
  ) {
    return this.settings.update(user, dto, requestMetaOf(req));
  }

  @Post('test')
  @RequirePermission('settings.manage')
  async test(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(testAiSettingsSchema)) dto: TestAiSettingsInput,
    @Req() req: Request,
  ) {
    return this.ai.runTest(user, requestMetaOf(req), dto);
  }
}
