import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { UserRole } from '@weavestream/shared';

export interface AuthedUser {
  id: string;
  email: string;
  role: UserRole;
  sessionId: string;
  mfaEnforcementCompletedAt: Date | null;
  mfaPending: boolean;
}

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthedUser | undefined => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthedUser }>();
    return req.user;
  },
);
