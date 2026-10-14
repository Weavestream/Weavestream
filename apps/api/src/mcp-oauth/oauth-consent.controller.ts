import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import {
  mcpConsentApproveSchema,
  type McpConsentApproveInput,
  type McpConsentDetails,
  type McpConsentResult,
} from '@weavestream/shared';
import { Public } from '../common/public.decorator.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { AuthedOnly } from '../rbac/require-permission.decorator.js';
import { InteractiveOnly } from '../auth/interactive-only.decorator.js';
import { RequireStepUp } from '../auth/step-up/require-step-up.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { requestMetaOf } from '../common/request-meta.js';
import { OAuthConsentService } from './oauth-consent.service.js';
import { INTERACTION_UID } from './mcp-oauth.constants.js';

function checkUid(uid: string): string {
  if (!INTERACTION_UID.test(uid)) throw new NotFoundException();
  return uid;
}

/**
 * The consent step for remote MCP connections, under the path the provider's
 * interaction cookie is scoped to (`/api/v1/oauth-consent/<uid>`).
 *
 * Only a person in a browser session may decide: every decision route is
 * `@InteractiveOnly` (no API key, no connection), CSRF-checked, and approve
 * needs a fresh step-up — the same bar as creating an API key, because a
 * connection is a credential that acts as the user.
 */
@Controller({ path: 'oauth-consent', version: '1' })
export class OAuthConsentController {
  constructor(private readonly consent: OAuthConsentService) {}

  /**
   * Where the provider sends the browser. Sets nothing and reads nothing: it
   * exists so the interaction cookie's path covers the routes below, and
   * forwards to the consent page.
   */
  @Get(':uid')
  @Public()
  redirect(@Param('uid') uid: string, @Res() res: Response): void {
    res.redirect(HttpStatus.SEE_OTHER, `/oauth/consent/${checkUid(uid)}`);
  }

  @Get(':uid/details')
  @AuthedOnly()
  @InteractiveOnly()
  details(
    @CurrentUser() actor: AuthedUser,
    @Param('uid') uid: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<McpConsentDetails> {
    return this.consent.details(actor, checkUid(uid), req, res);
  }

  @Post(':uid/approve')
  @HttpCode(HttpStatus.OK)
  @AuthedOnly()
  @InteractiveOnly()
  @Throttle({ global: { limit: 10, ttl: 60_000 } })
  @RequireStepUp()
  approve(
    @CurrentUser() actor: AuthedUser,
    @Param('uid') uid: string,
    @Body(new ZodBody(mcpConsentApproveSchema)) dto: McpConsentApproveInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<McpConsentResult> {
    return this.consent.approve(actor, checkUid(uid), dto.allowWrite, req, res, requestMetaOf(req));
  }

  @Post(':uid/deny')
  @HttpCode(HttpStatus.OK)
  @AuthedOnly()
  @InteractiveOnly()
  deny(
    @Param('uid') uid: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<McpConsentResult> {
    return this.consent.deny(checkUid(uid), req, res);
  }
}
