import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  stepUpVerifySchema,
  type StepUpStatus,
  type StepUpVerifyInput,
} from '@weavestream/shared';
import { AuthedOnly } from '../../rbac/require-permission.decorator.js';
import {
  CurrentUser,
  type AuthedUser,
} from '../../common/current-user.decorator.js';
import { ZodBody } from '../../common/zod-validation.pipe.js';
import { requestMetaOf } from '../../common/request-meta.js';
import { StepUpService } from './step-up.service.js';

/**
 * Step-up (re-authentication) endpoints.
 *
 * Both routes are `@AuthedOnly()` — they require a valid (non-MFA-
 * pending) session but no specific capability, and carry no
 * `@RequireStepUp()` so `StepUpGuard` lets them through (avoids a
 * chicken-and-egg where you'd need step-up to perform step-up).
 */
@Controller({ path: 'auth/step-up', version: '1' })
export class StepUpController {
  constructor(private readonly stepUp: StepUpService) {}

  /**
   * Current step-up state for the calling session. The web app calls
   * this before a plain-navigation download (which can't surface a 403
   * cleanly) to decide whether to prompt first. `no-store` because the
   * body is live auth state.
   */
  @AuthedOnly()
  @Get()
  @Header('Cache-Control', 'no-store')
  async status(@CurrentUser() user: AuthedUser): Promise<StepUpStatus> {
    return this.stepUp.status(user);
  }

  /**
   * Re-confirm a credential to open the step-up window for this session.
   * Throttled and lockout-protected like the login/MFA endpoints.
   */
  @AuthedOnly()
  @Throttle({ global: { limit: 10, ttl: 60_000 } })
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verify(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(stepUpVerifySchema)) dto: StepUpVerifyInput,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    return this.stepUp.verify(user, dto.code, requestMetaOf(req));
  }
}
