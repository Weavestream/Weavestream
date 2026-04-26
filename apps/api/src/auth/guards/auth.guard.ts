import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { IS_PUBLIC_KEY } from '../../common/public.decorator.js';
import { TokenService } from '../token.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EnvService } from '../../config/env.service.js';
import { cookieNames, setAccessCookie } from '../cookies.js';
import type { AuthedUser } from '../../common/current-user.decorator.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthedUser }>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const names = cookieNames(this.env);
    const jwt = (req.signedCookies[names.access] ?? req.cookies[names.access]) as
      | string
      | undefined;

    // Try the short-lived access token first; if missing or invalid, fall
    // through to silent refresh using the 30-day signed session cookie.
    // This keeps the user logged in across API restarts and across JWT
    // expirations without forcing them back through /login (each forced
    // re-login leaves a stale Session row and blows up their session list).
    let payload = jwt ? await this.tokens.verifyAccessToken(jwt) : null;

    if (!payload) {
      payload = await this.silentRefresh(req, res);
      if (!payload) throw new UnauthorizedException();
    }

    const [session, user] = await Promise.all([
      this.prisma.session.findUnique({ where: { id: payload.sid } }),
      this.prisma.user.findUnique({ where: { id: payload.sub } }),
    ]);
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      throw new UnauthorizedException();
    }
    if (!user || !user.isActive) throw new UnauthorizedException();

    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      globalAccess: user.globalAccess ?? null,
      platformCapabilities: user.platformCapabilities ?? [],
      sessionId: session.id,
      mfaEnforcementCompletedAt: user.mfaEnforcementCompletedAt,
      mfaPending: session.mfaPending,
    };
    return true;
  }

  /**
   * When the access JWT is missing or expired, look up the live session
   * via the signed refresh cookie. If the session is still valid, mint a
   * fresh access JWT, drop it back into the response as a Set-Cookie,
   * and return the new payload so the rest of the guard can proceed
   * without the caller noticing an outage. No audit entry is written —
   * that stays on the explicit `POST /auth/refresh` path which is kept
   * for clients that want to eagerly rotate.
   */
  private async silentRefresh(
    req: Request,
    res: Response,
  ): Promise<{ sub: string; sid: string; role: string } | null> {
    const names = cookieNames(this.env);
    const refreshCookie = req.signedCookies[names.session] as string | undefined;
    if (!refreshCookie) return null;
    const refreshHash = this.tokens.hashRefreshToken(refreshCookie);
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: refreshHash },
      include: { user: true },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt < new Date() ||
      !session.user.isActive
    ) {
      return null;
    }
    const accessToken = await this.tokens.issueAccessToken({
      sub: session.userId,
      sid: session.id,
      role: session.user.role,
    });
    setAccessCookie(res, this.env, accessToken);
    return { sub: session.userId, sid: session.id, role: session.user.role };
  }
}
