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
  /**
   * Set when the principal authenticated with an API key rather than a
   * browser session. Presence — not absence — is the signal: guards that
   * must treat programmatic callers differently check this, so a new cookie
   * field can never accidentally opt a token into an interactive-only path.
   */
  apiKeyId?: string;
  /**
   * Whether this key may decrypt stored credentials. Default false; opting in
   * is a deliberate act at mint time. Absent for interactive principals, who
   * are governed by the `password.reveal` permission as before.
   */
  apiKeyAllowPasswordReveal?: boolean;
  /**
   * Whether this key may change data. Default false (read-only); opting in is
   * a deliberate act at mint time. Absent for interactive principals.
   */
  apiKeyAllowWrite?: boolean;
}

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthedUser | undefined => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthedUser }>();
    return req.user;
  },
);
