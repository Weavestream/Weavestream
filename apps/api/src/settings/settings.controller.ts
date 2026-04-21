import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import type { Request } from 'express';
import { updateSettingsSchema, type UpdateSettingsInput } from '@weavestream/shared';
import { SettingsService } from './settings.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import {
  AuthedOnly,
  RequirePermission,
} from '../rbac/require-permission.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';

@Controller({ path: 'settings', version: '1' })
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /**
   * Read-only. Every authenticated user loads settings once per page
   * render to resolve the workspace chip + tenant term, so this must
   * be fast and cheap — see the 5s in-process cache in SettingsService.
   */
  @Get()
  @AuthedOnly()
  async get() {
    return this.settings.get();
  }

  /**
   * SUPER_ADMIN-only. The permission guard enforces the role check;
   * the Zod schema enforces the shape.
   */
  @Patch()
  @RequirePermission('settings.manage')
  async update(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(updateSettingsSchema)) dto: UpdateSettingsInput,
    @Req() req: Request,
  ) {
    return this.settings.update(user, dto, { ip: ipOf(req), userAgent: uaOf(req) });
  }
}

function ipOf(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]!.trim();
  return req.ip ?? '0.0.0.0';
}
function uaOf(req: Request): string {
  return (req.headers['user-agent'] ?? 'unknown').toString().slice(0, 500);
}
