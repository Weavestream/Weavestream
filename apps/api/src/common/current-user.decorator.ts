import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { GlobalAccess, PlatformCapability, UserRole } from '@weavestream/shared';

export interface AuthedUser {
  id: string;
  email: string;
  role: UserRole;
  /** OPERATOR-only; null for SUPER_ADMIN / CONTRACTOR / CLIENT_USER. */
  globalAccess: GlobalAccess | null;
  /**
   * Granular platform-admin capabilities. Empty for SUPER_ADMIN
   * (the permission engine treats SA as implicitly capable),
   * CONTRACTOR, and CLIENT_USER.
   */
  platformCapabilities: PlatformCapability[];
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
