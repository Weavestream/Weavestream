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
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  applyChatToolCallSchema,
  sendChatMessageSchema,
  type ApplyChatToolCallInput,
  type SendChatMessageInput,
} from '@weavestream/shared';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { AuthedOnly } from '../rbac/require-permission.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { requestMetaOf as meta } from '../common/request-meta.js';
import { ChatService } from './chat.service.js';
import { ChatStreamService } from './chat-stream.service.js';
import { ChatToolCallService } from './chat-tool-call.service.js';

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
    private readonly toolCalls: ChatToolCallService,
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

  /**
   * Apply a pending tool call. The actual mutation happens here — the
   * LLM streaming only PROPOSED the action. The `companyId` in the
   * request body is the page the user was on when they clicked Apply;
   * the service uses it as a tenancy sanity-check against the row the
   * LLM picked. Permissions (`article.write`) are re-verified against
   * the article's own company.
   */
  @Post('conversations/:convId/messages/:msgId/tool-calls/:toolCallId/apply')
  @HttpCode(HttpStatus.OK)
  async applyToolCall(
    @CurrentUser() actor: AuthedUser,
    @Param('convId', new ParseUUIDPipe()) convId: string,
    @Param('msgId', new ParseUUIDPipe()) msgId: string,
    @Param('toolCallId') toolCallId: string,
    @Body(new ZodBody(applyChatToolCallSchema)) dto: ApplyChatToolCallInput,
    @Req() req: Request,
  ) {
    return this.toolCalls.apply(actor, {
      conversationId: convId,
      messageId: msgId,
      toolCallId,
      requestCompanyId: dto.companyId,
      auditMeta: meta(req),
    });
  }

  @Post('conversations/:convId/messages/:msgId/tool-calls/:toolCallId/reject')
  @HttpCode(HttpStatus.OK)
  async rejectToolCall(
    @CurrentUser() actor: AuthedUser,
    @Param('convId', new ParseUUIDPipe()) convId: string,
    @Param('msgId', new ParseUUIDPipe()) msgId: string,
    @Param('toolCallId') toolCallId: string,
  ) {
    return this.toolCalls.reject(actor, {
      conversationId: convId,
      messageId: msgId,
      toolCallId,
    });
  }
}
