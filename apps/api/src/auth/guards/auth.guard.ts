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
import { AuthService } from '../auth.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EnvService } from '../../config/env.service.js';
import { cookieNames, setAccessCookie, setSessionCookie } from '../cookies.js';
import { ipOf, userAgentOf } from '../../common/request-meta.js';
import type { AuthedUser } from '../../common/current-user.decorator.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly auth: AuthService,
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
    // Only trust the signed read. cookie-parser returns the verified value
    // here when the signature checks out, `false` when the cookie was sent
    // with an `s:` prefix but a bad signature, and `undefined` when no
    // signed cookie was sent at all. Falling back to `req.cookies` would
    // accept a raw attacker-controlled cookie of the same name, defeating
    // the cookie-signing layer (CWE-807 / CWE-290).
    const signed = req.signedCookies[names.access];
    const jwt = typeof signed === 'string' ? signed : undefined;

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
   * When the access JWT is missing or expired, rotate the signed refresh
   * cookie via {@link AuthService.rotateRefresh}: if the session is still
   * valid it mints a fresh access JWT (and a new refresh token), drops both
   * back into the response as Set-Cookies, and returns the payload so the
   * rest of the guard proceeds without the caller noticing an outage.
   *
   * Rotation runs here too, not just on the explicit `POST /auth/refresh`,
   * so a stolen refresh cookie cannot dodge rotation by riding the silent
   * path. No routine audit entry is written (`audit: false`) — this fires
   * roughly every access-token TTL per active user and would flood the log;
   * the reuse/theft event is still audited inside `rotateRefresh`.
   */
  private async silentRefresh(
    req: Request,
    res: Response,
  ): Promise<{ sub: string; sid: string; role: string } | null> {
    const names = cookieNames(this.env);
    const refreshCookie = req.signedCookies[names.session] as string | undefined;
    if (!refreshCookie) return null;
    const out = await this.auth.rotateRefresh(
      refreshCookie,
      ipOf(req),
      userAgentOf(req),
      { audit: false },
    );
    if (!out) return null;
    setAccessCookie(res, this.env, out.accessToken);
    // Rotation: persist the new refresh token. Absent on the concurrent-
    // refresh grace path, where the winning request already set the cookie.
    if (out.refreshToken) setSessionCookie(res, this.env, out.refreshToken);
    return out.payload;
  }
}
