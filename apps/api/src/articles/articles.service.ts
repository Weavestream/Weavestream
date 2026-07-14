import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Article, type ArticleVersion } from '@prisma/client';
import {
  createArticleSchema,
  markdownExcerpt,
  markdownToPlaintext,
  tiptapExcerpt,
  tiptapToPlaintext,
  isValidTiptapDoc,
  type ArticleVersionDetail,
  type ArticleVersionSummary,
  type CreateArticleInput,
  type MoveArticleInput,
  type UpdateArticleInput,
  type UserRole,
} from '@weavestream/shared';
import { requireTenantContext } from '@weavestream/shared/server';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import { StarsService } from '../stars/stars.service.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { RelationsService } from '../relations/relations.service.js';
import { scopedCompanyLookupWhere } from '../ai-tools/entity-scope.js';
import { diffRemovedUploadIds, extractEmbeddedUploadIds } from './article-uploads.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { hasEligibleNativeBinding } from '../integrations/reconstruction/native-binding-ownership.js';

export interface AuditMeta {
  ip: string;
  userAgent: string;
}

export interface IntegrationArticleWriteInput {
  tx?: Prisma.TransactionClient;
  companyId: string;
  integrationId: string;
  integrationCompanyMappingId: string;
  resourceId: string;
  externalId: string;
  auditActorId: string;
  dryRun: boolean;
  existingTargetId?: string | null;
  title: string;
  slug: string;
  folderId: string | null;
  markdown: string;
  visibleToClients: boolean;
}

export interface IntegrationArticleWriteResult {
  targetId: string;
  companyId: string;
  change: 'created' | 'updated' | 'unchanged' | 'restored' | 'blocked';
  gap?: {
    kind: 'missing_dependency' | 'validation' | 'ambiguous' | 'synchronization_error';
    message: string;
    details?: { reasonCode?: string; candidateCount?: number };
  };
}

const INTEGRATION_AUDIT_META: AuditMeta = {
  ip: '0.0.0.0',
  userAgent: 'weavestream-worker/integration-reconstruction',
};

/**
 * Thrown by `update()` when an `expectedRevision` guard matched zero
 * rows — the article was edited (or archived) after the caller's base
 * revision was captured. Only the AI chat apply path passes
 * `expectedRevision`, and it catches this explicitly; the guard rides
 * the WHERE clause of the UPDATE, so there is no check-then-act window.
 */
export class StaleArticleError extends Error {
  constructor() {
    super('Article was modified since the base revision was captured.');
    this.name = 'StaleArticleError';
  }
}

export interface ActorRef {
  id: string;
  name: string;
}

export interface SerializedArticle {
  id: string;
  companyId: string;
  folderId: string | null;
  title: string;
  slug: string;
  editorMode: 'tiptap' | 'markdown';
  /**
   * Tiptap JSON when `editorMode` is `tiptap`, otherwise `null` for
   * Markdown articles.
   */
  content: Prisma.JsonValue | null;
  /** Non-null for Markdown articles; Tiptap rows store the body in `content`. */
  markdownSource: string | null;
  contentPlaintext: string;
  excerpt: string | null;
  visibleToClients: boolean;
  /**
   * Monotonic optimistic-concurrency token, bumped on every
   * content-affecting write including autosave drafts. The AI chat
   * captures it when article content is shown to the model and guards
   * Apply on it.
   */
  revision: number;
  archivedAt: Date | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdByUser: ActorRef | null;
  updatedByUser: ActorRef | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * True if the signed-in user has starred this article.
   */
  isStarred: boolean;
  /**
   * True if there is an in-progress autosave draft for this article.
   * Populated on detail-returning endpoints (`getById`, `getBySlug`,
   * mutation responses). List responses always set this to `false` to
   * avoid an N+1 — the editor is the only consumer that needs the
   * accurate value, and it always loads a detail before opening.
   */
  hasDraft: boolean;
}

/**
 * Fields whose changes are tracked by version history. `companyId`,
 * `archivedAt`, audit columns, and computed mirrors (`contentPlaintext`,
 * `excerpt`) are deliberately excluded — they're either tenant scope
 * (not "content") or derived state that always rides along with the
 * primary fields.
 */
const VERSIONED_FIELDS = [
  'title',
  'slug',
  'folderId',
  'visibleToClients',
  'editorMode',
  'content',
  'markdownSource',
] as const;
type VersionedField = (typeof VERSIONED_FIELDS)[number];

export interface ArticleListOptions {
  folderId?: string | 'root' | null;
  q?: string;
  includeArchived?: boolean;
  limit?: number;
  cursor?: string;
}

@Injectable()
export class ArticlesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly stars: StarsService,
    private readonly uploads: UploadsService,
    private readonly relations: RelationsService,
  ) {}

  // ------------------------------------------------------------------
  // Read
  // ------------------------------------------------------------------

  async list(
    actor: AuthedUser,
    companyId: string,
    options: ArticleListOptions = {},
  ): Promise<{ items: SerializedArticle[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const where: Prisma.ArticleWhereInput = { companyId };
    if (!options.includeArchived) where.archivedAt = null;
    if (options.folderId === 'root') where.folderId = null;
    else if (options.folderId) where.folderId = options.folderId;
    if (options.q) where.title = { contains: options.q, mode: 'insensitive' };
    if (actor.role === 'CLIENT_USER') where.visibleToClients = true;

    const rows = await this.prisma.article.findMany({
      where,
      orderBy: [{ archivedAt: 'asc' }, { title: 'asc' }],
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const items = slice.map((r) => this.serialize(r, actor.role));
    await this.hydrateActors(items);
    return {
      items,
      nextCursor: hasMore ? slice[slice.length - 1]!.id : null,
    };
  }

  /**
   * Resolve the tenant company id for an article without requiring the
   * caller to already know it. Used by callers that learned about the
   * article id from a less-trusted source (e.g. an LLM tool call) and
   * need to derive the canonical scope before running a permission
   * check. Returns `null` when the article does not exist — or is not
   * within the acting user's tenant scope, which callers must treat
   * identically (non-enumeration).
   *
   * WS-030: previously queried `findUnique({ where: { id } })`, which
   * the Prisma tenant middleware rejects for membership-scoped actors
   * (no `companyId` filter). Now phrased per scope via
   * `scopedCompanyLookupWhere`: read-bypass actors look up by id,
   * membership-scoped actors add `companyId IN allowedCompanyIds`.
   */
  async findCompanyIdForArticle(id: string): Promise<string | null> {
    const where = scopedCompanyLookupWhere(requireTenantContext(), id);
    if (where === null) return null;
    const row = await this.prisma.article.findFirst({
      where,
      select: { companyId: true },
    });
    return row?.companyId ?? null;
  }

  async getById(
    actor: AuthedUser,
    companyId: string,
    id: string,
  ): Promise<SerializedArticle> {
    const row = await this.prisma.article.findFirst({ where: { id, companyId } });
    if (!row) throw new NotFoundException();
    if (actor.role === 'CLIENT_USER' && !row.visibleToClients) {
      throw new NotFoundException();
    }
    const out = this.serialize(row, actor.role);
    out.isStarred = await this.stars.isStarred(actor.id, 'article', id);
    out.hasDraft = await this.resolveHasDraft(companyId, id);
    await this.hydrateActors([out]);
    return out;
  }

  async getBySlug(
    actor: AuthedUser,
    companyId: string,
    slug: string,
  ): Promise<SerializedArticle> {
    const row = await this.prisma.article.findFirst({
      where: { companyId, slug, archivedAt: null },
    });
    if (!row) throw new NotFoundException();
    if (actor.role === 'CLIENT_USER' && !row.visibleToClients) {
      throw new NotFoundException();
    }
    const out = this.serialize(row, actor.role);
    out.isStarred = await this.stars.isStarred(actor.id, 'article', row.id);
    out.hasDraft = await this.resolveHasDraft(companyId, row.id);
    await this.hydrateActors([out]);
    return out;
  }

  // ------------------------------------------------------------------
  // Write
  // ------------------------------------------------------------------

  async create(
    actor: AuthedUser,
    companyId: string,
    input: CreateArticleInput,
    meta: AuditMeta,
  ): Promise<SerializedArticle> {
    // HTTP requests run through `createArticleSchema` (Zod) which
    // rewrites legacy bodies without `editorMode` to Tiptap. Direct
    // in-process calls (e.g. tests, CLI) may still omit it — match that
    // behaviour here.
    const normalized: CreateArticleInput =
      (input as { editorMode?: string }).editorMode == null &&
      (input as { content?: unknown }).content !== undefined
        ? ({ ...(input as object), editorMode: 'tiptap' } as CreateArticleInput)
        : input;

    if (normalized.folderId) {
      await this.assertFolderInCompany(companyId, normalized.folderId);
    }

    const slug = normalized.slug ?? this.slugifyTitle(normalized.title);
    await this.assertSlugFree(companyId, slug, null);

    const body = this.projectArticleBody(normalized, normalized.excerpt);
    const data = {
      companyId,
      folderId: normalized.folderId ?? null,
      title: normalized.title,
      slug,
      visibleToClients: normalized.visibleToClients ?? true,
      createdBy: actor.id,
      updatedBy: actor.id,
      ...body,
    };

    // Single transaction: insert the article and its first published
    // version atomically. Mirrors `PasswordsService.create` so an
    // operator who reads history immediately after creating the article
    // is guaranteed to see v1 (rather than an empty list driven by a
    // half-committed row). The version row carries the full set of
    // VERSIONED_FIELDS in `changedFields` — every authoring field
    // started somewhere.
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.article.create({ data });
      await tx.articleVersion.create({
        data: {
          articleId: row.id,
          companyId,
          version: 1,
          isDraft: false,
          ...this.versionRowBodyFromArticle(row),
          changedFields: [...VERSIONED_FIELDS],
          changedBy: actor.id,
          changeReason: 'initial version',
        },
      });
      return row;
    });

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.article.create,
      entityType: 'Article',
      entityId: created.id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: this.auditFields(created),
    });
    const out = this.serialize(created, actor.role);
    // No autosave path on create — the brand-new article cannot have
    // a draft row.
    out.hasDraft = false;
    await this.hydrateActors([out]);
    return out;
  }

  async update(
    actor: AuthedUser,
    companyId: string,
    id: string,
    input: UpdateArticleInput,
    meta: AuditMeta,
    opts?: {
      /**
       * Optimistic-concurrency guard for callers whose edit was drafted
       * against a known `revision` (the AI chat apply path). Rides the
       * WHERE clause of the article UPDATE together with
       * `archived_at IS NULL`; a zero-row match throws
       * {@link StaleArticleError} and aborts the transaction — no
       * version row, no audit row.
       */
      expectedRevision?: number;
    },
  ): Promise<SerializedArticle> {
    const isDraftWrite = input.draft === true;
    const existing = await this.prisma.article.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundException();
    if (existing.archivedAt) {
      throw new BadRequestException('Cannot edit an archived article — restore it first.');
    }

    if (input.folderId !== undefined && input.folderId !== null) {
      await this.assertFolderInCompany(companyId, input.folderId);
    }

    if (input.content !== undefined && existing.editorMode === 'markdown' && input.editorMode !== 'tiptap') {
      throw new BadRequestException({
        error: 'InvalidArticleContent',
        message:
          'This article is in Markdown. Send editorMode: "tiptap" and content when switching to Tiptap, or update markdownSource.',
      });
    }
    if (input.markdownSource !== undefined && existing.editorMode === 'tiptap' && input.editorMode !== 'markdown') {
      throw new BadRequestException({
        error: 'InvalidArticleContent',
        message:
          'This article uses Tiptap. Send editorMode: "markdown" and markdownSource when switching to Markdown, or update content.',
      });
    }
    if (
      input.editorMode !== undefined &&
      input.content === undefined &&
      input.markdownSource === undefined &&
      input.editorMode !== existing.editorMode
    ) {
      throw new BadRequestException({
        error: 'InvalidArticleContent',
        message: 'Include content (Tiptap) or markdownSource when changing editorMode.',
      });
    }

    if (input.slug !== undefined && input.slug !== existing.slug) {
      await this.assertSlugFree(companyId, input.slug, id);
    }

    // NOTE: `updateMany` accepts scalar field writes only — no relation
    // operations like `folder: { connect | disconnect }`. We therefore
    // write the scalar FK `folderId` directly. See the `move` method for
    // the same idiom.
    const data: Prisma.ArticleUncheckedUpdateManyInput = { updatedBy: actor.id };
    if (input.title !== undefined) data.title = input.title;
    if (input.slug !== undefined) data.slug = input.slug;
    if (input.folderId !== undefined) {
      data.folderId = input.folderId ?? null;
    }
    if (input.content !== undefined) {
      Object.assign(
        data,
        this.projectArticleBody(
          { editorMode: 'tiptap', content: input.content },
          input.excerpt ?? undefined,
        ),
      );
    } else if (input.markdownSource !== undefined) {
      Object.assign(
        data,
        this.projectArticleBody(
          { editorMode: 'markdown', markdownSource: input.markdownSource },
          input.excerpt ?? undefined,
        ),
      );
    }
    if (input.excerpt !== undefined) data.excerpt = input.excerpt;
    if (input.visibleToClients !== undefined) data.visibleToClients = input.visibleToClients;

    // Bump the optimistic-concurrency token on content-affecting writes
    // (including autosave drafts — they always carry body fields). The
    // decision is made from the INPUT, not the post-hoc changed-fields
    // diff, so a no-op PATCH with an identical body still bumps it:
    // conservative in the safe direction, since a stale-marked proposal
    // just means re-asking the assistant.
    const contentAffecting =
      input.title !== undefined ||
      input.content !== undefined ||
      input.markdownSource !== undefined ||
      input.excerpt !== undefined ||
      input.editorMode !== undefined;
    if (contentAffecting) data.revision = { increment: 1 };

    // Single transaction wraps the article row update + version row
    // write so a partial commit cannot leave the live article ahead
    // of (or behind) its history. `updateMany` + refetch keeps the
    // tenant middleware's `companyId` filter in the `where` clause —
    // plain `update` would only accept `{ id }`. See assets.service
    // for the same idiom.
    const txResult = await this.prisma.$transaction(async (tx) => {
      const guarded = opts?.expectedRevision !== undefined;
      const writeResult = await tx.article.updateMany({
        where: {
          id,
          companyId,
          // The concurrency guard lives IN the WHERE — never as a
          // separate read-then-write check. `archivedAt: null` rides
          // along so an archive racing the apply also refuses.
          ...(guarded
            ? { revision: opts.expectedRevision, archivedAt: null }
            : {}),
        },
        data,
      });
      if (guarded && writeResult.count === 0) {
        throw new StaleArticleError();
      }
      const updated = await tx.article.findFirstOrThrow({
        where: { id, companyId },
      });

      const changedFields = this.computeChangedFields(existing, updated);

      const existingDraft = await tx.articleVersion.findFirst({
        where: { articleId: id, companyId, isDraft: true },
      });

      // No-op edits normally produce neither a version row nor an audit
      // row, so a stray PATCH with an identical body doesn't bloat
      // history or audit. The one exception is an explicit Save landing
      // on an article that still holds an in-progress autosave draft:
      // autosave writes the live article row AND the draft row to the
      // same body, so a later Save (manual, or via the AI chat-apply
      // path which always saves explicitly) reports no field change yet
      // must still promote/clear that draft. Skipping it here is what
      // left an article stuck showing "draft in progress" after saving.
      if (changedFields.length === 0 && !(existingDraft && !isDraftWrite)) {
        return { updated, versionKind: null as 'draft' | 'publish' | null };
      }

      const versionBody = this.versionRowBodyFromArticle(updated);

      if (isDraftWrite) {
        // Autosave path: coalesce successive PATCHes into a single
        // rolling draft row. The partial unique index
        // `article_versions_one_draft_per_article_uniq` is our
        // backstop against a race producing two drafts.
        if (existingDraft) {
          // `updateMany` keeps the Prisma tenant-scope middleware happy
          // (it requires `where.companyId` or `data.companyId` on every
          // write to a tenant-scoped model). `update`'s where shape is
          // restricted to the model's unique keys, which excludes
          // `companyId` since the table's only unique is `(articleId,
          // version)`. `id` is still unique so the row count is always 1.
          await tx.articleVersion.updateMany({
            where: { id: existingDraft.id, companyId },
            data: {
              ...versionBody,
              isDraft: true,
              changedFields: this.unionFields(
                existingDraft.changedFields,
                changedFields,
              ),
              changedBy: actor.id,
              changeReason: existingDraft.changeReason ?? 'autosave draft',
            },
          });
        } else {
          const max = await tx.articleVersion.aggregate({
            where: { articleId: id, companyId },
            _max: { version: true },
          });
          await tx.articleVersion.create({
            data: {
              articleId: id,
              companyId,
              version: (max._max.version ?? 0) + 1,
              isDraft: true,
              ...versionBody,
              changedFields,
              changedBy: actor.id,
              changeReason: 'autosave draft',
            },
          });
        }
        return { updated, versionKind: 'draft' as const };
      }

      // Explicit Save: promote any existing draft (reuse its version
      // number — matches the spec'd "Save → version 2" workflow) or
      // insert a fresh published row.
      if (existingDraft) {
        await tx.articleVersion.updateMany({
          where: { id: existingDraft.id, companyId },
          data: {
            ...versionBody,
            isDraft: false,
            changedFields: this.unionFields(
              existingDraft.changedFields,
              changedFields,
            ),
            changedBy: actor.id,
            changeReason: null,
          },
        });
      } else {
        const max = await tx.articleVersion.aggregate({
          where: { articleId: id, companyId },
          _max: { version: true },
        });
        await tx.articleVersion.create({
          data: {
            articleId: id,
            companyId,
            version: (max._max.version ?? 0) + 1,
            isDraft: false,
            ...versionBody,
            changedFields,
            changedBy: actor.id,
          },
        });
      }
      return { updated, versionKind: 'publish' as const };
    });

    const { updated, versionKind } = txResult;

    // No-op silent return — preserves pre-versioning behavior.
    if (versionKind === null) {
      const out = this.serialize(updated, actor.role);
      out.hasDraft = await this.resolveHasDraft(companyId, id);
      await this.hydrateActors([out]);
      return out;
    }

    // Tombstone any upload the operator just unembedded so it leaves
    // the photos gallery / attachment panels alongside the image they
    // removed. We diff both Tiptap and Markdown bodies — the URL
    // shape is identical, so a single regex sweep covers either mode.
    // Done outside the tx because `UploadsService.softDeleteManyForArticle`
    // owns its own audit + tenant checks; in the worst case (article
    // tx commits, upload tombstone tx fails) the upload reaper will
    // clean up later.
    let removedUploads = 0;
    if (input.content !== undefined || input.markdownSource !== undefined) {
      const removed = diffRemovedUploadIds(
        existing.content ?? existing.markdownSource,
        updated.content ?? updated.markdownSource,
      );
      if (removed.length > 0) {
        // An upload that was removed from the *live* body may still be
        // referenced by a historical `ArticleVersion` row (typical when
        // the operator restores an older version that pre-dates the
        // image, or undoes a delete by saving the prior body again). In
        // either case, soft-deleting the upload here would make the
        // image disappear from the photos gallery *and* from any
        // history-panel preview of versions that still embed it — even
        // though those versions are still restorable. We only tombstone
        // uploads that are truly orphaned: not in the new live body,
        // and not in any non-draft version row.
        const stillReferenced = await this.findUploadsReferencedInHistory(
          companyId,
          id,
          removed,
        );
        const orphaned = removed.filter((u) => !stillReferenced.has(u));
        if (orphaned.length > 0) {
          const result = await this.uploads.softDeleteManyForArticle(
            companyId,
            orphaned,
          );
          removedUploads = result.softDeleted;
        }
      }
    }

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.article.update,
      entityType: 'Article',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: this.auditFields(existing),
      // `kind` distinguishes coalesced draft writes from explicit Save
      // promotions, which would otherwise be indistinguishable in the
      // audit log (both run through the same code path).
      after: {
        ...this.auditFields(updated),
        kind: versionKind,
        ...(removedUploads > 0 ? { removedUploads } : {}),
      },
    });
    const out = this.serialize(updated, actor.role);
    out.hasDraft = versionKind === 'draft';
    await this.hydrateActors([out]);
    return out;
  }

  /**
   * Non-request Markdown writer for reconstruction. A target may only be
   * updated by an explicit existing binding; deterministic slug collisions
   * without a binding are reported instead of overwriting manual content.
   */
  async writeFromIntegration(
    input: IntegrationArticleWriteInput,
  ): Promise<IntegrationArticleWriteResult> {
    const runTransaction = <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) =>
      input.tx ? callback(input.tx) : this.prisma.$transaction(callback);
    await this.audit.assertIntegrationActor(input.auditActorId, input.companyId);
    let native: Extract<CreateArticleInput, { editorMode: 'markdown' }>;
    try {
      native = createArticleSchema.parse({
        title: input.title,
        slug: input.slug,
        folderId: input.folderId,
        editorMode: 'markdown',
        markdownSource: input.markdown,
        visibleToClients: input.visibleToClients,
      }) as Extract<CreateArticleInput, { editorMode: 'markdown' }>;
    } catch {
      return articleBlocked(input.companyId, 'validation', 'Article input failed native validation.', 'native_validation');
    }
    if (native.folderId) {
      const folder = await this.prisma.folder.findFirst({
        where: { id: native.folderId, companyId: input.companyId, archivedAt: null },
        select: { id: true },
      });
      if (!folder) {
        return articleBlocked(input.companyId, 'missing_dependency', 'The article folder was not found.', 'dependency_not_found');
      }
    }

    const sourceSlug = native.slug ?? input.slug;
    const bound = input.existingTargetId
      ? await this.prisma.article.findUnique({ where: { id: input.existingTargetId } })
      : null;
    if (bound && bound.companyId !== input.companyId) {
      return { targetId: bound.id, companyId: bound.companyId, change: 'blocked' };
    }
    if (input.existingTargetId && !bound) {
      return articleBlocked(input.companyId, 'missing_dependency', 'The bound article no longer exists.', 'target_not_found', input.existingTargetId);
    }
    if (bound && (bound.archivedAt || bound.slug !== sourceSlug)) {
      const slugOwner = await this.prisma.article.findFirst({
        where: {
          companyId: input.companyId,
          slug: sourceSlug,
          archivedAt: null,
          NOT: { id: bound.id },
        },
        select: { id: true },
      });
      if (slugOwner) {
        return articleBlocked(input.companyId, 'ambiguous', 'Another article owns the source slug.', 'manual_ownership', slugOwner.id, 1);
      }
    }
    if (!bound) {
      const collision = await this.prisma.article.findFirst({
        where: { companyId: input.companyId, slug: sourceSlug, archivedAt: null },
        select: { id: true },
      });
      if (collision) {
        return articleBlocked(input.companyId, 'ambiguous', 'An unbound article already owns this slug.', 'manual_ownership', collision.id, 1);
      }
    }

    const body = this.projectArticleBody(native);
    const data = {
      folderId: native.folderId ?? null,
      title: native.title,
      slug: sourceSlug,
      visibleToClients: native.visibleToClients ?? true,
      ...body,
    };
    const restored = bound?.archivedAt != null;
    const changed =
      !bound ||
      bound.folderId !== data.folderId ||
      bound.title !== data.title ||
      bound.slug !== data.slug ||
      bound.visibleToClients !== data.visibleToClients ||
      bound.editorMode !== data.editorMode ||
      bound.markdownSource !== data.markdownSource;
    if (bound && (input.dryRun || (!changed && !restored))) {
      if (!(await this.hasEligibleArticleBinding(input.tx ?? this.prisma, input, bound.id))) {
        return articleBlocked(input.companyId, 'ambiguous', 'The existing article is not owned by an eligible reconstruction binding.', 'manual_ownership', bound.id, 1);
      }
    }
    if (input.dryRun) {
      return {
        targetId: bound?.id ?? '',
        companyId: input.companyId,
        change: bound ? (restored ? 'restored' : changed ? 'updated' : 'unchanged') : 'created',
      };
    }

    let article: Article;
    let change: IntegrationArticleWriteResult['change'];
    if (!bound) {
      article = await runTransaction(async (tx) => {
        const row = await tx.article.create({
          data: {
            companyId: input.companyId,
            ...data,
            createdBy: input.auditActorId,
            updatedBy: input.auditActorId,
          },
        });
        await tx.articleVersion.create({
          data: {
            articleId: row.id,
            companyId: input.companyId,
            version: 1,
            isDraft: false,
            ...this.versionRowBodyFromArticle(row),
            changedFields: [...VERSIONED_FIELDS],
            changedBy: input.auditActorId,
            changeReason: `integration:${input.integrationId}`,
          },
        });
        await this.audit.logWithClient(tx, {
          actorId: input.auditActorId,
          action: AUDIT_ACTIONS.article.create,
          entityType: 'Article',
          entityId: row.id,
          companyId: input.companyId,
          ip: INTEGRATION_AUDIT_META.ip,
          userAgent: INTEGRATION_AUDIT_META.userAgent,
          after: { integrationId: input.integrationId, slug: row.slug },
        });
        return row;
      });
      change = 'created';
    } else if (changed || restored) {
      const outcome = await runTransaction(async (tx) => {
        if (!(await this.hasEligibleArticleBinding(tx, input, bound.id))) {
          return { blocked: true as const };
        }
        await tx.article.updateMany({
          where: { id: bound.id, companyId: input.companyId },
          data: {
            ...data,
            ...(restored ? { archivedAt: null } : {}),
            revision: { increment: 1 },
            updatedBy: input.auditActorId,
          },
        });
        const updated = await tx.article.findFirstOrThrow({
          where: { id: bound.id, companyId: input.companyId },
        });
        if (changed) {
          const max = await tx.articleVersion.aggregate({
            where: { articleId: bound.id, companyId: input.companyId },
            _max: { version: true },
          });
          await tx.articleVersion.create({
            data: {
              articleId: bound.id,
              companyId: input.companyId,
              version: (max._max.version ?? 0) + 1,
              isDraft: false,
              ...this.versionRowBodyFromArticle(updated),
              changedFields: this.computeChangedFields(bound, updated),
              changedBy: input.auditActorId,
              changeReason: `integration:${input.integrationId}`,
            },
          });
        }
        await this.audit.logWithClient(tx, {
          actorId: input.auditActorId,
          action: restored ? AUDIT_ACTIONS.article.restore : AUDIT_ACTIONS.article.update,
          entityType: 'Article',
          entityId: updated.id,
          companyId: input.companyId,
          ip: INTEGRATION_AUDIT_META.ip,
          userAgent: INTEGRATION_AUDIT_META.userAgent,
          after: { integrationId: input.integrationId, slug: updated.slug },
        });
        return { blocked: false as const, article: updated };
      });
      if (outcome.blocked) {
        return articleBlocked(input.companyId, 'ambiguous', 'The existing article is not owned by an eligible reconstruction binding.', 'manual_ownership', bound.id, 1);
      }
      article = outcome.article;
      change = restored ? 'restored' : 'updated';
    } else {
      article = bound;
      change = 'unchanged';
    }

    return { targetId: article.id, companyId: input.companyId, change };
  }

  private hasEligibleArticleBinding(
    client: Parameters<typeof hasEligibleNativeBinding>[0],
    input: IntegrationArticleWriteInput,
    targetId: string,
  ): Promise<boolean> {
    return hasEligibleNativeBinding(client, {
      integrationCompanyMappingId: input.integrationCompanyMappingId,
      resourceId: input.resourceId,
      externalId: input.externalId,
      integrationId: input.integrationId,
      companyId: input.companyId,
      targetKind: 'article',
      targetId,
    });
  }

  async move(
    actor: AuthedUser,
    companyId: string,
    id: string,
    input: MoveArticleInput,
    meta: AuditMeta,
  ): Promise<SerializedArticle> {
    const existing = await this.prisma.article.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundException();
    if (existing.archivedAt) {
      throw new BadRequestException('Cannot move an archived article — restore it first.');
    }
    if (input.folderId) {
      await this.assertFolderInCompany(companyId, input.folderId);
    }
    await this.prisma.article.updateMany({
      where: { id, companyId },
      data: { folderId: input.folderId, updatedBy: actor.id },
    });
    const updated = await this.prisma.article.findFirstOrThrow({
      where: { id, companyId },
    });
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.article.move,
      entityType: 'Article',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { folderId: existing.folderId },
      after: { folderId: updated.folderId },
    });
    const out = this.serialize(updated, actor.role);
    out.hasDraft = await this.resolveHasDraft(companyId, id);
    await this.hydrateActors([out]);
    return out;
  }

  async archive(
    actor: AuthedUser,
    companyId: string,
    id: string,
    meta: AuditMeta,
  ): Promise<SerializedArticle> {
    const existing = await this.prisma.article.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundException();
    if (existing.archivedAt) throw new BadRequestException('Already archived');

    // Single tx so a draft-discard can't half-commit (drop the draft
    // row without setting archivedAt, or vice versa). The article row
    // ends up holding either:
    //   - the last published version's body (if a draft was active —
    //     we revert before setting archivedAt so a Restore later
    //     surfaces the "real" content, not the dropped autosave), OR
    //   - its current body (no draft was in flight).
    const { updated, discardedDraftVersion, removedUploadIds } =
      await this.prisma.$transaction(async (tx) => {
        const draft = await tx.articleVersion.findFirst({
          where: { articleId: id, companyId, isDraft: true },
        });
        let discardedDraftVersion: number | null = null;
        let removedUploadIds: string[] = [];

        if (draft) {
          const lastPublished = await tx.articleVersion.findFirst({
            where: { articleId: id, companyId, isDraft: false },
            orderBy: { version: 'desc' },
          });
          if (lastPublished) {
            await tx.article.updateMany({
              where: { id, companyId },
              data: this.articleRowFromVersion(lastPublished, actor.id),
            });
            // Uploads embedded only in the draft must follow it into
            // the bin; otherwise the photos gallery shows orphans
            // after the article is archived.
            removedUploadIds = diffRemovedUploadIds(
              draft.content ?? draft.markdownSource,
              lastPublished.content ?? lastPublished.markdownSource,
            );
          }
          // If no published row exists (pathological — migration
          // backfilled v1 for every article), leave the article row
          // alone and just drop the draft.
          // `deleteMany` keeps tenant scoping (see `update()` for the
          // same idiom — `delete`'s where is unique-only so it can't
          // carry `companyId`).
          await tx.articleVersion.deleteMany({
            where: { id: draft.id, companyId },
          });
          discardedDraftVersion = draft.version;
        }

        await tx.article.updateMany({
          where: { id, companyId },
          data: { archivedAt: new Date(), updatedBy: actor.id },
        });
        const updated = await tx.article.findFirstOrThrow({
          where: { id, companyId },
        });
        return { updated, discardedDraftVersion, removedUploadIds };
      });

    // Upload tombstoning + audit live outside the tx — same shape as
    // `update()`. A failure here at worst leaves uploads to the reaper.
    if (removedUploadIds.length > 0) {
      await this.uploads.softDeleteManyForArticle(companyId, removedUploadIds);
    }

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.article.archive,
      entityType: 'Article',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { archivedAt: null },
      after: {
        archivedAt: updated.archivedAt,
        ...(discardedDraftVersion !== null
          ? { discardedDraftVersion }
          : {}),
      },
    });
    const out = this.serialize(updated, actor.role);
    out.hasDraft = false;
    await this.hydrateActors([out]);
    return out;
  }

  async restore(
    actor: AuthedUser,
    companyId: string,
    id: string,
    meta: AuditMeta,
  ): Promise<SerializedArticle> {
    const existing = await this.prisma.article.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundException();
    if (!existing.archivedAt) throw new BadRequestException('Not archived');

    await this.assertSlugFree(companyId, existing.slug, id);
    await this.prisma.article.updateMany({
      where: { id, companyId },
      data: { archivedAt: null, updatedBy: actor.id },
    });
    const updated = await this.prisma.article.findFirstOrThrow({
      where: { id, companyId },
    });
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.article.restore,
      entityType: 'Article',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { archivedAt: existing.archivedAt },
      after: { archivedAt: null },
    });
    const out = this.serialize(updated, actor.role);
    // Archive always discards the draft, so a restored article cannot
    // have one. Avoid the EXISTS query.
    out.hasDraft = false;
    await this.hydrateActors([out]);
    return out;
  }

  /**
   * Hard-deletes an archived article and its dependent rows. Mirrors
   * `AssetsService.purge` (see [apps/api/src/assets/assets.service.ts]):
   *
   * Guarded:
   *   - The article must already be archived. The archive -> purge gate
   *     forces the operator to look at the row once more and lets the UI
   *     surface a Restore escape hatch up until the purge confirmation.
   *   - Caller must hold `article.purge` (FULL access).
   *
   * Cascade:
   *   - `StarredArticle` drops with the row (FK ON DELETE CASCADE).
   *   - `search_index` row is removed by the `articles_search_index_delete`
   *     trigger (see migration 0009_phase6_search_index).
   *   - `Relation` is polymorphic (no FK) -> cleaned manually inside the tx.
   *   - `Upload` rows embedded in the live body **or in any
   *     `ArticleVersion` row** for this article are soft-deleted so the
   *     photos gallery / attachments panel match the now-gone article.
   *     Live-body-only would miss images that were deleted from a later
   *     version: `update()` deliberately preserves those uploads while
   *     the article is alive (so Restore stays lossless), and they only
   *     become orphans at purge time.
   */
  async purge(
    actor: AuthedUser,
    companyId: string,
    id: string,
    meta: AuditMeta,
  ): Promise<{ id: string }> {
    const existing = await this.prisma.article.findFirst({
      where: { id, companyId },
    });
    if (!existing) throw new NotFoundException();
    if (!existing.archivedAt) {
      throw new BadRequestException(
        'Archive the article before permanently deleting it.',
      );
    }

    // Union of upload ids embedded in the live body + every history
    // row (drafts included — archive normally drops them, but a
    // pathological row would still need to be cleaned). Versions
    // cascade-delete with the article, so this is our only chance to
    // tombstone the upload rows they reference.
    const embeddedUploadIdSet = new Set<string>(
      extractEmbeddedUploadIds(existing.content ?? existing.markdownSource),
    );
    const versionBodies = await this.prisma.articleVersion.findMany({
      where: { articleId: id, companyId },
      select: { content: true, markdownSource: true },
    });
    for (const v of versionBodies) {
      for (const uid of extractEmbeddedUploadIds(
        v.content ?? v.markdownSource,
      )) {
        embeddedUploadIdSet.add(uid);
      }
    }
    const embeddedUploadIds = Array.from(embeddedUploadIdSet);

    const { versionCount, softDeletedUploads } = await this.prisma.$transaction(
      async (tx) => {
        // Count history rows *before* the article delete so the cascade
        // doesn't take them away first. Cheap (single COUNT with the
        // tenant filter) and only useful for the audit forensics trail
        // since the rows themselves are irrecoverable.
        const versionCount = await tx.articleVersion.count({
          where: { articleId: id, companyId },
        });

        await this.relations.cleanupForArticle({ tx, companyId, articleId: id });
        let softDeletedUploads = 0;
        if (embeddedUploadIds.length > 0) {
          const result = await tx.upload.updateMany({
            where: {
              id: { in: embeddedUploadIds },
              companyId,
              attachedToType: 'article',
              deletedAt: null,
            },
            data: { deletedAt: new Date() },
          });
          softDeletedUploads = result.count;
        }
        // `ArticleVersion.article` has ON DELETE CASCADE, so this
        // deleteMany also drops every history row for the article. No
        // orphans, no extra query.
        const result = await tx.article.deleteMany({ where: { id, companyId } });
        if (result.count === 0) {
          // Defence in depth: another request already purged the row.
          throw new NotFoundException();
        }
        return { versionCount, softDeletedUploads };
      },
    );

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.article.purge,
      entityType: 'Article',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: {
        ...this.auditFields(existing),
        archivedAt: existing.archivedAt,
        versionCount,
        ...(softDeletedUploads > 0 ? { softDeletedUploads } : {}),
      },
      after: null,
    });

    return { id };
  }

  // ------------------------------------------------------------------
  // Versioning
  // ------------------------------------------------------------------

  /**
   * Drop the in-progress autosave draft (if any) and revert the
   * article row to the most recent published version. Idempotent — if
   * there is no draft, returns the current article unchanged. The
   * "draft branch" never escapes history: the draft row is hard-
   * deleted, freeing its version number for reuse by the next save.
   */
  async discardDraft(
    actor: AuthedUser,
    companyId: string,
    id: string,
    meta: AuditMeta,
  ): Promise<SerializedArticle> {
    const existing = await this.prisma.article.findFirst({
      where: { id, companyId },
    });
    if (!existing) throw new NotFoundException();
    if (existing.archivedAt) {
      throw new BadRequestException(
        'Restore the article before discarding a draft.',
      );
    }

    const { updated, discardedVersion, removedUploadIds } =
      await this.prisma.$transaction(async (tx) => {
        const draft = await tx.articleVersion.findFirst({
          where: { articleId: id, companyId, isDraft: true },
        });
        if (!draft) {
          // No draft to discard. Return the article as-is so the
          // client's optimistic refresh sees a consistent state.
          const noOp = await tx.article.findFirstOrThrow({
            where: { id, companyId },
          });
          return {
            updated: noOp,
            discardedVersion: null as number | null,
            removedUploadIds: [] as string[],
          };
        }

        const lastPublished = await tx.articleVersion.findFirst({
          where: { articleId: id, companyId, isDraft: false },
          orderBy: { version: 'desc' },
        });
        if (!lastPublished) {
          // Should be impossible: every article has v=1 backfilled by
          // migration 0046 and `create()` writes v=1 in the same tx
          // as the article row. If we see this in production it means
          // the schema invariant broke; refuse to drop the draft
          // rather than orphan the article body.
          throw new BadRequestException(
            'Cannot discard draft: no published version exists.',
          );
        }

        await tx.article.updateMany({
          where: { id, companyId },
          data: this.articleRowFromVersion(lastPublished, actor.id),
        });
        const removed = diffRemovedUploadIds(
          draft.content ?? draft.markdownSource,
          lastPublished.content ?? lastPublished.markdownSource,
        );
        await tx.articleVersion.deleteMany({
          where: { id: draft.id, companyId },
        });
        const updated = await tx.article.findFirstOrThrow({
          where: { id, companyId },
        });
        return {
          updated,
          discardedVersion: draft.version,
          removedUploadIds: removed,
        };
      });

    if (discardedVersion === null) {
      const out = this.serialize(updated, actor.role);
      out.hasDraft = false;
      await this.hydrateActors([out]);
      return out;
    }

    if (removedUploadIds.length > 0) {
      await this.uploads.softDeleteManyForArticle(companyId, removedUploadIds);
    }

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.article.draftDiscard,
      entityType: 'Article',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { discardedVersion },
    });

    const out = this.serialize(updated, actor.role);
    out.hasDraft = false;
    await this.hydrateActors([out]);
    return out;
  }

  /**
   * List the published version history for an article (newest first).
   * Excludes the in-progress draft — UIs that need it ask
   * `getById`/`getBySlug` for `hasDraft`. Allowed on archived
   * articles so compliance reviewers can still read history after
   * archival.
   */
  async listVersions(
    actor: AuthedUser,
    companyId: string,
    id: string,
  ): Promise<ArticleVersionSummary[]> {
    const article = await this.prisma.article.findFirst({
      where: { id, companyId },
      select: { id: true, visibleToClients: true },
    });
    if (!article) throw new NotFoundException();
    if (actor.role === 'CLIENT_USER' && !article.visibleToClients) {
      throw new NotFoundException();
    }

    // A client may reach this point for a currently-visible article whose
    // history still contains versions that were internal/private when
    // written. Each version row snapshots its own visibility at publish
    // time (see `versionRowBodyFromArticle`), so filter on the version's
    // own flag — not the article's — to keep historical hidden content
    // out of the client response. This is a WHERE clause, not a
    // post-filter (WS-002).
    const rows = await this.prisma.articleVersion.findMany({
      where: {
        articleId: id,
        companyId,
        isDraft: false,
        ...(actor.role === 'CLIENT_USER' ? { visibleToClients: true } : {}),
      },
      orderBy: { version: 'desc' },
    });
    if (rows.length === 0) return [];

    const userIds = Array.from(new Set(rows.map((r) => r.changedBy)));
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true },
    });
    const nameById = new Map(
      users.map((u) => [u.id, u.name || u.email] as const),
    );
    return rows.map((r) => this.serializeVersionSummary(r, nameById));
  }

  /**
   * Full snapshot of a single version. Used by the history UI when an
   * operator clicks "View" or "Restore". Published-only — the
   * coalescing draft is exposed via the article detail's `hasDraft`
   * flag and not addressable by version number from the API.
   */
  async getVersion(
    actor: AuthedUser,
    companyId: string,
    id: string,
    version: number,
  ): Promise<ArticleVersionDetail> {
    const article = await this.prisma.article.findFirst({
      where: { id, companyId },
      select: { id: true, visibleToClients: true },
    });
    if (!article) throw new NotFoundException();
    if (actor.role === 'CLIENT_USER' && !article.visibleToClients) {
      throw new NotFoundException();
    }

    // Authorize against the requested version's own visibility snapshot,
    // not the article's current flag: a now-visible article can have
    // historical versions that were never meant to be client-visible.
    // Folding the flag into the WHERE makes a hidden version
    // indistinguishable from a missing one (404), avoiding existence
    // disclosure (WS-002).
    const row = await this.prisma.articleVersion.findFirst({
      where: {
        articleId: id,
        companyId,
        version,
        isDraft: false,
        ...(actor.role === 'CLIENT_USER' ? { visibleToClients: true } : {}),
      },
    });
    if (!row) throw new NotFoundException();

    const user = await this.prisma.user.findUnique({
      where: { id: row.changedBy },
      select: { id: true, name: true, email: true },
    });
    const nameById = new Map<string, string>();
    if (user) nameById.set(user.id, user.name || user.email);
    return this.serializeVersionDetail(row, nameById);
  }

  /**
   * Re-apply version `version`'s body as a new published version. Any
   * in-progress draft is discarded first (same semantics as a fresh
   * Save would impose). The resulting history reads as:
   *   v1, v2, …, vN (target), …, vM (current), vM+1 (this restore)
   * — i.e. forward-only, no rewriting of the timeline.
   */
  async restoreVersion(
    actor: AuthedUser,
    companyId: string,
    id: string,
    version: number,
    meta: AuditMeta,
  ): Promise<SerializedArticle> {
    const existing = await this.prisma.article.findFirst({
      where: { id, companyId },
    });
    if (!existing) throw new NotFoundException();
    if (existing.archivedAt) {
      throw new BadRequestException(
        'Restore the article before restoring a version.',
      );
    }

    const target = await this.prisma.articleVersion.findFirst({
      where: { articleId: id, companyId, version, isDraft: false },
    });
    if (!target) throw new NotFoundException('Version not found.');

    // Drop any in-flight autosave draft first so the new published
    // row reflects the operator's deliberate "go back to vN" intent
    // and not a half-merged draft body. `discardDraft` is a no-op
    // when no draft exists.
    await this.discardDraft(actor, companyId, id, meta);

    // Build an UpdateArticleInput from the version row and let the
    // standard update path do the rest: validation, audit, upload
    // diff, and the published version row write. Slug must skip the
    // uniqueness check against itself — that's already handled by
    // `assertSlugFree(..., excludeId: id)` inside `update`.
    const input: UpdateArticleInput =
      target.editorMode === 'markdown'
        ? {
            title: target.title,
            slug: target.slug,
            folderId: target.folderId,
            editorMode: 'markdown',
            markdownSource: target.markdownSource ?? '',
            excerpt: target.excerpt,
            visibleToClients: target.visibleToClients,
          }
        : {
            title: target.title,
            slug: target.slug,
            folderId: target.folderId,
            editorMode: 'tiptap',
            content: (target.content as Prisma.JsonValue) as never,
            excerpt: target.excerpt,
            visibleToClients: target.visibleToClients,
          };

    const updated = await this.update(actor, companyId, id, input, meta);

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.article.versionRestored,
      entityType: 'Article',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { restoredFromVersion: version },
    });

    return updated;
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private async assertFolderInCompany(companyId: string, folderId: string): Promise<void> {
    const folder = await this.prisma.folder.findFirst({
      where: { id: folderId, companyId, archivedAt: null },
      select: { id: true },
    });
    if (!folder) {
      throw new BadRequestException({
        error: 'FolderNotFound',
        folderId,
        message: 'Target folder does not exist in this company (or is archived).',
      });
    }
  }

  private async assertSlugFree(
    companyId: string,
    slug: string,
    excludeId: string | null,
  ): Promise<void> {
    const clash = await this.prisma.article.findFirst({
      where: {
        companyId,
        slug,
        archivedAt: null,
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException({
        error: 'SlugTaken',
        slug,
        message: `Another active article already uses slug "${slug}".`,
      });
    }
  }

  /**
   * Build the body-shaped subset of an article row (`editorMode`,
   * `content`, `markdownSource`, `contentPlaintext`, `excerpt`) from a
   * write input. Centralised here so `create` and `update` can share the
   * exact same projection — including the "if the caller didn't supply
   * an excerpt, derive one from the body" rule.
   */
  private projectArticleBody(
    input:
      | { editorMode: 'tiptap'; content: unknown }
      | { editorMode: 'markdown'; markdownSource: string },
    excerptOverride?: string,
  ): {
    editorMode: 'tiptap' | 'markdown';
    content: Prisma.InputJsonValue | typeof Prisma.DbNull;
    markdownSource: string | null;
    contentPlaintext: string;
    excerpt: string;
  } {
    if (input.editorMode === 'markdown') {
      const md = input.markdownSource;
      return {
        editorMode: 'markdown',
        content: Prisma.DbNull,
        markdownSource: md,
        contentPlaintext: markdownToPlaintext(md),
        excerpt: excerptOverride ?? markdownExcerpt(md),
      };
    }

    if (!isValidTiptapDoc(input.content)) {
      throw new BadRequestException({
        error: 'InvalidArticleContent',
        message: 'content must be a Tiptap doc node.',
      });
    }
    return {
      editorMode: 'tiptap',
      content: input.content as unknown as Prisma.InputJsonValue,
      markdownSource: null,
      contentPlaintext: tiptapToPlaintext(input.content),
      excerpt: excerptOverride ?? tiptapExcerpt(input.content),
    };
  }

  /**
   * Compute the card-preview excerpt for an article row at read time.
   * Mirrors `projectArticleBody` but is read-only — we don't write
   * back to the DB. Falls back to the stored `excerpt` if the body
   * is missing, so the existing semantics for malformed rows is
   * preserved.
   */
  private deriveExcerpt(row: Article): string | null {
    if (row.editorMode === 'markdown') {
      if (typeof row.markdownSource === 'string' && row.markdownSource.length > 0) {
        return markdownExcerpt(row.markdownSource);
      }
      return row.excerpt;
    }
    if (row.content != null) {
      return tiptapExcerpt(row.content);
    }
    return row.excerpt;
  }

  /** Subset of fields recorded in the audit log for create/update. */
  private auditFields(row: Article): {
    title: string;
    slug: string;
    folderId: string | null;
    visibleToClients: boolean;
    editorMode: string;
  } {
    return {
      title: row.title,
      slug: row.slug,
      folderId: row.folderId,
      visibleToClients: row.visibleToClients,
      editorMode: row.editorMode,
    };
  }

  /**
   * Diff two article rows, returning the names of the
   * `VERSIONED_FIELDS` that differ. JSON body equality is compared by
   * serialized form because Prisma may give us `JsonValue` objects
   * with reference inequality even when shape-equal — and a deep
   * structural compare is exactly what we'd otherwise write here.
   */
  private computeChangedFields(prev: Article, next: Article): VersionedField[] {
    const out: VersionedField[] = [];
    for (const field of VERSIONED_FIELDS) {
      if (field === 'content') {
        const a = prev.content == null ? null : JSON.stringify(prev.content);
        const b = next.content == null ? null : JSON.stringify(next.content);
        if (a !== b) out.push(field);
        continue;
      }
      if (prev[field] !== next[field]) out.push(field);
    }
    return out;
  }

  /** Stable union of two field-name lists (order-insensitive). */
  private unionFields(a: readonly string[], b: readonly string[]): string[] {
    const seen = new Set<string>();
    for (const v of a) seen.add(v);
    for (const v of b) seen.add(v);
    return Array.from(seen);
  }

  /**
   * `EXISTS` query for "does an in-progress draft exist for this
   * article?". Cheap — uses the partial unique index. The detail
   * endpoints surface this as `hasDraft` so the editor can prompt the
   * user with the right Cancel behavior.
   */
  private async resolveHasDraft(
    companyId: string,
    articleId: string,
  ): Promise<boolean> {
    const count = await this.prisma.articleVersion.count({
      where: { articleId, companyId, isDraft: true },
    });
    return count > 0;
  }

  /**
   * Given a list of upload ids that have been removed from an article's
   * live body, return the subset that is still embedded in at least one
   * non-draft `ArticleVersion` row for the same article. Callers use
   * the difference (`removed \ stillReferenced`) to decide which
   * uploads can be soft-deleted; uploads kept in history must survive
   * so the history-panel preview and a later Restore still render the
   * image.
   *
   * The scan runs in JS (rather than a Postgres regex over `content::text`)
   * because it's bounded by the number of versions for a single
   * article — well under 1000 in any realistic case — and reusing
   * `extractEmbeddedUploadIds` here keeps the live and history scans
   * in lock-step on URL shape.
   */
  private async findUploadsReferencedInHistory(
    companyId: string,
    articleId: string,
    uploadIds: string[],
  ): Promise<Set<string>> {
    const referenced = new Set<string>();
    if (uploadIds.length === 0) return referenced;
    const versions = await this.prisma.articleVersion.findMany({
      where: { articleId, companyId, isDraft: false },
      select: { content: true, markdownSource: true },
    });
    const wanted = new Set(uploadIds);
    for (const v of versions) {
      const ids = extractEmbeddedUploadIds(v.content ?? v.markdownSource);
      for (const id of ids) {
        if (wanted.has(id)) referenced.add(id);
      }
    }
    return referenced;
  }

  /**
   * Build the body subset of an `ArticleVersion` row from a live
   * Article. Reused by `create()` (v1), `update()` (autosave draft +
   * promotion), and `archive()` (when reverting before discarding a
   * draft). Avoids `archivedAt`/audit columns — versions are pure
   * content snapshots, lifecycle state lives on the parent row.
   *
   * Secondary plaintext store — each revision retains the full article
   * body. See docs/security/data-retention.md.
   */
  private versionRowBodyFromArticle(row: Article): {
    title: string;
    slug: string;
    folderId: string | null;
    visibleToClients: boolean;
    editorMode: string;
    content: Prisma.InputJsonValue | typeof Prisma.DbNull;
    markdownSource: string | null;
    contentPlaintext: string;
    excerpt: string | null;
  } {
    return {
      title: row.title,
      slug: row.slug,
      folderId: row.folderId,
      visibleToClients: row.visibleToClients,
      editorMode: row.editorMode,
      content:
        row.content == null
          ? Prisma.DbNull
          : (row.content as Prisma.InputJsonValue),
      markdownSource: row.markdownSource,
      contentPlaintext: row.contentPlaintext,
      excerpt: row.excerpt,
    };
  }

  /**
   * Inverse of `versionRowBodyFromArticle`: project a version row
   * onto the columns of an `Article.updateMany` payload. Used by
   * `discardDraft` and `archive` when reverting the live row to the
   * last published snapshot. `updatedBy` carries the actor performing
   * the revert (not the original version's author) so the audit
   * trail reflects who undid the change.
   */
  private articleRowFromVersion(
    v: ArticleVersion,
    updatedBy: string,
  ): Prisma.ArticleUncheckedUpdateManyInput {
    return {
      title: v.title,
      slug: v.slug,
      folderId: v.folderId,
      visibleToClients: v.visibleToClients,
      editorMode: v.editorMode,
      content:
        v.content == null
          ? Prisma.DbNull
          : (v.content as Prisma.InputJsonValue),
      markdownSource: v.markdownSource,
      contentPlaintext: v.contentPlaintext,
      excerpt: v.excerpt,
      updatedBy,
    };
  }

  /** Public-facing version summary (metadata only; no body). */
  private serializeVersionSummary(
    v: ArticleVersion,
    nameById: Map<string, string>,
  ): ArticleVersionSummary {
    return {
      version: v.version,
      isDraft: v.isDraft,
      title: v.title,
      slug: v.slug,
      editorMode: v.editorMode as 'tiptap' | 'markdown',
      changedFields: v.changedFields,
      changedBy: v.changedBy,
      changedByName: nameById.get(v.changedBy) ?? null,
      changeReason: v.changeReason,
      createdAt: v.createdAt.toISOString(),
      updatedAt: v.updatedAt.toISOString(),
    };
  }

  /** Public-facing version detail (includes the full body). */
  private serializeVersionDetail(
    v: ArticleVersion,
    nameById: Map<string, string>,
  ): ArticleVersionDetail {
    return {
      ...this.serializeVersionSummary(v, nameById),
      folderId: v.folderId,
      visibleToClients: v.visibleToClients,
      content: v.content as Prisma.JsonValue | null,
      markdownSource: v.markdownSource,
      contentPlaintext: v.contentPlaintext,
      excerpt: v.excerpt,
    };
  }

  private slugifyTitle(title: string): string {
    return (
      title
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .slice(0, 80) || 'untitled'
    );
  }

  private serialize(row: Article, role: UserRole): SerializedArticle {
    // Client users never see the raw authoring doc for hidden articles —
    // the list/get filters catch that before we get here. We still scrub
    // the `updatedBy` field for symmetry with Asset serialization.
    const _ = role;
    return {
      id: row.id,
      companyId: row.companyId,
      folderId: row.folderId,
      title: row.title,
      slug: row.slug,
      editorMode: row.editorMode as 'tiptap' | 'markdown',
      content: row.content,
      markdownSource: row.markdownSource,
      contentPlaintext: row.contentPlaintext,
      // Re-derive on read so legacy rows whose stored `excerpt` was
      // generated from image alt text (e.g. `"image.jpg"`) render
      // cleanly without a destructive backfill. New writes go through
      // `projectArticleBody`, which already uses the image-aware
      // excerpt helpers.
      excerpt: this.deriveExcerpt(row),
      visibleToClients: row.visibleToClients,
      revision: row.revision,
      archivedAt: row.archivedAt,
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
      createdByUser: null,
      updatedByUser: null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      isStarred: false, // populated separately for detail
      // List responses leave `hasDraft` at its default `false` so we
      // can keep listing cheap. Detail / mutation responses overwrite
      // this with the real value via `resolveHasDraft` or knowledge
      // local to the tx.
      hasDraft: false,
    };
  }

  /**
   * Resolve `createdBy` / `updatedBy` user ids into `{ id, name }` stubs
   * so the UI can render "updated by Jane" without the caller having to
   * hold `membership.manage`. This is a post-pass over already-serialized
   * rows so the sync `serialize()` path stays simple; one Prisma query
   * covers any number of articles in a list.
   */
  private async hydrateActors(articles: SerializedArticle[]): Promise<void> {
    if (articles.length === 0) return;
    const ids = new Set<string>();
    for (const a of articles) {
      if (a.createdBy) ids.add(a.createdBy);
      if (a.updatedBy) ids.add(a.updatedBy);
    }
    if (ids.size === 0) return;
    const users = await this.prisma.user.findMany({
      where: { id: { in: Array.from(ids) } },
      select: { id: true, name: true, email: true },
    });
    const byId = new Map(
      users.map((u) => [u.id, { id: u.id, name: u.name || u.email }] as const),
    );
    for (const a of articles) {
      if (a.createdBy) a.createdByUser = byId.get(a.createdBy) ?? null;
      if (a.updatedBy) a.updatedByUser = byId.get(a.updatedBy) ?? null;
    }
  }
}

function articleBlocked(
  companyId: string,
  kind: 'missing_dependency' | 'validation' | 'ambiguous' | 'synchronization_error',
  message: string,
  reasonCode: string,
  targetId = '',
  candidateCount?: number,
): IntegrationArticleWriteResult {
  return {
    targetId,
    companyId,
    change: 'blocked',
    gap: {
      kind,
      message,
      details: {
        reasonCode,
        ...(candidateCount !== undefined ? { candidateCount } : {}),
      },
    },
  };
}
