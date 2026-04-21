import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Folder } from '@prisma/client';
import type { CreateFolderInput, UpdateFolderInput } from '@weavestream/shared';
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

  async tree(companyId: string): Promise<SerializedFolderNode[]> {
    const [folders, counts] = await Promise.all([
      this.prisma.folder.findMany({
        where: { companyId, archivedAt: null },
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.article.groupBy({
        by: ['folderId'],
        where: { companyId, archivedAt: null, folderId: { not: null } },
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

  async get(companyId: string, id: string): Promise<SerializedFolder> {
    const f = await this.prisma.folder.findFirst({ where: { id, companyId } });
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

    await this.prisma.folder.updateMany({
      where: { id, companyId },
      data: { archivedAt: new Date() },
    });
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
      before: { archivedAt: null },
      after: { archivedAt: updated.archivedAt },
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
