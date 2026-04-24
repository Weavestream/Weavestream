import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { Article, Folder, Prisma } from '@prisma/client';
import { ArticlesService } from './articles.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * Unit tests for ArticlesService. Exercise the invariants a reviewer
 * should be able to trust without spinning up Postgres:
 *  - tenant-scope enforcement (company mismatch = NotFound)
 *  - slug uniqueness inside a company (per-slug ConflictException)
 *  - client-user visibility filter (hidden articles are invisible)
 *  - folder validation (folder must belong to the same company)
 *  - archive → restore round-trip
 *  - tiptap content must be a doc node
 */

type ArticleRow = Article;
type FolderRow = Folder;

function makeStubs(initial: {
  articles?: ArticleRow[];
  folders?: FolderRow[];
  starredArticleIds?: string[];
} = {}) {
  const articles: ArticleRow[] = [...(initial.articles ?? [])];
  const folders: FolderRow[] = [...(initial.folders ?? [])];
  const starredArticleIds: string[] = [...(initial.starredArticleIds ?? [])];

  function matchesWhere(row: ArticleRow, where: Prisma.ArticleWhereInput): boolean {
    if (where.id && where.id !== row.id) return false;
    if (where.companyId && where.companyId !== row.companyId) return false;
    if (where.slug && where.slug !== row.slug) return false;
    if (where.archivedAt === null && row.archivedAt !== null) return false;
    if (
      where.NOT &&
      typeof where.NOT === 'object' &&
      'id' in where.NOT &&
      (where.NOT as { id?: string }).id === row.id
    ) {
      return false;
    }
    return true;
  }

  const prisma = {
    article: {
      async findFirst(args: { where: Prisma.ArticleWhereInput }) {
        return articles.find((a) => matchesWhere(a, args.where)) ?? null;
      },
      async findFirstOrThrow(args: { where: Prisma.ArticleWhereInput }) {
        const hit = articles.find((a) => matchesWhere(a, args.where));
        if (!hit) throw new Error('not found');
        return hit;
      },
      async findMany(args: {
        where: Prisma.ArticleWhereInput;
        take?: number;
        cursor?: { id: string };
        skip?: number;
        orderBy?: unknown;
      }) {
        let results = articles.filter((a) => matchesWhere(a, args.where));
        if (args.cursor) {
          const idx = results.findIndex((r) => r.id === args.cursor!.id);
          if (idx >= 0) results = results.slice(idx + (args.skip ?? 0));
        }
        if (args.take) results = results.slice(0, args.take);
        return results;
      },
      async create(args: { data: Prisma.ArticleUncheckedCreateInput }): Promise<ArticleRow> {
        const d = args.data;
        const row: ArticleRow = {
          id: `art-${articles.length + 1}`,
          companyId: d.companyId,
          folderId: (d.folderId as string | null) ?? null,
          title: d.title,
          slug: d.slug,
          content: d.content as unknown as Prisma.JsonValue,
          contentPlaintext: d.contentPlaintext as string,
          excerpt: (d.excerpt as string | null) ?? null,
          visibleToClients: (d.visibleToClients as boolean) ?? true,
          createdAt: new Date(),
          updatedAt: new Date(),
          createdBy: (d.createdBy as string | null) ?? null,
          updatedBy: (d.updatedBy as string | null) ?? null,
          archivedAt: null,
        };
        articles.push(row);
        return row;
      },
      async update(args: {
        where: { id: string };
        data: Prisma.ArticleUpdateInput;
      }) {
        const idx = articles.findIndex((a) => a.id === args.where.id);
        if (idx < 0) throw new Error('not found');
        const current = articles[idx]!;
        const d = args.data as Record<string, unknown>;
        const next: ArticleRow = { ...current };
        if ('title' in d) next.title = d.title as string;
        if ('slug' in d) next.slug = d.slug as string;
        if ('folder' in d) {
          const f = d.folder as { connect?: { id: string }; disconnect?: true };
          if (f.connect) next.folderId = f.connect.id;
          if (f.disconnect) next.folderId = null;
        }
        if ('folderId' in d) next.folderId = d.folderId as string | null;
        if ('archivedAt' in d) next.archivedAt = d.archivedAt as Date | null;
        if ('content' in d) next.content = d.content as Prisma.JsonValue;
        if ('contentPlaintext' in d) next.contentPlaintext = d.contentPlaintext as string;
        if ('excerpt' in d) next.excerpt = (d.excerpt as string) ?? null;
        if ('visibleToClients' in d) next.visibleToClients = d.visibleToClients as boolean;
        if ('updatedBy' in d) next.updatedBy = d.updatedBy as string | null;
        next.updatedAt = new Date();
        articles[idx] = next;
        return next;
      },
      // The service uses `updateMany` for writes that must be scoped by
      // both `id` and `companyId` (so a stale id from one tenant can't
      // target another). Mirror that here with a two-predicate filter.
      async updateMany(args: {
        where: { id?: string; companyId?: string };
        data: Prisma.ArticleUncheckedUpdateManyInput;
      }) {
        const targets = articles.filter(
          (a) =>
            (!args.where.id || a.id === args.where.id) &&
            (!args.where.companyId || a.companyId === args.where.companyId),
        );
        const d = args.data as Record<string, unknown>;
        for (const row of targets) {
          if ('title' in d) row.title = d.title as string;
          if ('slug' in d) row.slug = d.slug as string;
          if ('folderId' in d) row.folderId = d.folderId as string | null;
          if ('archivedAt' in d) row.archivedAt = d.archivedAt as Date | null;
          if ('content' in d) row.content = d.content as Prisma.JsonValue;
          if ('contentPlaintext' in d)
            row.contentPlaintext = d.contentPlaintext as string;
          if ('excerpt' in d) row.excerpt = (d.excerpt as string) ?? null;
          if ('visibleToClients' in d)
            row.visibleToClients = d.visibleToClients as boolean;
          if ('updatedBy' in d) row.updatedBy = d.updatedBy as string | null;
          row.updatedAt = new Date();
        }
        return { count: targets.length };
      },
    },
    folder: {
      async findFirst(args: { where: Prisma.FolderWhereInput }) {
        return (
          folders.find(
            (f) =>
              (!args.where.id || f.id === args.where.id) &&
              (!args.where.companyId || f.companyId === args.where.companyId) &&
              (args.where.archivedAt === null ? f.archivedAt === null : true),
          ) ?? null
        );
      },
    },
    // Minimal stub for the actor-name hydration pass; the tests don't
    // assert on `createdByUser` / `updatedByUser`, but the service
    // unconditionally batches one lookup so we have to satisfy it.
    user: {
      async findMany() {
        return [] as Array<{ id: string; name: string; email: string }>;
      },
    },
  };

  const audit = { log: jest.fn(async () => {}) };

  const stars = {
    isStarred: jest.fn(async (_userId: string, _entityType: string, entityId: string) => {
      return starredArticleIds.includes(entityId);
    }),
  };

  return { prisma, audit, stars, articles, folders };
}

function actor(overrides: Partial<AuthedUser> = {}): AuthedUser {
  return {
    id: 'u-1',
    email: 'op@example.com',
    role: 'OPERATOR',
    mfaEnabled: true,
    isSuperAdmin: false,
    ...overrides,
  } as AuthedUser;
}

function meta() {
  return { ip: '127.0.0.1', userAgent: 'jest' };
}

function doc(text: string) {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

describe('ArticlesService', () => {
  describe('create', () => {
    it('rejects non-doc content', async () => {
      const { prisma, audit, stars } = makeStubs();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new ArticlesService(prisma as any, audit as any, stars as any);
      await expect(
        svc.create(
          actor(),
          'c-1',
          {
            title: 'Hello',
            content: { type: 'paragraph' } as unknown as Prisma.JsonValue,
          } as never,
          meta(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('slugifies the title when no slug is provided', async () => {
      const { prisma, audit, stars } = makeStubs();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new ArticlesService(prisma as any, audit as any, stars as any);
      const created = await svc.create(
        actor(),
        'c-1',
        { title: 'Hello World!', content: doc('hi') } as never,
        meta(),
      );
      expect(created.slug).toBe('hello-world');
      expect(created.contentPlaintext).toBe('hi');
    });

    it('throws ConflictException on a slug collision inside the same company', async () => {
      const existing: ArticleRow = {
        id: 'art-existing',
        companyId: 'c-1',
        folderId: null,
        title: 'Original',
        slug: 'howto',
        content: {} as Prisma.JsonValue,
        contentPlaintext: '',
        excerpt: null,
        visibleToClients: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: null,
        updatedBy: null,
        archivedAt: null,
      };
      const { prisma, audit, stars } = makeStubs({ articles: [existing] });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new ArticlesService(prisma as any, audit as any, stars as any);
      await expect(
        svc.create(
          actor(),
          'c-1',
          { title: 'Second', slug: 'howto', content: doc('x') } as never,
          meta(),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('allows the same slug in a different company (tenant isolation)', async () => {
      const other: ArticleRow = {
        id: 'art-other',
        companyId: 'c-2',
        folderId: null,
        title: 'Other co',
        slug: 'howto',
        content: {} as Prisma.JsonValue,
        contentPlaintext: '',
        excerpt: null,
        visibleToClients: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: null,
        updatedBy: null,
        archivedAt: null,
      };
      const { prisma, audit, stars } = makeStubs({ articles: [other] });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new ArticlesService(prisma as any, audit as any, stars as any);
      const created = await svc.create(
        actor(),
        'c-1',
        { title: 'New', slug: 'howto', content: doc('x') } as never,
        meta(),
      );
      expect(created.companyId).toBe('c-1');
      expect(created.slug).toBe('howto');
    });

    it('rejects a folderId that lives in a different company', async () => {
      const folder: FolderRow = {
        id: 'f-other',
        companyId: 'c-2',
        parentId: null,
        name: 'Runbooks',
        slug: 'runbooks',
        icon: null,
        position: 0,
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        archivedAt: null,
      };
      const { prisma, audit, stars } = makeStubs({ folders: [folder] });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new ArticlesService(prisma as any, audit as any, stars as any);
      await expect(
        svc.create(
          actor(),
          'c-1',
          { title: 'x', folderId: 'f-other', content: doc('y') } as never,
          meta(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('read scoping', () => {
    it('returns NotFound when the article belongs to another company', async () => {
      const row: ArticleRow = {
        id: 'art-1',
        companyId: 'c-2',
        folderId: null,
        title: 'x',
        slug: 'x',
        content: {} as Prisma.JsonValue,
        contentPlaintext: '',
        excerpt: null,
        visibleToClients: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: null,
        updatedBy: null,
        archivedAt: null,
      };
      const { prisma, audit, stars } = makeStubs({ articles: [row] });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new ArticlesService(prisma as any, audit as any, stars as any);
      await expect(svc.getById(actor(), 'c-1', 'art-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('hides articles flagged visibleToClients=false from CLIENT_USER', async () => {
      const row: ArticleRow = {
        id: 'art-1',
        companyId: 'c-1',
        folderId: null,
        title: 'Internal',
        slug: 'internal',
        content: {} as Prisma.JsonValue,
        contentPlaintext: '',
        excerpt: null,
        visibleToClients: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: null,
        updatedBy: null,
        archivedAt: null,
      };
      const { prisma, audit, stars } = makeStubs({ articles: [row] });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new ArticlesService(prisma as any, audit as any, stars as any);
      await expect(
        svc.getById(actor({ role: 'CLIENT_USER' }), 'c-1', 'art-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns internal articles to OPERATOR', async () => {
      const row: ArticleRow = {
        id: 'art-1',
        companyId: 'c-1',
        folderId: null,
        title: 'Internal',
        slug: 'internal',
        content: {} as Prisma.JsonValue,
        contentPlaintext: '',
        excerpt: null,
        visibleToClients: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: null,
        updatedBy: null,
        archivedAt: null,
      };
      const { prisma, audit, stars } = makeStubs({ articles: [row] });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new ArticlesService(prisma as any, audit as any, stars as any);
      const got = await svc.getById(actor(), 'c-1', 'art-1');
      expect(got.id).toBe('art-1');
    });
  });

  describe('archive / restore', () => {
    it('archives and prevents further edits until restored', async () => {
      const row: ArticleRow = {
        id: 'art-1',
        companyId: 'c-1',
        folderId: null,
        title: 'x',
        slug: 'x',
        content: {} as Prisma.JsonValue,
        contentPlaintext: '',
        excerpt: null,
        visibleToClients: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: null,
        updatedBy: null,
        archivedAt: null,
      };
      const { prisma, audit, stars } = makeStubs({ articles: [row] });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new ArticlesService(prisma as any, audit as any, stars as any);
      const archived = await svc.archive(actor(), 'c-1', 'art-1', meta());
      expect(archived.archivedAt).toBeInstanceOf(Date);

      await expect(
        svc.update(actor(), 'c-1', 'art-1', { title: 'renamed' }, meta()),
      ).rejects.toBeInstanceOf(BadRequestException);

      const restored = await svc.restore(actor(), 'c-1', 'art-1', meta());
      expect(restored.archivedAt).toBeNull();
    });
  });
});
