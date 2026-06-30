import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';
import { CsrfService } from './csrf.service.js';
import { LoginDto } from './dto/login.dto.js';
import { MfaVerifyDto } from './dto/mfa.dto.js';
import { MfaSetupAllowed, Public, SkipCsrf } from '../common/public.decorator.js';
import { AuthedOnly } from '../rbac/require-permission.decorator.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import {
  acceptInviteSchema,
  setupTokenSchema,
  type AcceptInviteInput,
} from '@weavestream/shared';
import { ZodBody, ZodParam } from '../common/zod-validation.pipe.js';
import { EnvService } from '../config/env.service.js';
import {
  cookieNames,
  clearAuthCookies,
  setAccessCookie,
  setCsrfCookie,
  setSessionCookie,
  setUiCookie,
} from './cookies.js';
import { ipOf, userAgentOf } from '../common/request-meta.js';

@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly csrf: CsrfService,
    private readonly env: EnvService,
  ) {}

  @Public()
  @SkipCsrf()
  @Post('csrf')
  @HttpCode(HttpStatus.OK)
  issueCsrf(@Res({ passthrough: true }) res: Response): { csrfToken: string } {
    const token = this.csrf.issue();
    setCsrfCookie(res, this.env, token);
    return { csrfToken: token };
  }

  @Public()
  @Throttle({ global: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = ipOf(req);
    const ua = userAgentOf(req);
    const result = await this.auth.login(dto.email, dto.password, ip, ua);

    setSessionCookie(res, this.env, result.refreshToken);
    setAccessCookie(res, this.env, result.accessToken);
    setCsrfCookie(res, this.env, this.csrf.issue());
    setUiCookie(
      res,
      this.env,
      result.preferences.uiTheme,
      result.preferences.uiAccent,
    );

    return {
      user: result.user,
      mfaSetupRequired: result.mfaSetupRequired,
      mfaChallengeRequired: result.mfaChallengeRequired,
      preferences: result.preferences,
    };
  }

  @MfaSetupAllowed()
  @Post('mfa/enroll')
  @HttpCode(HttpStatus.OK)
  async enrollMfa(
    @CurrentUser() user: AuthedUser,
    @Req() req: Request,
  ) {
    return this.auth.enrollMfa(user, ipOf(req), userAgentOf(req));
  }

  @Public()
  @MfaSetupAllowed()
  @Throttle({ global: { limit: 10, ttl: 60_000 } })
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  async verifyMfa(
    @Body() dto: MfaVerifyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Route is marked @Public() so a user with mfaPending session can call it;
    // we still re-authenticate against the access cookie manually to bind the
    // verify to the caller's session.
    const names = cookieNames(this.env);
    // Only trust the signed read; never fall back to `req.cookies`, which
    // would accept an attacker-set unsigned cookie of the same name and
    // defeat the cookie-signing layer (CWE-807 / CWE-290).
    const signed = req.signedCookies[names.access];
    const jwt = typeof signed === 'string' ? signed : undefined;
    if (!jwt) throw new UnauthorizedException();
    const payload = await this.tokens.verifyAccessToken(jwt);
    if (!payload) throw new UnauthorizedException();

    const asUser: AuthedUser = {
      id: payload.sub,
      email: '', // filled by service lookup
      role: payload.role as AuthedUser['role'],
      // The MFA verify path doesn't consult RBAC at all — the JWT
      // payload only carries the global role. Default the new axes
      // to the safest possible values; the post-verify guards
      // re-load the full user.
      globalAccess: null,
      platformCapabilities: [],
      sessionId: payload.sid,
      mfaEnforcementCompletedAt: null,
      mfaPending: true,
    };
    // AuthService.verifyMfa re-fetches the user row; we only need id/sessionId here.
    const result = await this.auth.verifyMfa(asUser, dto.token, ipOf(req), userAgentOf(req));

    // Rotate CSRF on state transition.
    setCsrfCookie(res, this.env, this.csrf.issue());
    return result.backupCodes
      ? { ok: true, backupCodes: result.backupCodes }
      : { ok: true };
  }

  @AuthedOnly()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @CurrentUser() user: AuthedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(user.sessionId, user.id, ipOf(req), userAgentOf(req));
    clearAuthCookies(res, this.env);
    return { ok: true };
  }

  @AuthedOnly()
  @Get('me')
  async me(@CurrentUser() user: AuthedUser) {
    return this.auth.me(user.id);
  }

  @Public()
  @Get('invite/:token')
  async inviteLookup(@Param('token', new ZodParam(setupTokenSchema)) token: string) {
    return this.auth.inviteLookup(token);
  }

  @Public()
  @SkipCsrf()
  @Throttle({ global: { limit: 5, ttl: 60_000 } })
  @Post('accept-invite')
  @HttpCode(HttpStatus.OK)
  async acceptInvite(
    @Body(new ZodBody(acceptInviteSchema)) dto: AcceptInviteInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = ipOf(req);
    const ua = userAgentOf(req);
    const result = await this.auth.acceptInvite(dto.token, dto.password, ip, ua);

    setSessionCookie(res, this.env, result.refreshToken);
    setAccessCookie(res, this.env, result.accessToken);
    setCsrfCookie(res, this.env, this.csrf.issue());
    setUiCookie(
      res,
      this.env,
      result.preferences.uiTheme,
      result.preferences.uiAccent,
    );

    return {
      user: result.user,
      mfaSetupRequired: result.mfaSetupRequired,
      mfaChallengeRequired: result.mfaChallengeRequired,
      preferences: result.preferences,
    };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const names = cookieNames(this.env);
    const refresh = req.signedCookies[names.session] as string | undefined;
    if (!refresh) throw new UnauthorizedException();
    const out = await this.auth.rotateRefresh(refresh, ipOf(req), userAgentOf(req), {
      audit: true,
    });
    if (!out) {
      clearAuthCookies(res, this.env);
      throw new UnauthorizedException();
    }
    setAccessCookie(res, this.env, out.accessToken);
    // Rotation: persist the new refresh token. Absent on the concurrent-refresh
    // grace path, where the winning request already set the session cookie.
    if (out.refreshToken) setSessionCookie(res, this.env, out.refreshToken);
    return { ok: true };
  }
}
