import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  publicUiPreferencesSchema,
  parseUiCookie,
  type PublicUiPreferences,
  type UiAccent,
  type UiTheme,
} from '@weavestream/shared';
import { Public, SkipCsrf } from '../common/public.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { setUiCookie, cookieNames } from '../auth/cookies.js';
import { EnvService } from '../config/env.service.js';

/**
 * Phase 9b.1 — public UI preferences endpoint. Used by the login/setup
 * pages so unauthenticated visitors can still flip dark/light without a
 * full login round-trip. Only the theme is writable here; accent is a
 * signed-in preference only. Rate limited to thwart cookie-stuffing.
 */
@Controller({ path: 'public/ui-prefs', version: '1' })
export class PublicUiController {
  constructor(private readonly env: EnvService) {}

  @Public()
  @SkipCsrf()
  @Throttle({ global: { limit: 30, ttl: 60_000 } })
  @Post()
  @HttpCode(HttpStatus.OK)
  setTheme(
    @Body(new ZodBody(publicUiPreferencesSchema)) dto: PublicUiPreferences,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): { preferences: { uiTheme: UiTheme; uiAccent: UiAccent } } {
    // Preserve the current accent if the caller already has a `ws_ui`
    // cookie — unauthenticated users shouldn't be able to flip accent,
    // but we also don't want to clobber a logged-out session's existing
    // choice with the default on every dark↔light flip.
    //
    // `parseUiCookie` is the shared wire-format reader; it already falls
    // back to DEFAULT_UI_ACCENT for a missing or garbled cookie, which is
    // what the previous hand-rolled regex did the long way round.
    // cookie-parser has already percent-decoded `req.cookies`.
    const raw = req.cookies[cookieNames(this.env).ui] as string | undefined;
    const accent = parseUiCookie(raw).uiAccent;
    setUiCookie(res, this.env, dto.uiTheme, accent);
    return { preferences: { uiTheme: dto.uiTheme, uiAccent: accent } };
  }
}
