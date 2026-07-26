import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  MFA_CHALLENGE_REQUIRED_CODE,
  MFA_ENROLLMENT_REQUIRED_CODE,
} from '@weavestream/shared';
import {
  IS_PUBLIC_KEY,
  MFA_SETUP_ALLOWED_KEY,
} from '../../common/public.decorator.js';
import type { AuthedUser } from '../../common/current-user.decorator.js';

@Injectable()
export class MfaEnrollmentGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const mfaSetupAllowed = this.reflector.getAllAndOverride<boolean>(
      MFA_SETUP_ALLOWED_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthedUser }>();
    const user = req.user;
    if (!user) return true; // AuthGuard will have already rejected.

    if (user.mfaEnforcementCompletedAt === null) {
      // Not yet enrolled — block everything except explicitly MFA-setup routes
      // and logout, which needs a carve-out below.
      if (mfaSetupAllowed) return true;
      if (req.method === 'POST' && req.path.endsWith('/auth/logout')) return true;
      // `code` rides along as an RFC-7807 extension member so clients can
      // route on a stable identifier instead of matching this sentence.
      throw new ForbiddenException({
        message: 'MFA enrollment required',
        code: MFA_ENROLLMENT_REQUIRED_CODE,
      });
    }

    if (user.mfaPending) {
      // Already enrolled but haven't verified this session yet.
      if (mfaSetupAllowed) return true;
      if (req.method === 'POST' && req.path.endsWith('/auth/logout')) return true;
      throw new ForbiddenException({
        message: 'MFA challenge required',
        code: MFA_CHALLENGE_REQUIRED_CODE,
      });
    }

    return true;
  }
}
