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
import { Throttle } from '@nestjs/throttler';
import { MeService } from './me.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { AuthedOnly } from '../rbac/require-permission.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { RequireStepUp } from '../auth/step-up/require-step-up.decorator.js';
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
  // Edge-level cap on the current-password re-check, parity with the
  // login / MFA / step-up endpoints (the service also enforces a
  // per-user lockout counter). Defends against a stolen live session
  // grinding the password to set a new one for persistence.
  @Throttle({ global: { limit: 10, ttl: 60_000 } })
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

  @Post('mfa/backup-codes/regenerate')
  @HttpCode(HttpStatus.OK)
  // A fresh code set is a durable persistence credential — ten single-use
  // bypasses of the second factor — so it needs a valid recent step-up,
  // matching admin reset-MFA (`users.controller.ts`).
  //
  // Note this is NOT a per-action prompt: `StepUpGuard` accepts any proof
  // still inside the session's step-up window (`STEP_UP_TTL_SEC`, default
  // 900s, max 3600s), so a session that stepped up moments ago for some
  // other sensitive action regenerates without being challenged again.
  // That is the deliberate, codebase-wide behaviour; if regeneration ever
  // needs to prompt every time, that requires a per-action proof in
  // `StepUpService`, which is session-keyed today.
  //
  // The edge-level cap matches change-password / step-up / MFA verify. No
  // dedicated lockout counter: this handler verifies no credential inline,
  // so the grinding surface is `POST /auth/step-up/verify`, which already
  // has its own throttle and a per-user `stepup:fail:` counter.
  @Throttle({ global: { limit: 10, ttl: 60_000 } })
  @RequireStepUp()
  async regenerateMfaBackupCodes(@CurrentUser() user: AuthedUser, @Req() req: Request) {
    return this.me.regenerateMfaBackupCodes(user, {
      ip: ipOf(req),
      userAgent: uaOf(req),
    });
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

