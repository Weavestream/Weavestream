import { Body, Controller, ForbiddenException, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ensureResourceMatchFieldSchema, type EnsureResourceMatchFieldInput } from '@weavestream/shared';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { requestMetaOf as meta } from '../common/request-meta.js';
import { PermissionService } from '../rbac/permission.service.js';
import { IntegrationMatchFieldService } from './integration-match-field.service.js';

/** Map layouts: create the match field on an existing layout (see IntegrationMatchFieldService). */
@Controller({ path: 'admin/integrations', version: '1' })
export class IntegrationMatchFieldController {
  constructor(
    private readonly matchFields: IntegrationMatchFieldService,
    private readonly permissions: PermissionService,
  ) {}

  @Post(':id/resources/:resourceKey/match-field')
  @RequirePermission('integration.manage')
  @HttpCode(200)
  async ensureMatchField(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('resourceKey') resourceKey: string,
    @Body(new ZodBody(ensureResourceMatchFieldSchema)) dto: EnsureResourceMatchFieldInput,
    @Req() req: Request,
  ) {
    // It edits a global layout, so it also needs what the layout builder needs.
    await assertCanManageLayouts(this.permissions, user);
    return this.matchFields.ensureMatchField(user, id, resourceKey, dto.assetLayoutId, meta(req), dto.sourceField);
  }
}

/** Second gate for integration routes that create or edit global layouts. */
export async function assertCanManageLayouts(permissions: PermissionService, user: AuthedUser): Promise<void> {
  const decision = await permissions.can(user, 'layout.manage.global');
  if (!decision.allowed) throw new ForbiddenException('You need permission to manage asset layouts.');
}
