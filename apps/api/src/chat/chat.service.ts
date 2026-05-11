import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  ChatConversationDetail,
  ChatConversationSummary,
  ChatMessageDto,
  ChatRole,
} from '@weavestream/shared';
import { ChatRole as PrismaChatRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * Per-user chat conversation CRUD. Streaming-driven message creation
 * lives in {@link ChatStreamService} — this service stays JSON-only so
 * the regular request lifecycle (`ZodBody`, exception filter, etc.)
 * applies cleanly to list/get/create/delete.
 *
 * All queries are scoped by `userId`. A user can never see another
 * user's conversations even if they guess a UUID.
 */
@Injectable()
export class ChatService {
  constructor(private readonly prisma: PrismaService) {}

  async list(actor: AuthedUser): Promise<ChatConversationSummary[]> {
    const rows = await this.prisma.chatConversation.findMany({
      where: { userId: actor.id },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return rows.map(toSummary);
  }

  async create(actor: AuthedUser): Promise<ChatConversationDetail> {
    const row = await this.prisma.chatConversation.create({
      data: { userId: actor.id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    return toDetail(row);
  }

  async get(actor: AuthedUser, id: string): Promise<ChatConversationDetail> {
    const row = await this.prisma.chatConversation.findUnique({
      where: { id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!row) throw new NotFoundException('Conversation not found');
    if (row.userId !== actor.id) throw new ForbiddenException();
    return toDetail(row);
  }

  async delete(actor: AuthedUser, id: string): Promise<void> {
    const row = await this.prisma.chatConversation.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });
    if (!row) throw new NotFoundException('Conversation not found');
    if (row.userId !== actor.id) throw new ForbiddenException();
    await this.prisma.chatConversation.delete({ where: { id } });
  }
}

type ConversationRow = {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
};

type ConversationWithMessagesRow = ConversationRow & {
  model: string | null;
  messages: Array<{
    id: string;
    role: PrismaChatRole;
    content: string;
    createdAt: Date;
  }>;
};

function toSummary(row: ConversationRow): ChatConversationSummary {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDetail(row: ConversationWithMessagesRow): ChatConversationDetail {
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    messages: row.messages.map(toMessageDto),
  };
}

export function toMessageDto(msg: {
  id: string;
  role: PrismaChatRole;
  content: string;
  createdAt: Date;
}): ChatMessageDto {
  return {
    id: msg.id,
    role: prismaRoleToDto(msg.role),
    content: msg.content,
    createdAt: msg.createdAt.toISOString(),
  };
}

export function prismaRoleToDto(role: PrismaChatRole): ChatRole {
  return role === PrismaChatRole.USER ? 'user' : 'assistant';
}
