import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  Logger,
  NotFoundException,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { SsoConfig, SsoErrorCode } from '@weavestream/shared';
import { AuthThrottle, Public } from '../common/public.decorator.js';
import { AuthedOnly } from '../rbac/require-permission.decorator.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { InteractiveOnly } from '../auth/interactive-only.decorator.js';
import { RequireStepUp } from '../auth/step-up/require-step-up.decorator.js';
import { EnvService } from '../config/env.service.js';
import { CsrfService } from '../auth/csrf.service.js';
import {
  clearSsoFlowCookie,
  setAccessCookie,
  setCsrfCookie,
  setSessionCookie,
  setSsoFlowCookie,
  setUiCookie,
  ssoFlowCookieName,
} from '../auth/cookies.js';
import { requestMetaOf } from '../common/request-meta.js';
import { SsoService } from './sso.service.js';

/**
 * Single sign-on (OIDC) endpoints. The browser is only ever sent to one of
 * two places after the callback: `APP_URL` + `/` on success, or
 * `APP_URL` + `/login?sso_error=<code>` with a code from a fixed set. No
 * redirect target is ever taken from the request.
 */
@Controller({ path: 'auth/sso', version: '1' })
export class SsoController {
  private readonly logger = new Logger(SsoController.name);

  constructor(
    private readonly sso: SsoService,
    private readonly env: EnvService,
    private readonly csrf: CsrfService,
  ) {}

  /** Public and secret-free: lets the login page decide what to render. */
  @Public()
  @Get('config')
  @Header('Cache-Control', 'no-store')
  async config(): Promise<SsoConfig> {
    return this.sso.config();
  }

  /** Start sign-in: set the flow cookie and send the browser to the IdP. */
  @Public()
  @AuthThrottle()
  @Get('login')
  @Header('Cache-Control', 'no-store')
  async login(@Res() res: Response): Promise<void> {
    if (!(await this.sso.isEnabled())) return this.redirectError(res, 'failed');
    try {
      const { url, flowCookie } = await this.sso.begin();
      setSsoFlowCookie(res, this.env, flowCookie);
      res.redirect(302, url);
    } catch (err) {
      // Discovery failed (IdP down or misconfigured). Name only: no body.
      this.logger.warn(`SSO login could not start (${err instanceof Error ? err.name : 'unknown'})`);
      this.redirectError(res, 'failed');
    }
  }

  /**
   * Re-authenticate an SSO session at the IdP to open the step-up window.
   * Authenticated, interactive sessions only; the user and session bound into
   * the flow come from the server-side principal, not from the request.
   */
  @AuthedOnly()
  @InteractiveOnly()
  @Throttle({ global: { limit: 10, ttl: 60_000 } })
  @Get('step-up')
  @Header('Cache-Control', 'no-store')
  async stepUp(@CurrentUser() user: AuthedUser, @Res() res: Response): Promise<void> {
    if (user.authMethod !== 'sso') {
      throw new ForbiddenException('This session was not started with single sign-on');
    }
    if (!(await this.sso.isEnabled())) return this.redirectError(res, 'failed');
    try {
      const { url, flowCookie } = await this.sso.begin({
        userId: user.id,
        sessionId: user.sessionId,
      });
      setSsoFlowCookie(res, this.env, flowCookie);
      res.redirect(302, url);
    } catch (err) {
      this.logger.warn(`SSO step-up could not start (${err instanceof Error ? err.name : 'unknown'})`);
      this.redirectError(res, 'failed');
    }
  }

  /**
   * Self-service linking: a signed-in, step-up-confirmed, MFA-complete user
   * binds a provider account to their own user. Interactive sessions only.
   * The answer to "link my identity" for accounts that auto-link refuses
   * (SUPER_ADMIN, platform admins).
   */
  @AuthedOnly()
  @InteractiveOnly()
  @RequireStepUp()
  @Throttle({ global: { limit: 10, ttl: 60_000 } })
  @Get('link')
  @Header('Cache-Control', 'no-store')
  async link(
    @CurrentUser() user: AuthedUser,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!(await this.sso.isEnabled())) return this.redirectMe(res, 'failed');
    // Starting a link is a navigation that a hostile page could trigger.
    // Browsers label such a request; refuse the cross-site ones.
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      throw new ForbiddenException('Start linking from Weavestream');
    }
    try {
      const { url, flowCookie } = await this.sso.beginLink({
        userId: user.id,
        sessionId: user.sessionId,
      });
      setSsoFlowCookie(res, this.env, flowCookie);
      res.redirect(302, url);
    } catch (err) {
      this.logger.warn(`SSO link could not start (${err instanceof Error ? err.name : 'unknown'})`);
      this.redirectMe(res, 'failed');
    }
  }

  @AuthedOnly()
  @InteractiveOnly()
  @RequireStepUp()
  @Throttle({ global: { limit: 10, ttl: 60_000 } })
  @Delete('link')
  @Header('Cache-Control', 'no-store')
  async unlink(@CurrentUser() user: AuthedUser, @Req() req: Request): Promise<{ ok: true }> {
    if (!(await this.sso.isEnabled())) throw new NotFoundException();
    return this.sso.unlink(user.id, requestMetaOf(req));
  }

  @AuthedOnly()
  @InteractiveOnly()
  @Get('link/status')
  @Header('Cache-Control', 'no-store')
  async linkStatus(
    @CurrentUser() user: AuthedUser,
  ): Promise<{ enabled: boolean; linked: boolean; providerName: string }> {
    return this.sso.linkStatus(user.id);
  }

  /** The IdP returns here (login and step-up share one registered URI). */
  @Public()
  @AuthThrottle()
  @Get('callback')
  @Header('Cache-Control', 'no-store')
  async callback(
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @Query('error') idpError: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // Single use: the flow cookie is cleared whatever happens next.
    clearSsoFlowCookie(res, this.env);
    if (!(await this.sso.isEnabled())) return this.redirectError(res, 'failed');

    const outcome = await this.sso.complete({
      // Only the signed read is trusted; `req.cookies` would accept a forged
      // unsigned cookie of the same name (CWE-807).
      flowCookie: req.signedCookies?.[ssoFlowCookieName(this.env)],
      code,
      state,
      idpError,
      meta: requestMetaOf(req),
      requestId: typeof req.id === 'string' ? req.id : undefined,
    });

    if (!outcome.ok) {
      return outcome.purpose === 'link'
        ? res.redirect(302, this.landing(`/me?sso=${outcome.code}`))
        : this.redirectError(res, outcome.code);
    }
    if (outcome.kind === 'link') {
      // A link creates no session and changes none: back to My account.
      return res.redirect(302, this.landing('/me?sso=linked'));
    }

    if (outcome.kind === 'login') {
      const { login } = outcome;
      setSessionCookie(res, this.env, login.refreshToken);
      setAccessCookie(res, this.env, login.accessToken);
      setCsrfCookie(res, this.env, this.csrf.issue());
      setUiCookie(res, this.env, login.preferences.uiTheme, login.preferences.uiAccent);
      // The same pages the password login sends the browser to (setup wins
      // over challenge, as in login-form.tsx). Fixed paths only: landing on
      // `/` with a pending MFA state would 403 every API call.
      if (outcome.mfaSetupRequired) return res.redirect(302, this.landing('/mfa/setup'));
      if (outcome.mfaChallengeRequired) return res.redirect(302, this.landing('/mfa/challenge'));
    }
    res.redirect(302, this.landing('/'));
  }

  private redirectMe(res: Response, code: SsoErrorCode): void {
    res.redirect(302, this.landing(`/me?sso=${code}`));
  }

  private redirectError(res: Response, code: SsoErrorCode): void {
    res.redirect(302, this.landing(`/login?sso_error=${code}`));
  }

  /** `APP_URL` + a fixed path. Never derived from the request. */
  private landing(path: string): string {
    return `${this.env.values.APP_URL.replace(/\/+$/, '')}${path}`;
  }
}
