import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type {
  ChatPendingCreate,
  ChatToolCallDto,
  ChatTurnContext,
  CreateArticleInput,
  UpdateArticleInput,
} from '@weavestream/shared';
import {
  applyArticleTextEdits,
  ARTICLE_CREATE_RECOVERY_PENDING_CODE,
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
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuditMeta } from '../articles/articles.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { ChatService, parseToolCalls } from './chat.service.js';

/**
 * Upper bound for the settle transaction. The claim holds the message
 * row lock while the article mutation runs on its own connection, so
 * the window includes one article write + audit + (for creates) the
 * version row — generous headroom over Prisma's 5 s default without
 * letting a wedged apply pin the row forever.
 */
const SETTLE_TX_TIMEOUT_MS = 30_000;

/** Canonical create intent, minus the pre-generated article id. */
type CreateIntent = Omit<ChatPendingCreate, 'articleId'>;

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
    private readonly prisma: PrismaService,
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
    // Pre-check OUTSIDE the claim: precise 404/403/400s plus the scope
    // and classification inputs. This read alone is never the guard —
    // the claim transaction below re-verifies `pending` under the
    // ownership-constrained row lock (TOCTOU).
    const { toolCall, turnContext } = await this.loadPending(actor, params);

    // Bind the apply to the scope that PRODUCED the proposal, not
    // whatever page the client is on now. The persisted `turnContext`
    // wins; the client-supplied `requestCompanyId` is a legacy fallback
    // for rows saved before turn-binding. For article edit tools this is
    // only a reject-only cross-check — the writable company is still
    // derived from the article row. For `create_article` it is the
    // scope, still gated by `article.write`. Turn context is immutable
    // after persist, so deriving it here (outside the claim) is safe.
    const scopeCompanyId = turnContext?.companyId ?? params.requestCompanyId;

    // Creates need durable idempotency: classify BEFORE the claim and
    // commit the intent marker in its own transaction, so a crash
    // between article creation and settle can be recovered without a
    // duplicate (or silently relocated) article. Null intent = not a
    // satisfiable create; the work path reproduces the precise error.
    const intent = await this.resolveCreateIntent(toolCall, scopeCompanyId, params.createOverrides);
    const marker = intent ? await this.ensureCreateMarker(actor, params, intent) : undefined;

    return this.withClaimedPending(actor, params, async (claimed) => {
      let next: ChatToolCallDto;
      try {
        if (claimed.name === 'patch_article') {
          const result = await this.applyPatch(actor, claimed, scopeCompanyId, params.auditMeta);
          next = { ...claimed, status: 'applied', result, error: null };
        } else if (claimed.name === 'update_article') {
          const result = marker
            ? await this.applyCreateWithMarker(actor, claimed, marker, params.auditMeta)
            : await this.applyUpdate(actor, claimed, scopeCompanyId, params.auditMeta);
          next = { ...claimed, status: 'applied', result, error: null };
        } else if (claimed.name === 'create_article') {
          const result = marker
            ? await this.applyCreateWithMarker(actor, claimed, marker, params.auditMeta)
            : await this.applyCreate(claimed, scopeCompanyId);
          next = { ...claimed, status: 'applied', result, error: null };
        } else {
          // Read tools execute during streaming and are never persisted
          // as `pending`; a stray apply on one is a client bug.
          throw new BadRequestException('Only proposal tool calls can be applied.');
        }
      } catch (err) {
        this.logger.warn(`Tool call ${claimed.id} (${claimed.name}) failed: ${messageOf(err)}`);
        if (err instanceof StaleArticleError) {
          // The WHERE-clause revision guard matched zero rows: someone
          // edited (or archived) the article after the proposal's base
          // revision was captured. The newer content wins, always.
          next = {
            ...claimed,
            status: 'failed',
            result: null,
            errorCode: 'stale',
            error:
              'This article was edited after the proposal was drafted, so it was not applied. ' +
              'Ask the assistant to redo the change against the current version.',
          };
        } else if (err instanceof NoBaseRevisionError) {
          next = {
            ...claimed,
            status: 'failed',
            result: null,
            errorCode: 'no_base',
            error:
              'This proposal was not based on the article’s current content, so it was not applied. ' +
              'Ask the assistant to read the article and propose the change again.',
          };
        } else if (err instanceof ArticlePatchApplyError) {
          next = {
            ...claimed,
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
            ...claimed,
            status: 'failed',
            result: null,
            error: messageOf(err),
          };
        }
      }
      return next;
    });
  }

  async reject(
    actor: AuthedUser,
    params: {
      conversationId: string;
      messageId: string;
      toolCallId: string;
    },
  ): Promise<{ toolCall: ChatToolCallDto; updatedToolCalls: ChatToolCallDto[] }> {
    // Pre-check for the precise ownership errors; the claim re-verifies.
    await this.loadPending(actor, {
      ...params,
      requestCompanyId: undefined,
      auditMeta: { ip: '0.0.0.0', userAgent: 'rejection' },
    });
    return this.withClaimedPending(actor, params, async (claimed) => {
      // A `pendingCreate` marker means a prior apply may have crashed
      // AFTER creating the article. Rejecting then would report
      // "rejected" while the created (possibly client-visible) article
      // stands, and — the call going terminal — would destroy the only
      // recovery path. Check the marker's article first: if it exists,
      // the truthful settle is the crashed apply's outcome, so finish
      // ITS bookkeeping instead of pretending the create didn't happen.
      // No marker, or no article (the crash was pre-create): the plain
      // reject is safe — nothing was created, the marker is inert
      // residue on a terminal call.
      if (claimed.pendingCreate) {
        const recovered = await this.findRecoveredArticle(actor, claimed.pendingCreate);
        if (recovered) {
          // The settle outcome (the actor's OWN prior action, with their
          // own confirmed values) may be reported — but the article's
          // CURRENT title is company data, and the lookup's `createdBy`
          // is identity, not continuing authorization: an actor removed
          // from the company since the crash must not learn a title
          // renamed after their access was revoked. Disclose the live
          // title only when `article.read` still passes; otherwise fall
          // back to the title the actor themselves confirmed (already on
          // their own DTO via the marker — zero new information).
          const read = await this.permissions.can(actor, 'article.read', {
            companyId: claimed.pendingCreate.companyId,
          });
          const title = read.allowed ? recovered.title : claimed.pendingCreate.title;
          return {
            ...claimed,
            status: 'applied',
            result: `Created article "${title}".`,
            error: null,
          };
        }
      }
      return {
        ...claimed,
        status: 'rejected',
        result: null,
        error: null,
      };
    });
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
      // The LLM referenced an article that doesn't exist. When the
      // user confirmed a create target (Save-as-article overrides +
      // company scope + a body), the pre-claim classification stamped
      // a durable `pendingCreate` marker and the apply took the marker
      // path INSTEAD of this method — a create-promotion can never
      // start here, where creation would run without idempotency.
      // Reaching this branch therefore means a plain miss (or the
      // article vanished between classification and the claim; the
      // client retries and the next attempt classifies as a create).
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

  /**
   * No-marker fallback for `create_article`: reachable only when the
   * pre-claim classification could NOT resolve a create intent (missing
   * company scope, or arguments that fail the schema). Reproduces the
   * original precise errors so those cases still settle as `failed`
   * with the same messages. If both guards pass, classification and
   * this method have drifted — fail loudly instead of creating without
   * idempotency.
   */
  private async applyCreate(
    toolCall: ChatToolCallDto,
    requestCompanyId: string | undefined,
  ): Promise<string> {
    if (!requestCompanyId) {
      throw new BadRequestException(
        'Cannot create an article without a company context. Open the chat from a company page first.',
      );
    }
    createArticleToolInputSchema.parse(stripNullArgs(toolCall.arguments));
    throw new Error(
      'create_article apply reached creation without an idempotency marker (classification drift).',
    );
  }

  /**
   * Create an article from the durable `pendingCreate` intent — the
   * single creation path for `create_article` applies AND update
   * create-promotions. The marker (committed before any article work)
   * pins the canonical company / title / folder / visibility and the
   * pre-generated article id; the body always comes from the persisted
   * tool-call arguments, which are immutable across retries.
   *
   * Recovery: if a prior attempt created the article but crashed before
   * the settle committed, the actor/company-scoped lookup finds it and
   * we settle without a second create. A P2002 on our own id (a racer
   * between lookup and create — same marker, so same intent) is the
   * only collision treated as recovery; anything else (e.g. the
   * per-company slug unique) rethrows.
   */
  private async applyCreateWithMarker(
    actor: AuthedUser,
    toolCall: ChatToolCallDto,
    marker: ChatPendingCreate,
    auditMeta: AuditMeta,
  ): Promise<string> {
    await this.assertArticleWrite(actor, marker.companyId);

    const recovered = await this.findRecoveredArticle(actor, marker);
    if (recovered) return `Created article "${recovered.title}".`;

    const raw = stripNullArgs(toolCall.arguments);
    const markdown = typeof raw['markdown'] === 'string' ? raw['markdown'] : null;
    if (!markdown) {
      // Classification guarantees a body; defensive for corrupt rows.
      throw new BadRequestException('Tool call did not include a body to create an article from.');
    }
    // Same dedupe as `applyUpdate`: if the LLM's body opens with the
    // same heading it also passed as `title`, drop the heading line so
    // the rendered article doesn't show the title twice.
    const parsed = splitMarkdownTitleAndBody(markdown);
    const input: CreateArticleInput = {
      editorMode: 'markdown',
      title: marker.title,
      markdownSource: parsed.body,
      ...(marker.folderId ? { folderId: marker.folderId } : {}),
      visibleToClients: marker.visibleToClients,
    };

    try {
      const created = await this.articles.create(actor, marker.companyId, input, auditMeta, {
        id: marker.articleId,
      });
      return `Created article "${created.title}".`;
    } catch (err) {
      // Discriminate by the existence of OUR row, not by constraint
      // metadata: if the marker's article now exists, a racer with the
      // same intent created it — recovered, not failed.
      const recoveredAfter = await this.findRecoveredArticle(actor, marker);
      if (recoveredAfter) return `Created article "${recoveredAfter.title}".`;
      throw err;
    }
  }

  /**
   * Actor/company-scoped recovery lookup for a `pendingCreate` marker.
   * Identity is PK + company + creator — deep-field equality is
   * deliberately NOT required, because post-crash edits to the created
   * article are legitimate.
   */
  private async findRecoveredArticle(
    actor: AuthedUser,
    marker: ChatPendingCreate,
  ): Promise<{ id: string; title: string } | null> {
    return this.prisma.article.findFirst({
      where: { id: marker.articleId, companyId: marker.companyId, createdBy: actor.id },
      select: { id: true, title: true },
    });
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
    return { toolCall, turnContext: msg.turnContext };
  }

  /**
   * Resolve the canonical create intent for this apply, or null when it
   * is not a satisfiable create (then the ordinary work path reproduces
   * the precise error). Never throws for unsatisfied inputs — those
   * must keep settling as `failed` exactly as before.
   */
  private async resolveCreateIntent(
    toolCall: ChatToolCallDto,
    scopeCompanyId: string | undefined,
    overrides: CreateArticleOverrides | undefined,
  ): Promise<CreateIntent | null> {
    if (!scopeCompanyId) return null;
    const raw = stripNullArgs(toolCall.arguments);
    if (toolCall.name === 'create_article') {
      const parsed = createArticleToolInputSchema.safeParse(raw);
      if (!parsed.success) return null;
      // Prefer the user-confirmed values from the Save-as-article
      // dialog over the LLM-supplied `args.folder_id` /
      // `args.visible_to_clients` / `args.title`. The dialog forces a
      // pick from the live company tree, so a stray LLM hallucination
      // can never reach the articles service. `?? true` mirrors the
      // articles service default so the marker records the EFFECTIVE
      // visibility.
      return {
        companyId: scopeCompanyId,
        title: overrides?.title ?? parsed.data.title,
        folderId: overrides !== undefined ? overrides.folderId : (parsed.data.folder_id ?? null),
        visibleToClients:
          overrides !== undefined
            ? overrides.visibleToClients
            : (parsed.data.visible_to_clients ?? true),
      };
    }
    if (toolCall.name === 'update_article') {
      // The create-promotion: a hallucinated `article_id` with a user
      // confirmation and a body becomes a create. Same conditions the
      // promotion branch used to check inside `applyUpdate`.
      if (!overrides) return null;
      const parsed = updateArticleToolInputSchema.safeParse(raw);
      if (!parsed.success || !parsed.data.markdown) return null;
      const resolves = await this.articles.findCompanyIdForArticle(parsed.data.article_id);
      if (resolves !== null) return null;
      return {
        companyId: scopeCompanyId,
        title: overrides.title,
        folderId: overrides.folderId,
        visibleToClients: overrides.visibleToClients,
      };
    }
    return null;
  }

  /**
   * Commit the create-intent marker BEFORE any article work, in its own
   * claim transaction. An existing marker is canonical: a matching
   * retry reuses it (same pre-generated article id → recovery instead
   * of a duplicate), a mismatched retry is rejected with the stable
   * `ARTICLE_CREATE_RECOVERY_PENDING_CODE` so clients re-read and lock
   * their confirmation UI to the original intent.
   */
  private async ensureCreateMarker(
    actor: AuthedUser,
    params: { conversationId: string; messageId: string; toolCallId: string },
    intent: CreateIntent,
  ): Promise<ChatPendingCreate> {
    return this.prisma.$transaction(
      async (tx) => {
        const calls = await this.claimPendingCalls(tx, actor, params);
        const call = calls.find((c) => c.id === params.toolCallId)!;
        const existing = call.pendingCreate;
        if (existing) {
          const matches =
            existing.companyId === intent.companyId &&
            existing.title === intent.title &&
            existing.folderId === intent.folderId &&
            existing.visibleToClients === intent.visibleToClients;
          if (!matches) {
            throw new BadRequestException({
              message:
                'A previous apply attempt is being completed; the original confirmation applies.',
              code: ARTICLE_CREATE_RECOVERY_PENDING_CODE,
            });
          }
          return existing;
        }
        const marker: ChatPendingCreate = { articleId: randomUUID(), ...intent };
        const finalCalls = replaceCall(calls, { ...call, pendingCreate: marker });
        await this.chat.updateMessageToolCalls(params.messageId, finalCalls, tx);
        return marker;
      },
      { timeout: SETTLE_TX_TIMEOUT_MS, maxWait: 5_000 },
    );
  }

  /**
   * Run `work` with the tool call claimed: the message row is locked
   * `FOR UPDATE` through an ownership-constrained query, the call is
   * re-verified `pending` under that lock, and the settle write goes
   * through the same transaction. Concurrent settles fully serialize —
   * the loser re-reads the committed array, sees non-pending, and gets
   * the 400 — so no double-apply and no sibling-status clobber.
   */
  private async withClaimedPending(
    actor: AuthedUser,
    params: { conversationId: string; messageId: string; toolCallId: string },
    work: (claimed: ChatToolCallDto) => Promise<ChatToolCallDto>,
  ): Promise<{ toolCall: ChatToolCallDto; updatedToolCalls: ChatToolCallDto[] }> {
    return this.prisma.$transaction(
      async (tx) => {
        const calls = await this.claimPendingCalls(tx, actor, params);
        const claimed = calls.find((c) => c.id === params.toolCallId)!;
        const next = await work(claimed);
        const finalCalls = replaceCall(calls, next);
        await this.chat.updateMessageToolCalls(params.messageId, finalCalls, tx);
        return { toolCall: next, updatedToolCalls: finalCalls };
      },
      { timeout: SETTLE_TX_TIMEOUT_MS, maxWait: 5_000 },
    );
  }

  /**
   * Ownership-constrained claim: one statement carries the lock AND the
   * query-layer authorization (message + conversation + owning user), so
   * a caller who guesses a foreign message UUID matches zero rows and
   * acquires nothing (CLAUDE.md §1 — never lock before authorizing).
   * `FOR UPDATE OF m` locks only the message row; the conversation row
   * stays unlocked so unrelated messages' settles don't serialize.
   */
  private async claimPendingCalls(
    tx: Prisma.TransactionClient,
    actor: AuthedUser,
    params: { conversationId: string; messageId: string; toolCallId: string },
  ): Promise<ChatToolCallDto[]> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT m.id FROM chat_messages m
      JOIN chat_conversations c ON c.id = m.conversation_id
      WHERE m.id = ${params.messageId}::uuid
        AND m.conversation_id = ${params.conversationId}::uuid
        AND c.user_id = ${actor.id}::uuid
      FOR UPDATE OF m
    `);
    if (locked.length === 0) throw new NotFoundException('Message not found');
    const row = await tx.chatMessage.findFirst({
      where: { id: params.messageId },
      select: { toolCalls: true },
    });
    const calls = parseToolCalls(row?.toolCalls ?? null) ?? [];
    const call = calls.find((c) => c.id === params.toolCallId);
    if (!call) throw new NotFoundException('Tool call not found on this message.');
    if (call.status !== 'pending') {
      throw new BadRequestException(
        `Tool call is already ${call.status}; only pending calls can be acted on.`,
      );
    }
    return calls;
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
