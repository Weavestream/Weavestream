import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import type {
  ChatToolCallDto,
  CreateArticleInput,
  UpdateArticleInput,
} from '@weavestream/shared';
import { splitMarkdownTitleAndBody } from '@weavestream/shared';
import { ArticlesService } from '../articles/articles.service.js';
import { PermissionService } from '../rbac/permission.service.js';
import type { AuditMeta } from '../articles/articles.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { ChatService } from './chat.service.js';

/**
 * Executes the agentic write tools (`update_article`, `create_article`)
 * proposed by the LLM after the user clicks Apply in the chat UI.
 *
 * Responsibilities:
 *  1. Re-validate the LLM-supplied arguments against a strict schema —
 *     the original `chat_messages.tool_calls` row stores them as a raw
 *     `Record<string, unknown>` so we never trust them at apply time.
 *  2. Re-check `article.write` for the company in REQUEST scope. The
 *     LLM may have hallucinated an `article_id` from a different
 *     tenant; the apply path forces a tenancy match by deriving the
 *     target company from the article row, not the model.
 *  3. Mutate the tool-call DTO array on the chat message with the
 *     resulting status (`applied` | `failed`) and a short result /
 *     error string.
 */
@Injectable()
export class ChatToolCallService {
  private readonly logger = new Logger(ChatToolCallService.name);

  constructor(
    private readonly articles: ArticlesService,
    private readonly chat: ChatService,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * Apply a pending tool call. Looks the message up via
   * {@link ChatService.getMessageForActor} so the actor-ownership
   * check is shared with every other chat route.
   */
  async apply(
    actor: AuthedUser,
    params: {
      conversationId: string;
      messageId: string;
      toolCallId: string;
      requestCompanyId: string | undefined;
      auditMeta: AuditMeta;
    },
  ): Promise<{ toolCall: ChatToolCallDto; updatedToolCalls: ChatToolCallDto[] }> {
    const { toolCall, updatedToolCalls, allToolCalls } = await this.loadPending(
      actor,
      params,
    );

    let next: ChatToolCallDto;
    try {
      if (toolCall.name === 'update_article') {
        const result = await this.applyUpdate(
          actor,
          toolCall,
          params.requestCompanyId,
          params.auditMeta,
        );
        next = { ...toolCall, status: 'applied', result, error: null };
      } else {
        const result = await this.applyCreate(
          actor,
          toolCall,
          params.requestCompanyId,
          params.auditMeta,
        );
        next = { ...toolCall, status: 'applied', result, error: null };
      }
    } catch (err) {
      this.logger.warn(
        `Tool call ${toolCall.id} (${toolCall.name}) failed: ${messageOf(err)}`,
      );
      next = {
        ...toolCall,
        status: 'failed',
        result: null,
        error: messageOf(err),
      };
    }

    const finalCalls = replaceCall(allToolCalls, next);
    await this.chat.updateMessageToolCalls(params.messageId, finalCalls);
    void updatedToolCalls;
    return { toolCall: next, updatedToolCalls: finalCalls };
  }

  async reject(
    actor: AuthedUser,
    params: {
      conversationId: string;
      messageId: string;
      toolCallId: string;
    },
  ): Promise<{ toolCall: ChatToolCallDto; updatedToolCalls: ChatToolCallDto[] }> {
    const { toolCall, allToolCalls } = await this.loadPending(actor, {
      ...params,
      requestCompanyId: undefined,
      auditMeta: { ip: '0.0.0.0', userAgent: 'rejection' },
    });
    const next: ChatToolCallDto = {
      ...toolCall,
      status: 'rejected',
      result: null,
      error: null,
    };
    const finalCalls = replaceCall(allToolCalls, next);
    await this.chat.updateMessageToolCalls(params.messageId, finalCalls);
    return { toolCall: next, updatedToolCalls: finalCalls };
  }

  // ------------------------------------------------------------------
  // Action implementations
  // ------------------------------------------------------------------

  private async applyUpdate(
    actor: AuthedUser,
    toolCall: ChatToolCallDto,
    requestCompanyId: string | undefined,
    auditMeta: AuditMeta,
  ): Promise<string> {
    const args = updateArgsSchema.parse(toolCall.arguments);

    // Look the article up FIRST. We don't trust the LLM's company
    // scope — the article's own row is the source of truth, and the
    // request-scope `companyId` (the page the user was on) must match
    // it so the user can't be tricked into mutating another tenant
    // via a hallucinated article id.
    const targetCompanyId = await this.resolveArticleCompany(args.article_id);
    if (requestCompanyId && requestCompanyId !== targetCompanyId) {
      throw new ForbiddenException(
        'Refusing to apply: article belongs to a different company than the one you were viewing.',
      );
    }
    await this.assertArticleWrite(actor, targetCompanyId);

    // Strip a duplicated leading `# Heading` so the rendered article
    // doesn't show the title twice. If the LLM didn't explicitly
    // propose a title we promote the parsed heading into one — the
    // user already saw the heading in the chat panel preview, so
    // applying with that heading as the title matches expectations.
    const parsed =
      args.markdown !== undefined
        ? splitMarkdownTitleAndBody(args.markdown)
        : null;

    const input: UpdateArticleInput = {
      ...(args.title !== undefined
        ? { title: args.title }
        : parsed?.hadLeadingHeading
          ? { title: parsed.title }
          : {}),
      ...(parsed !== null
        ? {
            editorMode: 'markdown' as const,
            markdownSource: parsed.body,
          }
        : {}),
    };
    if (Object.keys(input).length === 0) {
      throw new BadRequestException('Tool call did not propose any change.');
    }

    const updated = await this.articles.update(
      actor,
      targetCompanyId,
      args.article_id,
      input,
      auditMeta,
    );
    return `Updated article "${updated.title}".`;
  }

  private async applyCreate(
    actor: AuthedUser,
    toolCall: ChatToolCallDto,
    requestCompanyId: string | undefined,
    auditMeta: AuditMeta,
  ): Promise<string> {
    if (!requestCompanyId) {
      throw new BadRequestException(
        'Cannot create an article without a company context. Open the chat from a company page first.',
      );
    }
    const args = createArgsSchema.parse(toolCall.arguments);
    await this.assertArticleWrite(actor, requestCompanyId);

    // Same dedupe as `applyUpdate`: if the LLM's body opens with the
    // same heading it also passed as `title`, drop the heading line
    // so the rendered article doesn't show the title twice.
    const parsed = splitMarkdownTitleAndBody(args.markdown);
    const input: CreateArticleInput = {
      editorMode: 'markdown',
      title: args.title,
      markdownSource: parsed.body,
      ...(args.folder_id ? { folderId: args.folder_id } : {}),
      ...(args.visible_to_clients !== undefined
        ? { visibleToClients: args.visible_to_clients }
        : {}),
    };

    const created = await this.articles.create(
      actor,
      requestCompanyId,
      input,
      auditMeta,
    );
    return `Created article "${created.title}".`;
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private async loadPending(
    actor: AuthedUser,
    params: {
      conversationId: string;
      messageId: string;
      toolCallId: string;
      requestCompanyId: string | undefined;
      auditMeta: AuditMeta;
    },
  ): Promise<{
    toolCall: ChatToolCallDto;
    allToolCalls: ChatToolCallDto[];
    updatedToolCalls: ChatToolCallDto[];
  }> {
    const msg = await this.chat.getMessageForActor(
      actor,
      params.conversationId,
      params.messageId,
    );
    const calls = msg.toolCalls ?? [];
    const idx = calls.findIndex((c) => c.id === params.toolCallId);
    if (idx === -1) {
      throw new NotFoundException('Tool call not found on this message.');
    }
    const toolCall = calls[idx]!;
    if (toolCall.status !== 'pending') {
      throw new BadRequestException(
        `Tool call is already ${toolCall.status}; only pending calls can be acted on.`,
      );
    }
    return { toolCall, allToolCalls: calls, updatedToolCalls: calls };
  }

  private async resolveArticleCompany(articleId: string): Promise<string> {
    // The articles service does not expose a raw "find row" — its
    // `getById` requires the actor's company-scope. We call it with
    // the actor inside `applyUpdate` after this step, so here we just
    // need the companyId. Inline a lightweight Prisma lookup via the
    // articles service to keep the contract tight.
    return this.articles
      .findCompanyIdForArticle(articleId)
      .then((id) => {
        if (!id) throw new NotFoundException('Article not found.');
        return id;
      });
  }

  private async assertArticleWrite(
    actor: AuthedUser,
    companyId: string,
  ): Promise<void> {
    const decision = await this.permissions.can(actor, 'article.write', {
      companyId,
    });
    if (!decision.allowed) {
      throw new ForbiddenException(
        decision.reason ?? 'Missing article.write permission.',
      );
    }
  }
}

// ----------------------------------------------------------------------
// Strict schemas for re-validating LLM-supplied arguments at apply time
// ----------------------------------------------------------------------

const updateArgsSchema = z.object({
  article_id: z.string().uuid(),
  title: z.string().min(1).max(200).optional(),
  markdown: z.string().min(1).max(100_000).optional(),
  summary: z.string().max(1000).optional(),
});

const createArgsSchema = z.object({
  title: z.string().min(1).max(200),
  markdown: z.string().min(1).max(100_000),
  folder_id: z.string().uuid().optional(),
  visible_to_clients: z.boolean().optional(),
  summary: z.string().max(1000).optional(),
});

function replaceCall(
  calls: ChatToolCallDto[],
  next: ChatToolCallDto,
): ChatToolCallDto[] {
  return calls.map((c) => (c.id === next.id ? next : c));
}

function messageOf(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.errors.map((e) => `${e.path.join('.') || '<root>'}: ${e.message}`).join('; ');
  }
  return err instanceof Error && err.message ? err.message : 'Unknown error';
}
