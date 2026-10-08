import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { createApiKeySchema, type CreateApiKeyInput } from '@weavestream/shared';
import { ApiKeyService } from './api-key.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { AuthedOnly } from '../rbac/require-permission.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { Throttle } from '@nestjs/throttler';
import { RequireStepUp } from './step-up/require-step-up.decorator.js';
import { requestMetaOf as meta } from '../common/request-meta.js';

/**
 * Self-service API key management.
 *
 * Every route is scoped to the *acting* user. No `userId` is ever accepted
 * from the client and there is no path by which one user reads or revokes
 * another's keys (CLAUDE.md §1).
 *
 * `AuthedOnly` rather than a permission: managing your own credentials is not
 * a privileged capability, and gating it would mean a CONTRACTOR could never
 * automate anything.
 *
 * `ApiKeySurfaceGuard` denies this controller to API-key principals, so a
 * leaked key cannot mint itself successors or revoke the owner's other keys.
 * Only an interactive session reaches these handlers.
 */
@Controller({ path: 'me/api-keys', version: '1' })
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeyService) {}

  @Get()
  @AuthedOnly()
  async list(@CurrentUser() actor: AuthedUser) {
    return this.apiKeys.list(actor.id);
  }

  /**
   * Mint a key. The plaintext token is in this response and nowhere else — it
   * is never stored, never logged, and cannot be recovered afterwards.
   */
  @Post()
  @AuthedOnly()
  @HttpCode(HttpStatus.CREATED)
  // A key is a durable persistence credential — optionally non-expiring and
  // carrying the owner's full authority — so it needs a valid recent step-up,
  // matching backup-code regeneration (`me.controller.ts`). Without it a
  // stolen live session could mint a permanent key and then discard the
  // cookie, surviving the victim's password change and sign-out-everywhere.
  // Edge-level cap matches the other sensitive POSTs on this surface.
  @Throttle({ global: { limit: 10, ttl: 60_000 } })
  @RequireStepUp()
  async create(
    @CurrentUser() actor: AuthedUser,
    @Body(new ZodBody(createApiKeySchema)) dto: CreateApiKeyInput,
    @Req() req: Request,
  ) {
    return this.apiKeys.create(actor, dto, meta(req));
  }

  @Delete(':id')
  @AuthedOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @CurrentUser() actor: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.apiKeys.revoke(actor, id, meta(req));
  }
}
