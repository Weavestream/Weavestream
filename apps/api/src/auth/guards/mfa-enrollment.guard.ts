import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
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
      throw new ForbiddenException('MFA enrollment required');
    }

    if (user.mfaPending) {
      // Already enrolled but haven't verified this session yet.
      if (mfaSetupAllowed) return true;
      if (req.method === 'POST' && req.path.endsWith('/auth/logout')) return true;
      throw new ForbiddenException('MFA challenge required');
    }

    return true;
  }
}
