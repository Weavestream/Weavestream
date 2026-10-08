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
import { ApiKeyService } from '../api-key.service.js';
import { AuthService } from '../auth.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EnvService } from '../../config/env.service.js';
import { SettingsService } from '../../settings/settings.service.js';
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
    private readonly apiKeys: ApiKeyService,
    private readonly settings: SettingsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthedUser }>();
    const res = ctx.switchToHttp().getResponse<Response>();

    // Programmatic callers present `Authorization: Bearer ws_<keyId>_<secret>`
    // instead of the cookie pair. Checked before the cookie path so a browser
    // session is never silently refreshed on an API-key request. A dead or
    // malformed `ws_` token fails closed rather than falling through to
    // cookies. A Bearer that is not ours (an SSO proxy's JWT in front of the
    // app) is ignored entirely, so it cannot log every browser out.
    const bearer = this.bearerOf(req);
    if (bearer) return this.authenticateApiKey(req, bearer);

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

  /** Extract a bearer credential, or undefined when the header is absent. */
  private bearerOf(req: Request): string | undefined {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return undefined;
    const [scheme, ...rest] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer') return undefined;
    const value = rest.join(' ').trim();
    return value.startsWith('ws_') ? value : undefined;
  }

  /**
   * Authenticate an API-key principal.
   *
   * The resulting {@link AuthedUser} is deliberately the *same shape* a cookie
   * session produces, so every downstream guard, the permission engine, tenant
   * scoping, and the audit interceptor keep working untouched — they all key
   * off `req.user` and must not learn about a second principal kind.
   *
   * Two fields carry the difference:
   *  - `apiKeyId` marks the principal as programmatic. `ApiKeySurfaceGuard`
   *    uses it to keep tokens out of session/MFA/password surfaces, and
   *    `CsrfGuard` uses it to skip a check that only defends cookie auth.
   *  - `sessionId` is set to the key's id. It is an opaque correlation handle
   *    (see the CLAUDE.md §2 clarification — a Session row id is not a
   *    credential), so audit rows stay attributable. Nothing ever writes a
   *    step-up marker under it, so `StepUpGuard` refuses every
   *    `@RequireStepUp()` route to a token. Password reveal is NOT one of
   *    those routes: it is gated by `@VaultReveal()` + the key's
   *    `allowPasswordReveal` flag in `ApiKeySurfaceGuard`, and nothing else.
   */
  private async authenticateApiKey(
    req: Request & { user?: AuthedUser },
    presented: string,
  ): Promise<boolean> {
    // Instance switch first, so a disabled instance never even looks a key
    // up. Off refuses every key with the same bare 401 as a bad key: the
    // caller learns nothing about whether its key is otherwise valid.
    if (!(await this.settings.apiKeysEnabled())) throw new UnauthorizedException();

    const key = await this.apiKeys.verify(presented);
    if (!key) throw new UnauthorizedException();

    const user = await this.prisma.user.findUnique({
      where: { id: key.userId },
    });
    if (!user || !user.isActive) throw new UnauthorizedException();

    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      globalAccess: user.globalAccess ?? null,
      platformCapabilities: user.platformCapabilities ?? [],
      sessionId: key.id,
      mfaEnforcementCompletedAt: user.mfaEnforcementCompletedAt,
      // A key is itself the second factor: it is high-entropy, revocable, and
      // was minted by an already-MFA-enrolled human. Leaving this true would
      // deadlock every token behind an interactive TOTP prompt.
      mfaPending: false,
      apiKeyId: key.id,
      apiKeyAllowPasswordReveal: key.allowPasswordReveal,
      apiKeyAllowWrite: key.allowWrite,
    };

    // Bookkeeping only — a failed write must not fail an authenticated
    // request, so this is intentionally not awaited and swallows its own
    // rejection (CLAUDE.md §6: the empty catch is explained, not silent).
    void this.apiKeys.touch(key).catch(() => {
      /* lastUsedAt is advisory; losing one update is not worth a 500. */
    });

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
