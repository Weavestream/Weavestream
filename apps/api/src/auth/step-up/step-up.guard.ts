import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AuthedUser } from '../../common/current-user.decorator.js';
import {
  REQUIRE_STEP_UP_KEY,
  type RequireStepUpMetadata,
} from './require-step-up.decorator.js';
import { StepUpService } from './step-up.service.js';
import { StepUpRequiredException } from './step-up-required.exception.js';

/**
 * Global guard that enforces `@RequireStepUp()`.
 *
 * Registered as an APP_GUARD AFTER `PermissionGuard`, so the caller has
 * already passed RBAC by the time this runs — step-up is a second factor
 * on top of an authorized action. Routes without `@RequireStepUp()`
 * metadata fall straight through (no behaviour change).
 */
@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly stepUp: StepUpService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<RequireStepUpMetadata | undefined>(
      REQUIRE_STEP_UP_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (meta === undefined) return true; // not a step-up route

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthedUser }>();

    // Conditional routes (e.g. only when dumping plaintext passwords).
    if (meta.when && !(await meta.when(req))) return true;

    const user = req.user;
    if (!user) {
      // AuthGuard should already have rejected an unauthenticated request.
      throw new ForbiddenException('Unauthenticated');
    }

    // An MFA-pending session can never satisfy step-up; treat as a
    // required challenge so the client prompts rather than silently 403s.
    if (user.mfaPending || !(await this.stepUp.isVerified(user.sessionId))) {
      throw new StepUpRequiredException(await this.stepUp.requiredFactor(user.id));
    }
    return true;
  }
}
