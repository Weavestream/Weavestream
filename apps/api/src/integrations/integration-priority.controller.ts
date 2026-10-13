import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  updateIntegrationPrioritySchema,
  type UpdateIntegrationPriorityInput,
} from '@weavestream/shared';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { RequireStepUp } from '../auth/step-up/require-step-up.decorator.js';
import { InteractiveOnly } from '../auth/interactive-only.decorator.js';
import { requestMetaOf } from '../common/request-meta.js';
import { IntegrationPriorityService } from './integration-priority.service.js';

/** Which integration's values win when several fill the same asset. */
@Controller({ path: 'settings/integration-priority', version: '1' })
export class IntegrationPriorityController {
  constructor(private readonly priority: IntegrationPriorityService) {}

  @Get()
  @RequirePermission('settings.manage')
  get() {
    return this.priority.get();
  }

  @Put()
  @RequirePermission('settings.manage')
  @RequireStepUp()
  @InteractiveOnly()
  update(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(updateIntegrationPrioritySchema)) dto: UpdateIntegrationPriorityInput,
    @Req() req: Request,
  ) {
    return this.priority.update(user, dto, requestMetaOf(req));
  }
}
