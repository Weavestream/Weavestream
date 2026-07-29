import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  ChatConversationDetail,
  ChatConversationSummary,
  ChatMessageDto,
  ChatRole,
  ChatToolCallDto,
  ChatTurnContext,
} from '@weavestream/shared';
import {
  chatToolCallErrorCodeSchema,
  chatToolCallNameSchema,
  chatToolCallSchema,
  chatToolCallStatusSchema,
} from '@weavestream/shared';
import { z } from 'zod';
import { ChatRole as PrismaChatRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/** Local validator for the preview-hint uuid (kept out of the hot loop). */
const uuidSchema = z.string().uuid();

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

  /**
   * Load a single message scoped to the actor's conversation. Used by
   * the tool-call apply / reject endpoints so they share the same
   * ownership check as the rest of the chat surface.
   */
  async getMessageForActor(
    actor: AuthedUser,
    conversationId: string,
    messageId: string,
  ): Promise<{
    id: string;
    conversationId: string;
    role: PrismaChatRole;
    content: string;
    toolCalls: ChatToolCallDto[] | null;
    turnContext: ChatTurnContext | null;
  }> {
    const conversation = await this.prisma.chatConversation.findUnique({
      where: { id: conversationId },
      select: { id: true, userId: true },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    if (conversation.userId !== actor.id) throw new ForbiddenException();
    const msg = await this.prisma.chatMessage.findFirst({
      where: { id: messageId, conversationId },
    });
    if (!msg) throw new NotFoundException('Message not found');
    return {
      id: msg.id,
      conversationId: msg.conversationId,
      role: msg.role,
      content: msg.content,
      toolCalls: parseToolCalls(msg.toolCalls),
      turnContext: parseTurnContext(msg.turnContext),
    };
  }

  /**
   * Persist a tool-call mutation back onto the assistant message. We
   * deliberately rewrite the whole array (one JSONB write) rather than
   * partial-patching the json — it's a single short array per row and
   * sidesteps Postgres `jsonb_set` typing in Prisma.
   *
   * `db` lets the tool-call settle path write inside its own claim
   * transaction (the row is locked `FOR UPDATE` there); everything else
   * uses the default client.
   */
  async updateMessageToolCalls(
    messageId: string,
    toolCalls: ChatToolCallDto[],
    db: Pick<Prisma.TransactionClient, 'chatMessage'> = this.prisma,
  ): Promise<void> {
    await db.chatMessage.update({
      where: { id: messageId },
      data: { toolCalls: toolCalls as unknown as Prisma.InputJsonValue },
    });
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
    toolCalls: Prisma.JsonValue | null;
    turnContext: Prisma.JsonValue | null;
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
  toolCalls?: Prisma.JsonValue | null;
  turnContext?: Prisma.JsonValue | null;
}): ChatMessageDto {
  const toolCalls = parseToolCalls(msg.toolCalls ?? null);
  // The turn's company scope is the one field of `turn_context` clients
  // need back: it is what a create apply binds to, so a confirmation UI
  // must lock to it instead of offering a destination the server would
  // refuse. The rest of the context is the client's own request echo —
  // no reason to ship it back.
  const scopeCompanyId = parseTurnContext(msg.turnContext ?? null)?.companyId;
  return {
    id: msg.id,
    role: prismaRoleToDto(msg.role),
    content: msg.content,
    createdAt: msg.createdAt.toISOString(),
    ...(toolCalls ? { toolCalls } : {}),
    ...(scopeCompanyId ? { scopeCompanyId } : {}),
  };
}

export function prismaRoleToDto(role: PrismaChatRole): ChatRole {
  return role === PrismaChatRole.USER ? 'user' : 'assistant';
}

/**
 * Parse the JSONB `tool_calls` column into the strict DTO array. The
 * column is written exclusively by our own code (chat-stream service)
 * so we treat unexpected shapes as "no tool calls" rather than
 * throwing — a corrupt row should still load.
 */
export function parseToolCalls(raw: Prisma.JsonValue | null): ChatToolCallDto[] | null {
  if (!raw || !Array.isArray(raw)) return null;
  const out: ChatToolCallDto[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? obj.id : null;
    const name = typeof obj.name === 'string' ? obj.name : null;
    const status = typeof obj.status === 'string' ? obj.status : null;
    const args =
      obj.arguments && typeof obj.arguments === 'object' && !Array.isArray(obj.arguments)
        ? (obj.arguments as Record<string, unknown>)
        : {};
    if (!id || !name || !status) continue;
    // Allowlists come from the shared schemas — the single source of
    // truth for tool names / statuses / error codes (WS-030).
    const parsedName = chatToolCallNameSchema.safeParse(name);
    const parsedStatus = chatToolCallStatusSchema.safeParse(status);
    if (!parsedName.success || !parsedStatus.success) continue;
    const parsedErrorCode = chatToolCallErrorCodeSchema.safeParse(obj.errorCode);
    out.push({
      id,
      name: parsedName.data,
      arguments: args,
      status: parsedStatus.data,
      result: typeof obj.result === 'string' ? obj.result : null,
      error: typeof obj.error === 'string' ? obj.error : null,
      errorCode: parsedErrorCode.success ? parsedErrorCode.data : null,
      // `baseRevision` distinguishes null (article didn't resolve at
      // persist time — create-promotion only) from ABSENT (legacy row,
      // applies unguarded). Preserve that distinction through the
      // JSONB round-trip.
      ...(typeof obj.baseRevision === 'number' &&
      Number.isInteger(obj.baseRevision) &&
      obj.baseRevision > 0
        ? { baseRevision: obj.baseRevision }
        : obj.baseRevision === null
          ? { baseRevision: null }
          : {}),
      // Preview hint for the proposal cards (write side attaches only
      // truthy uuids, so absent-vs-null needs no trichotomy here).
      // Dropping this on read-back was the "unavailable for preview
      // after reload" bug: apply/reject then wrote the stripped array
      // back, erasing the field from sibling calls permanently.
      ...(uuidSchema.safeParse(obj.targetCompanyId).success
        ? { targetCompanyId: obj.targetCompanyId as string }
        : {}),
      // Server-managed create-idempotency marker (see chatToolCallSchema
      // doc). Must survive the round-trip or a sibling settle's
      // whole-array write would strip an in-flight create's recovery
      // record.
      ...(() => {
        const parsed = chatToolCallSchema.shape.pendingCreate.safeParse(obj.pendingCreate);
        return parsed.success && parsed.data !== undefined
          ? { pendingCreate: parsed.data }
          : {};
      })(),
    });
  }
  return out.length > 0 ? out : null;
}

/**
 * Parse the JSONB `turn_context` column into the metadata-only DTO. Like
 * {@link parseToolCalls}, the column is written exclusively by our own
 * code, so unexpected shapes degrade to `null` rather than throwing.
 * This is descriptive context only — never an authorization source.
 */
export function parseTurnContext(
  raw: Prisma.JsonValue | null,
): ChatTurnContext | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const out: ChatTurnContext = {};
  if (typeof obj.companyId === 'string') out.companyId = obj.companyId;
  if (typeof obj.currentArticleId === 'string') {
    out.currentArticleId = obj.currentArticleId;
  }
  if (typeof obj.currentTicketId === 'string') {
    out.currentTicketId = obj.currentTicketId;
  }
  if (Array.isArray(obj.articleIds)) {
    const ids = obj.articleIds.filter(
      (x): x is string => typeof x === 'string',
    );
    if (ids.length > 0) out.articleIds = ids;
  }
  return Object.keys(out).length > 0 ? out : null;
}
