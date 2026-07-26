import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Folder } from '@prisma/client';
import type {
  ArchiveFolderInput,
  CreateFolderInput,
  UpdateFolderInput,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

export interface AuditMeta {
  ip: string;
  userAgent: string;
}

export interface SerializedFolder {
  id: string;
  companyId: string;
  parentId: string | null;
  name: string;
  slug: string;
  icon: string | null;
  position: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SerializedFolderNode extends SerializedFolder {
  articleCount: number;
  children: SerializedFolderNode[];
}

@Injectable()
export class FoldersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  // ------------------------------------------------------------------
  // Read
  // ------------------------------------------------------------------

  /**
   * Folder ids a CLIENT_USER may know exist: folders holding at least one
   * non-archived `visibleToClients` article, plus their ancestor chain
   * (so a visible leaf stays reachable in the tree). Everything else —
   * internal-only branches included — must stay invisible: folder *names*
   * and counts are themselves information (CLAUDE.md §1), and before this
   * helper the tree endpoint handed a client user the full internal
   * taxonomy.
   *
   * One recursive CTE so the visibility predicate lives in SQL, not in
   * application pruning. `company_id` and `archived_at IS NULL` are bound
   * in BOTH branches, and the two arms combine with UNION (not UNION ALL):
   * the row dedup is also what terminates a malformed `parentId` cycle,
   * which the database does not prohibit. DISTINCT in the anchor guards
   * the multiple-visible-articles-per-folder case against a future
   * rewrite of EXISTS into a JOIN.
   */
  private async clientVisibleFolderIds(companyId: string): Promise<Set<string>> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH RECURSIVE visible AS (
        SELECT DISTINCT f.id, f.parent_id
        FROM folders f
        WHERE f.company_id = ${companyId}::uuid
          AND f.archived_at IS NULL
          AND EXISTS (
            SELECT 1 FROM articles a
            WHERE a.company_id = ${companyId}::uuid
              AND a.folder_id = f.id
              AND a.archived_at IS NULL
              AND a.visible_to_clients = TRUE
          )
        UNION
        SELECT p.id, p.parent_id
        FROM folders p
        JOIN visible v ON v.parent_id = p.id
        WHERE p.company_id = ${companyId}::uuid
          AND p.archived_at IS NULL
      )
      SELECT id FROM visible
    `);
    return new Set(rows.map((r) => r.id));
  }

  async tree(actor: AuthedUser, companyId: string): Promise<SerializedFolderNode[]> {
    // Client users get the pruned tree and visible-only counts; every
    // other role sees the exact pre-existing behaviour.
    const clientVisible =
      actor.role === 'CLIENT_USER'
        ? await this.clientVisibleFolderIds(companyId)
        : null;

    const folderWhere: Prisma.FolderWhereInput = { companyId, archivedAt: null };
    if (clientVisible) folderWhere.id = { in: [...clientVisible] };
    const countWhere: Prisma.ArticleWhereInput = {
      companyId,
      archivedAt: null,
      folderId: { not: null },
    };
    if (clientVisible) countWhere.visibleToClients = true;

    const [folders, counts] = await Promise.all([
      this.prisma.folder.findMany({
        where: folderWhere,
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.article.groupBy({
        by: ['folderId'],
        where: countWhere,
        _count: { _all: true },
      }),
    ]);
    const countByFolder = new Map<string, number>();
    for (const c of counts) {
      if (c.folderId) countByFolder.set(c.folderId, c._count._all);
    }
    const byId = new Map<string, SerializedFolderNode>();
    for (const f of folders) {
      byId.set(f.id, {
        ...this.serialize(f),
        articleCount: countByFolder.get(f.id) ?? 0,
        children: [],
      });
    }
    const roots: SerializedFolderNode[] = [];
    for (const node of byId.values()) {
      if (node.parentId && byId.has(node.parentId)) {
        byId.get(node.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  async get(actor: AuthedUser, companyId: string, id: string): Promise<SerializedFolder> {
    // Same client-visibility rule as tree(): a folder with no visible
    // article anywhere in its subtree does not exist for a CLIENT_USER.
    // The allowlist is computed BEFORE any row is read and folded into
    // the read's own WHERE (authorization at the query layer, CLAUDE.md
    // §1) — so for a client user, a hidden folder and a nonexistent one
    // take the identical path: CTE, then a findFirst that returns null.
    // Checking after the read would both fetch an unauthorized row and
    // leak existence through timing (the CTE only running for rows that
    // exist). 404, not 403, keeps the endpoint oracle-free like the
    // articles reads; knowing the UUID is never authorization.
    const clientVisible =
      actor.role === 'CLIENT_USER'
        ? await this.clientVisibleFolderIds(companyId)
        : null;
    const f = await this.prisma.folder.findFirst({
      where: {
        companyId,
        id: clientVisible ? { equals: id, in: [...clientVisible] } : id,
      },
    });
    if (!f) throw new NotFoundException();
    return this.serialize(f);
  }

  // ------------------------------------------------------------------
  // Write
  // ------------------------------------------------------------------

  async create(
    actor: AuthedUser,
    companyId: string,
    input: CreateFolderInput,
    meta: AuditMeta,
  ): Promise<SerializedFolder> {
    if (input.parentId) {
      const parent = await this.prisma.folder.findFirst({
        where: { id: input.parentId, companyId },
      });
      if (!parent) {
        throw new BadRequestException({
          error: 'ParentNotFound',
          parentId: input.parentId,
        });
      }
    }

    const slug = input.slug ?? this.slugify(input.name);
    await this.assertSlugFree(companyId, input.parentId ?? null, slug, null);

    const created = await this.prisma.folder.create({
      data: {
        companyId,
        parentId: input.parentId ?? null,
        name: input.name,
        slug,
        icon: input.icon ?? null,
        position: input.position ?? 0,
        createdBy: actor.id,
      },
    });

    await this.audit.log({
      actorId: actor.id,
      action: 'folder.create',
      entityType: 'Folder',
      entityId: created.id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { name: created.name, slug: created.slug, parentId: created.parentId },
    });
    return this.serialize(created);
  }

  async update(
    actor: AuthedUser,
    companyId: string,
    id: string,
    input: UpdateFolderInput,
    meta: AuditMeta,
  ): Promise<SerializedFolder> {
    const existing = await this.prisma.folder.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundException();
    if (existing.archivedAt) {
      throw new BadRequestException('Cannot edit an archived folder — restore it first.');
    }

    const nextParentId =
      input.parentId === undefined ? existing.parentId : input.parentId;
    if (nextParentId && nextParentId !== existing.parentId) {
      const parent = await this.prisma.folder.findFirst({
        where: { id: nextParentId, companyId },
      });
      if (!parent) {
        throw new BadRequestException({
          error: 'ParentNotFound',
          parentId: nextParentId,
        });
      }
      await this.assertNoCycle(companyId, id, nextParentId);
    }

    const nextSlug = input.slug ?? existing.slug;
    if (nextSlug !== existing.slug || nextParentId !== existing.parentId) {
      await this.assertSlugFree(companyId, nextParentId, nextSlug, id);
    }

    await this.prisma.folder.updateMany({
      where: { id, companyId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
      },
    });
    const updated = await this.prisma.folder.findFirstOrThrow({
      where: { id, companyId },
    });

    await this.audit.log({
      actorId: actor.id,
      action: 'folder.update',
      entityType: 'Folder',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: {
        name: existing.name,
        slug: existing.slug,
        parentId: existing.parentId,
        position: existing.position,
      },
      after: {
        name: updated.name,
        slug: updated.slug,
        parentId: updated.parentId,
        position: updated.position,
      },
    });

    return this.serialize(updated);
  }

  async archive(
    actor: AuthedUser,
    companyId: string,
    id: string,
    input: ArchiveFolderInput,
    meta: AuditMeta,
  ): Promise<SerializedFolder> {
    const existing = await this.prisma.folder.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundException();
    if (existing.archivedAt) throw new BadRequestException('Already archived');

    const activeChildren = await this.prisma.folder.count({
      where: { parentId: id, companyId, archivedAt: null },
    });
    if (activeChildren > 0) {
      throw new ConflictException({
        error: 'FolderHasChildren',
        message: 'Archive or move child folders first.',
      });
    }

    const activeArticleCount = await this.prisma.article.count({
      where: { folderId: id, companyId, archivedAt: null },
    });
    if (activeArticleCount > 0 && !input.articles) {
      throw new BadRequestException({
        error: 'ArticlesCascadeRequired',
        message:
          'This folder contains articles. Choose "unassign" (move to Unfiled) or "archive".',
        articleCount: activeArticleCount,
      });
    }

    const now = new Date();
    const articleStrategy = input.articles ?? 'unassign';
    const articleCascade =
      articleStrategy === 'archive'
        ? this.prisma.article.updateMany({
            where: { folderId: id, companyId, archivedAt: null },
            data: { archivedAt: now },
          })
        : this.prisma.article.updateMany({
            where: { folderId: id, companyId },
            data: { folderId: null },
          });

    await this.prisma.$transaction([
      articleCascade,
      this.prisma.folder.updateMany({
        where: { id, companyId },
        data: { archivedAt: now },
      }),
    ]);
    const updated = await this.prisma.folder.findFirstOrThrow({
      where: { id, companyId },
    });

    await this.audit.log({
      actorId: actor.id,
      action: 'folder.archive',
      entityType: 'Folder',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { archivedAt: null, activeArticleCount },
      after: {
        archivedAt: updated.archivedAt,
        articlesCascade: articleStrategy,
      },
    });
    return this.serialize(updated);
  }

  async restore(
    actor: AuthedUser,
    companyId: string,
    id: string,
    meta: AuditMeta,
  ): Promise<SerializedFolder> {
    const existing = await this.prisma.folder.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundException();
    if (!existing.archivedAt) throw new BadRequestException('Not archived');

    await this.assertSlugFree(companyId, existing.parentId, existing.slug, id);
    await this.prisma.folder.updateMany({
      where: { id, companyId },
      data: { archivedAt: null },
    });
    const updated = await this.prisma.folder.findFirstOrThrow({
      where: { id, companyId },
    });

    await this.audit.log({
      actorId: actor.id,
      action: 'folder.restore',
      entityType: 'Folder',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { archivedAt: existing.archivedAt },
      after: { archivedAt: null },
    });
    return this.serialize(updated);
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private async assertSlugFree(
    companyId: string,
    parentId: string | null,
    slug: string,
    excludeId: string | null,
  ): Promise<void> {
    const clash = await this.prisma.folder.findFirst({
      where: {
        companyId,
        parentId,
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
        message: `Folder slug "${slug}" is already in use at this level.`,
      });
    }
  }

  private async assertNoCycle(
    companyId: string,
    folderId: string,
    proposedParentId: string,
  ): Promise<void> {
    if (folderId === proposedParentId) {
      throw new BadRequestException({
        error: 'CyclicParent',
        message: 'A folder cannot be its own parent.',
      });
    }
    let cursor: string | null = proposedParentId;
    const seen = new Set<string>();
    while (cursor) {
      if (seen.has(cursor)) return;
      seen.add(cursor);
      if (cursor === folderId) {
        throw new BadRequestException({
          error: 'CyclicParent',
          message: 'Proposed parent is a descendant of this folder.',
        });
      }
      const parent: { parentId: string | null } | null = await this.prisma.folder.findFirst({
        where: { id: cursor, companyId },
        select: { parentId: true },
      });
      cursor = parent?.parentId ?? null;
    }
  }

  private slugify(name: string): string {
    return (
      name
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .slice(0, 60) || 'folder'
    );
  }

  private serialize(row: Folder): SerializedFolder {
    return {
      id: row.id,
      companyId: row.companyId,
      parentId: row.parentId,
      name: row.name,
      slug: row.slug,
      icon: row.icon,
      position: row.position,
      archivedAt: row.archivedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
