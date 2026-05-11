import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Article } from '@prisma/client';
import {
  markdownExcerpt,
  markdownToPlaintext,
  tiptapExcerpt,
  tiptapToPlaintext,
  isValidTiptapDoc,
  type CreateArticleInput,
  type MoveArticleInput,
  type UpdateArticleInput,
  type UserRole,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { StarsService } from '../stars/stars.service.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { diffRemovedUploadIds } from './article-uploads.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

export interface AuditMeta {
  ip: string;
  userAgent: string;
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
}

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
   * check. Returns `null` when the article does not exist.
   */
  async findCompanyIdForArticle(id: string): Promise<string | null> {
    const row = await this.prisma.article.findUnique({
      where: { id },
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

    const created = await this.prisma.article.create({ data });

    await this.audit.log({
      actorId: actor.id,
      action: 'article.create',
      entityType: 'Article',
      entityId: created.id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: this.auditFields(created),
    });
    const out = this.serialize(created, actor.role);
    await this.hydrateActors([out]);
    return out;
  }

  async update(
    actor: AuthedUser,
    companyId: string,
    id: string,
    input: UpdateArticleInput,
    meta: AuditMeta,
  ): Promise<SerializedArticle> {
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

    // `updateMany` + refetch so the tenant-scope middleware sees a
    // `companyId` filter in the `where` clause. Plain `update` only
    // accepts unique keys in `where` (i.e. `id`), which would miss the
    // scope guard. See assets.service for the same idiom.
    await this.prisma.article.updateMany({ where: { id, companyId }, data });
    const updated = await this.prisma.article.findFirstOrThrow({
      where: { id, companyId },
    });

    // Tombstone any upload the operator just unembedded so it leaves
    // the photos gallery / attachment panels alongside the image they
    // removed. We diff both Tiptap and Markdown bodies — the URL
    // shape is identical, so a single regex sweep covers either mode.
    let removedUploads = 0;
    if (input.content !== undefined || input.markdownSource !== undefined) {
      const removed = diffRemovedUploadIds(
        existing.content ?? existing.markdownSource,
        updated.content ?? updated.markdownSource,
      );
      if (removed.length > 0) {
        const result = await this.uploads.softDeleteManyForArticle(
          companyId,
          removed,
        );
        removedUploads = result.softDeleted;
      }
    }

    await this.audit.log({
      actorId: actor.id,
      action: 'article.update',
      entityType: 'Article',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: this.auditFields(existing),
      after:
        removedUploads > 0
          ? { ...this.auditFields(updated), removedUploads }
          : this.auditFields(updated),
    });
    const out = this.serialize(updated, actor.role);
    await this.hydrateActors([out]);
    return out;
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
      action: 'article.move',
      entityType: 'Article',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { folderId: existing.folderId },
      after: { folderId: updated.folderId },
    });
    const out = this.serialize(updated, actor.role);
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

    await this.prisma.article.updateMany({
      where: { id, companyId },
      data: { archivedAt: new Date(), updatedBy: actor.id },
    });
    const updated = await this.prisma.article.findFirstOrThrow({
      where: { id, companyId },
    });
    await this.audit.log({
      actorId: actor.id,
      action: 'article.archive',
      entityType: 'Article',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { archivedAt: null },
      after: { archivedAt: updated.archivedAt },
    });
    const out = this.serialize(updated, actor.role);
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
      action: 'article.restore',
      entityType: 'Article',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { archivedAt: existing.archivedAt },
      after: { archivedAt: null },
    });
    const out = this.serialize(updated, actor.role);
    await this.hydrateActors([out]);
    return out;
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
      excerpt: row.excerpt,
      visibleToClients: row.visibleToClients,
      archivedAt: row.archivedAt,
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
      createdByUser: null,
      updatedByUser: null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      isStarred: false, // populated separately for detail
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
