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
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { sendChatMessageSchema, type SendChatMessageInput } from '@weavestream/shared';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { AuthedOnly } from '../rbac/require-permission.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { ChatService } from './chat.service.js';
import { ChatStreamService } from './chat-stream.service.js';

/**
 * Per-user AI chat. All routes are implicitly scoped to the caller via
 * the service layer; we never accept a `userId` from the client.
 *
 *   GET    /v1/chat/conversations              → list (50 most recent)
 *   POST   /v1/chat/conversations              → create empty conversation
 *   GET    /v1/chat/conversations/:id          → conversation + messages
 *   DELETE /v1/chat/conversations/:id          → hard delete (cascades)
 *   POST   /v1/chat/conversations/:id/messages → SSE-stream an assistant reply
 */
@Controller({ path: 'chat', version: '1' })
@AuthedOnly()
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly stream: ChatStreamService,
  ) {}

  @Get('conversations')
  async list(@CurrentUser() actor: AuthedUser) {
    const items = await this.chat.list(actor);
    return { items };
  }

  @Post('conversations')
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentUser() actor: AuthedUser) {
    return this.chat.create(actor);
  }

  @Get('conversations/:id')
  async get(
    @CurrentUser() actor: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.chat.get(actor, id);
  }

  @Delete('conversations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @CurrentUser() actor: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    await this.chat.delete(actor, id);
  }

  /**
   * Streams an assistant reply via Server-Sent Events. `passthrough:
   * false` (the default for `@Res`) lets us write to the response
   * directly — Nest will not try to serialise the return value.
   */
  @Post('conversations/:id/messages')
  async sendMessage(
    @CurrentUser() actor: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(sendChatMessageSchema)) dto: SendChatMessageInput,
    @Res() res: Response,
  ): Promise<void> {
    await this.stream.stream(actor, id, dto, res);
  }
}
