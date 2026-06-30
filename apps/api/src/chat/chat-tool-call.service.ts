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
  ChatTurnContext,
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
      createOverrides?: CreateArticleOverrides;
      auditMeta: AuditMeta;
    },
  ): Promise<{ toolCall: ChatToolCallDto; updatedToolCalls: ChatToolCallDto[] }> {
    const { toolCall, updatedToolCalls, allToolCalls, turnContext } =
      await this.loadPending(actor, params);

    // Bind the apply to the scope that PRODUCED the proposal, not
    // whatever page the client is on now. The persisted `turnContext`
    // wins; the client-supplied `requestCompanyId` is a legacy fallback
    // for rows saved before turn-binding. For `update_article` this is
    // only a reject-only cross-check — the writable company is still
    // derived from the article row. For `create_article` it is the
    // scope, still gated by `article.write`.
    const scopeCompanyId = turnContext?.companyId ?? params.requestCompanyId;

    let next: ChatToolCallDto;
    try {
      if (toolCall.name === 'update_article') {
        const result = await this.applyUpdate(
          actor,
          toolCall,
          scopeCompanyId,
          params.createOverrides,
          params.auditMeta,
        );
        next = { ...toolCall, status: 'applied', result, error: null };
      } else {
        const result = await this.applyCreate(
          actor,
          toolCall,
          scopeCompanyId,
          params.createOverrides,
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
    overrides: CreateArticleOverrides | undefined,
    auditMeta: AuditMeta,
  ): Promise<string> {
    const args = updateArgsSchema.parse(stripNullArgs(toolCall.arguments));

    // Look the article up FIRST. We don't trust the LLM's company
    // scope — the article's own row is the source of truth, and the
    // request-scope `companyId` (the page the user was on) must match
    // it so the user can't be tricked into mutating another tenant
    // via a hallucinated article id.
    const targetCompanyId = await this.articles.findCompanyIdForArticle(
      args.article_id,
    );
    if (targetCompanyId === null) {
      // The LLM referenced an article that doesn't exist. The chat UI
      // flags this client-side (no matching page-context / mention)
      // and the user confirms a target via the Save-as-article
      // dialog, which posts `createOverrides`. Promote the proposal
      // to a create so the user's intent isn't lost to a hallucinated
      // article id — but only when we have an explicit company scope
      // AND the LLM emitted a body to seed the new article.
      if (overrides && requestCompanyId && args.markdown) {
        return this.applyCreateFromUpdateArgs(
          actor,
          args,
          requestCompanyId,
          overrides,
          auditMeta,
        );
      }
      throw new NotFoundException('Article not found.');
    }
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
    overrides: CreateArticleOverrides | undefined,
    auditMeta: AuditMeta,
  ): Promise<string> {
    if (!requestCompanyId) {
      throw new BadRequestException(
        'Cannot create an article without a company context. Open the chat from a company page first.',
      );
    }
    const args = createArgsSchema.parse(stripNullArgs(toolCall.arguments));
    await this.assertArticleWrite(actor, requestCompanyId);

    // Same dedupe as `applyUpdate`: if the LLM's body opens with the
    // same heading it also passed as `title`, drop the heading line
    // so the rendered article doesn't show the title twice.
    const parsed = splitMarkdownTitleAndBody(args.markdown);
    // Prefer the user-confirmed values from the Save-as-article
    // dialog over the LLM-supplied `args.folder_id` /
    // `args.visible_to_clients` / `args.title`. The dialog forces a
    // pick from the live company tree, so a stray LLM hallucination
    // can never reach the articles service.
    const title = overrides?.title ?? args.title;
    const folderId =
      overrides !== undefined ? overrides.folderId : args.folder_id ?? null;
    const visibleToClients =
      overrides !== undefined
        ? overrides.visibleToClients
        : args.visible_to_clients;
    const input: CreateArticleInput = {
      editorMode: 'markdown',
      title,
      markdownSource: parsed.body,
      ...(folderId ? { folderId } : {}),
      ...(visibleToClients !== undefined
        ? { visibleToClients }
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

  /**
   * Promote an `update_article` proposal into a brand-new article when
   * the LLM-supplied `article_id` doesn't exist. The Save-as-article
   * dialog already collected an explicit company / folder / title /
   * visibility from the user, so we use those as the canonical
   * target and the LLM's body for the article content.
   */
  private async applyCreateFromUpdateArgs(
    actor: AuthedUser,
    args: { title?: string; markdown?: string },
    requestCompanyId: string,
    overrides: CreateArticleOverrides,
    auditMeta: AuditMeta,
  ): Promise<string> {
    if (!args.markdown) {
      throw new BadRequestException(
        'Tool call did not include a body to create an article from.',
      );
    }
    await this.assertArticleWrite(actor, requestCompanyId);
    const parsed = splitMarkdownTitleAndBody(args.markdown);
    const input: CreateArticleInput = {
      editorMode: 'markdown',
      title: overrides.title,
      markdownSource: parsed.body,
      ...(overrides.folderId ? { folderId: overrides.folderId } : {}),
      visibleToClients: overrides.visibleToClients,
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
    turnContext: ChatTurnContext | null;
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
    return {
      toolCall,
      allToolCalls: calls,
      updatedToolCalls: calls,
      turnContext: msg.turnContext,
    };
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

/**
 * User-confirmed overrides for `create_article` apply, posted by the
 * Save-as-article dialog. Always replaces the LLM-supplied values
 * when present so the article lands in the folder the user actually
 * picked.
 */
export type CreateArticleOverrides = {
  title: string;
  folderId: string | null;
  visibleToClients: boolean;
};

/**
 * Drop `null`-valued keys from LLM tool arguments before apply-time
 * validation. The strict tool schemas (`strict: true`) require every
 * property to be present, so the model emits `null` for fields it isn't
 * setting; the apply-time schemas use `.optional()` (which accepts
 * `undefined`, not `null`), so an un-stripped `{ summary: null }` would
 * throw a ZodError and fail the apply.
 */
function stripNullArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== null) out[key] = value;
  }
  return out;
}

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
