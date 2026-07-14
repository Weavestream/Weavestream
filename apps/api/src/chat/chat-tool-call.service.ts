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
import {
  applyArticleTextEdits,
  createArticleToolInputSchema,
  MAX_ARTICLE_PATCH_CHARS,
  MAX_MARKDOWN_SOURCE,
  patchArticleToolInputSchema,
  rawArticlePatchPayloadChars,
  splitMarkdownTitleAndBody,
  stripNullArgs,
  tiptapDocToMarkdown,
  updateArticleToolInputSchema,
} from '@weavestream/shared';
import { ArticlesService, StaleArticleError } from '../articles/articles.service.js';
import { PermissionService } from '../rbac/permission.service.js';
import type { AuditMeta } from '../articles/articles.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { ChatService } from './chat.service.js';

/**
 * Executes the agentic write tools (`patch_article`, `update_article`,
 * `create_article`)
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
    const { toolCall, updatedToolCalls, allToolCalls, turnContext } = await this.loadPending(
      actor,
      params,
    );

    // Bind the apply to the scope that PRODUCED the proposal, not
    // whatever page the client is on now. The persisted `turnContext`
    // wins; the client-supplied `requestCompanyId` is a legacy fallback
    // for rows saved before turn-binding. For article edit tools this is
    // only a reject-only cross-check — the writable company is still
    // derived from the article row. For `create_article` it is the
    // scope, still gated by `article.write`.
    const scopeCompanyId = turnContext?.companyId ?? params.requestCompanyId;

    let next: ChatToolCallDto;
    try {
      if (toolCall.name === 'patch_article') {
        const result = await this.applyPatch(actor, toolCall, scopeCompanyId, params.auditMeta);
        next = { ...toolCall, status: 'applied', result, error: null };
      } else if (toolCall.name === 'update_article') {
        const result = await this.applyUpdate(
          actor,
          toolCall,
          scopeCompanyId,
          params.createOverrides,
          params.auditMeta,
        );
        next = { ...toolCall, status: 'applied', result, error: null };
      } else if (toolCall.name === 'create_article') {
        const result = await this.applyCreate(
          actor,
          toolCall,
          scopeCompanyId,
          params.createOverrides,
          params.auditMeta,
        );
        next = { ...toolCall, status: 'applied', result, error: null };
      } else {
        // Read tools execute during streaming and are never persisted
        // as `pending`; a stray apply on one is a client bug.
        throw new BadRequestException('Only proposal tool calls can be applied.');
      }
    } catch (err) {
      this.logger.warn(`Tool call ${toolCall.id} (${toolCall.name}) failed: ${messageOf(err)}`);
      if (err instanceof StaleArticleError) {
        // The WHERE-clause revision guard matched zero rows: someone
        // edited (or archived) the article after the proposal's base
        // revision was captured. The newer content wins, always.
        next = {
          ...toolCall,
          status: 'failed',
          result: null,
          errorCode: 'stale',
          error:
            'This article was edited after the proposal was drafted, so it was not applied. ' +
            'Ask the assistant to redo the change against the current version.',
        };
      } else if (err instanceof NoBaseRevisionError) {
        next = {
          ...toolCall,
          status: 'failed',
          result: null,
          errorCode: 'no_base',
          error:
            'This proposal was not based on the article’s current content, so it was not applied. ' +
            'Ask the assistant to read the article and propose the change again.',
        };
      } else if (err instanceof ArticlePatchApplyError) {
        next = {
          ...toolCall,
          status: 'failed',
          result: null,
          errorCode: err.code === 'not_found' ? 'patch_missing' : 'patch_ambiguous',
          error:
            err.code === 'not_found'
              ? 'The original passage could not be found in the current article, so no changes were applied. Ask the assistant to redo the edit against the current text.'
              : 'The original passage appears more than once, so the edit could not be applied safely. Ask the assistant to retry with more surrounding text.',
        };
      } else {
        next = {
          ...toolCall,
          status: 'failed',
          result: null,
          error: messageOf(err),
        };
      }
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

  private async applyPatch(
    actor: AuthedUser,
    toolCall: ChatToolCallDto,
    requestCompanyId: string | undefined,
    auditMeta: AuditMeta,
  ): Promise<string> {
    const rawArgs = stripNullArgs(toolCall.arguments);
    // Enforce the aggregate patch-size cap BEFORE the field-level parse.
    // The per-field max is itself MAX_ARTICLE_PATCH_CHARS and the strict
    // tool JSON-schema converter can't express a cross-field sum, so this
    // is the gate that stops up-to-12 edits carrying megabytes past
    // validation (F12).
    if (rawArticlePatchPayloadChars(rawArgs['edits']) > MAX_ARTICLE_PATCH_CHARS) {
      throw new BadRequestException('Article patch is too large.');
    }
    const args = patchArticleToolInputSchema.parse(rawArgs);
    if (args.title === undefined && args.edits === undefined) {
      throw new BadRequestException('Tool call did not propose any change.');
    }

    const targetCompanyId = await this.articles.findCompanyIdForArticle(args.article_id);
    if (targetCompanyId === null) throw new NotFoundException('Article not found.');
    if (requestCompanyId && requestCompanyId !== targetCompanyId) {
      throw new ForbiddenException(
        'Refusing to apply: article belongs to a different company than the one you were viewing.',
      );
    }
    await this.assertArticleWrite(actor, targetCompanyId);

    if (typeof toolCall.baseRevision !== 'number') {
      throw new NoBaseRevisionError();
    }
    const article = await this.articles.getById(actor, targetCompanyId, args.article_id);
    if (article.revision !== toolCall.baseRevision) {
      throw new StaleArticleError();
    }

    const titleChanged = args.title !== undefined && args.title !== article.title;
    const input: UpdateArticleInput = {};
    if (titleChanged) input.title = args.title;
    if (args.edits !== undefined) {
      const currentMarkdown =
        article.editorMode === 'markdown'
          ? (article.markdownSource ?? '')
          : tiptapDocToMarkdown(article.content);
      const patched = applyArticleTextEdits(currentMarkdown, args.edits);
      if (!patched.ok) {
        throw new ArticlePatchApplyError(patched.code, patched.editIndex);
      }
      if (patched.markdown.length > MAX_MARKDOWN_SOURCE) {
        throw new BadRequestException('The edited article is too large.');
      }
      if (patched.markdown === currentMarkdown && !titleChanged) {
        throw new BadRequestException('Tool call did not change the article.');
      }
      input.editorMode = 'markdown';
      input.markdownSource = patched.markdown;
    }
    if (args.edits === undefined && !titleChanged) {
      throw new BadRequestException('Tool call did not change the article.');
    }

    const updated = await this.articles.update(
      actor,
      targetCompanyId,
      args.article_id,
      input,
      auditMeta,
      { expectedRevision: toolCall.baseRevision },
    );
    return `Edited article "${updated.title}".`;
  }

  private async applyUpdate(
    actor: AuthedUser,
    toolCall: ChatToolCallDto,
    requestCompanyId: string | undefined,
    overrides: CreateArticleOverrides | undefined,
    auditMeta: AuditMeta,
  ): Promise<string> {
    const args = updateArticleToolInputSchema.parse(stripNullArgs(toolCall.arguments));

    // Look the article up FIRST. We don't trust the LLM's company
    // scope — the article's own row is the source of truth, and the
    // request-scope `companyId` (the page the user was on) must match
    // it so the user can't be tricked into mutating another tenant
    // via a hallucinated article id.
    const targetCompanyId = await this.articles.findCompanyIdForArticle(args.article_id);
    if (targetCompanyId === null) {
      // The LLM referenced an article that doesn't exist. The chat UI
      // flags this client-side (no matching page-context / mention)
      // and the user confirms a target via the Save-as-article
      // dialog, which posts `createOverrides`. Promote the proposal
      // to a create so the user's intent isn't lost to a hallucinated
      // article id — but only when we have an explicit company scope
      // AND the LLM emitted a body to seed the new article.
      if (overrides && requestCompanyId && args.markdown) {
        return this.applyCreateFromUpdateArgs(actor, args, requestCompanyId, overrides, auditMeta);
      }
      throw new NotFoundException('Article not found.');
    }
    if (requestCompanyId && requestCompanyId !== targetCompanyId) {
      throw new ForbiddenException(
        'Refusing to apply: article belongs to a different company than the one you were viewing.',
      );
    }
    await this.assertArticleWrite(actor, targetCompanyId);

    // Revision-guard semantics (WS-030), keyed on how the proposal was
    // persisted:
    //   number  → the server captured the basis the model actually saw;
    //             guard the update on it (WHERE clause, atomic).
    //   null    → the article did not resolve at persist time. It
    //             resolves NOW, so the proposal was drafted blind to
    //             this article's content — refuse. (null exists only to
    //             serve the not-found → Save-as-article promotion above,
    //             which creates and never updates.)
    //   absent  → legacy row from before revision guarding; applies
    //             unguarded exactly as it always did. New rows always
    //             persist number-or-null, so absence cannot be forged.
    if (toolCall.baseRevision === null) {
      throw new NoBaseRevisionError();
    }
    const expectedRevision =
      typeof toolCall.baseRevision === 'number' ? toolCall.baseRevision : undefined;

    // Strip a duplicated leading `# Heading` so the rendered article
    // doesn't show the title twice. If the LLM didn't explicitly
    // propose a title we promote the parsed heading into one — the
    // user already saw the heading in the chat panel preview, so
    // applying with that heading as the title matches expectations.
    const parsed = args.markdown !== undefined ? splitMarkdownTitleAndBody(args.markdown) : null;

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
      { expectedRevision },
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
    const args = createArticleToolInputSchema.parse(stripNullArgs(toolCall.arguments));
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
    const folderId = overrides !== undefined ? overrides.folderId : (args.folder_id ?? null);
    const visibleToClients =
      overrides !== undefined ? overrides.visibleToClients : args.visible_to_clients;
    const input: CreateArticleInput = {
      editorMode: 'markdown',
      title,
      markdownSource: parsed.body,
      ...(folderId ? { folderId } : {}),
      ...(visibleToClients !== undefined ? { visibleToClients } : {}),
    };

    const created = await this.articles.create(actor, requestCompanyId, input, auditMeta);
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
      throw new BadRequestException('Tool call did not include a body to create an article from.');
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
    const created = await this.articles.create(actor, requestCompanyId, input, auditMeta);
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
    const msg = await this.chat.getMessageForActor(actor, params.conversationId, params.messageId);
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

  private async assertArticleWrite(actor: AuthedUser, companyId: string): Promise<void> {
    const decision = await this.permissions.can(actor, 'article.write', {
      companyId,
    });
    if (!decision.allowed) {
      throw new ForbiddenException(decision.reason ?? 'Missing article.write permission.');
    }
  }
}

// ----------------------------------------------------------------------
// Apply-time re-validation uses the SAME shared Zod schemas the LLM
// tool definitions are generated from (`@weavestream/shared` ai-tools) —
// one source of truth instead of the previous hand-maintained pair.
// `stripNullArgs` (also shared) normalises the strict-schema `null`
// placeholders to `undefined` first.
// ----------------------------------------------------------------------

/**
 * Thrown when an article edit proposal persisted with
 * `baseRevision: null` targets an article that NOW resolves — the
 * proposal was drafted without reading this article's content, so
 * applying it could blindly overwrite. Mapped to errorCode `no_base`.
 */
class NoBaseRevisionError extends Error {
  constructor() {
    super('Update proposal has no server-captured base revision.');
    this.name = 'NoBaseRevisionError';
  }
}

class ArticlePatchApplyError extends Error {
  constructor(
    readonly code: 'not_found' | 'ambiguous',
    readonly editIndex: number,
  ) {
    super(`Article patch edit ${editIndex + 1} failed: ${code}.`);
    this.name = 'ArticlePatchApplyError';
  }
}

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

function replaceCall(calls: ChatToolCallDto[], next: ChatToolCallDto): ChatToolCallDto[] {
  return calls.map((c) => (c.id === next.id ? next : c));
}

function messageOf(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.errors.map((e) => `${e.path.join('.') || '<root>'}: ${e.message}`).join('; ');
  }
  return err instanceof Error && err.message ? err.message : 'Unknown error';
}
