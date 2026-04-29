import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  changePasswordSchema,
  updateMeSchema,
  userUiPreferencesUpdateSchema,
  type ChangePasswordInput,
  type UpdateMeInput,
  type UserUiPreferencesUpdate,
} from '@weavestream/shared';
import { MeService } from './me.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { AuthedOnly } from '../rbac/require-permission.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { setUiCookie } from '../auth/cookies.js';
import { EnvService } from '../config/env.service.js';
import { ipOf, userAgentOf as uaOf } from '../common/request-meta.js';

@Controller({ path: 'me', version: '1' })
@AuthedOnly()
export class MeController {
  constructor(
    private readonly me: MeService,
    private readonly env: EnvService,
  ) {}

  @Get()
  async profile(@CurrentUser() user: AuthedUser) {
    return this.me.profile(user.id);
  }

  @Get('sessions')
  async sessions(@CurrentUser() user: AuthedUser) {
    return this.me.listSessions(user.id, user.sessionId);
  }

  @Patch()
  async update(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(updateMeSchema)) dto: UpdateMeInput,
    @Req() req: Request,
  ) {
    return this.me.update(user, dto, { ip: ipOf(req), userAgent: uaOf(req) });
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(changePasswordSchema)) dto: ChangePasswordInput,
    @Req() req: Request,
  ) {
    return this.me.changePassword(user, dto, { ip: ipOf(req), userAgent: uaOf(req) });
  }

  @Post('sessions/revoke-others')
  @HttpCode(HttpStatus.OK)
  async revokeOthers(@CurrentUser() user: AuthedUser, @Req() req: Request) {
    return this.me.revokeOtherSessions(user, { ip: ipOf(req), userAgent: uaOf(req) });
  }

  /**
   * Phase 9b.1 — persist the user's appearance preferences (theme +
   * accent) and mirror them into the non-HttpOnly `ws_ui` cookie so the
   * Next.js root layout can apply them on first byte.
   */
  @Patch('preferences')
  async updatePreferences(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(userUiPreferencesUpdateSchema))
    dto: UserUiPreferencesUpdate,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const updated = await this.me.updatePreferences(user, dto, {
      ip: ipOf(req),
      userAgent: uaOf(req),
    });
    setUiCookie(res, this.env, updated.uiTheme, updated.uiAccent);
    return { preferences: updated };
  }
}

