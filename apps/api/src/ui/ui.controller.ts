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
  DEFAULT_UI_ACCENT,
  type PublicUiPreferences,
  type UiAccent,
  type UiTheme,
  uiAccentValues,
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
    const accent = readAccentFromCookie(req, this.env) ?? DEFAULT_UI_ACCENT;
    setUiCookie(res, this.env, dto.uiTheme, accent);
    return { preferences: { uiTheme: dto.uiTheme, uiAccent: accent } };
  }
}

function readAccentFromCookie(req: Request, env: EnvService): UiAccent | null {
  const raw = req.cookies[cookieNames(env).ui] as string | undefined;
  if (!raw) return null;
  const match = /a=([a-z]+)/.exec(raw);
  const candidate = match?.[1];
  if (!candidate) return null;
  return (uiAccentValues as readonly string[]).includes(candidate)
    ? (candidate as UiAccent)
    : null;
}
