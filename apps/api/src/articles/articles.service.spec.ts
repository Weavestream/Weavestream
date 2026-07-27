import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  type Article,
  type ArticleVersion,
  type Folder,
} from '@prisma/client';
import { ArticlesService, StaleArticleError } from './articles.service.js';
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
 *  - versioning: create writes v1, autosave coalesces into one draft
 *    row, explicit Save promotes that draft (no new row), Cancel
 *    discards the draft and reverts, restore creates a forward row,
 *    archive auto-discards drafts, purge cascade-deletes versions.
 */

type ArticleRow = Article;
type ArticleVersionRow = ArticleVersion;
type FolderRow = Folder;

interface UploadRow {
  id: string;
  companyId: string;
  attachedToType: string | null;
  deletedAt: Date | null;
}

function makeStubs(initial: {
  articles?: ArticleRow[];
  folders?: FolderRow[];
  starredArticleIds?: string[];
  uploads?: UploadRow[];
  versions?: ArticleVersionRow[];
} = {}) {
  const articles: ArticleRow[] = [...(initial.articles ?? [])];
  const folders: FolderRow[] = [...(initial.folders ?? [])];
  const starredArticleIds: string[] = [...(initial.starredArticleIds ?? [])];
  const uploadRows: UploadRow[] = [...(initial.uploads ?? [])];
  const versions: ArticleVersionRow[] = [...(initial.versions ?? [])];
  let versionIdCounter = versions.length;

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

  // Real Postgres returns a fresh snapshot on every `findFirst`. The
  // stub used to return the in-memory row reference directly, which
  // meant the service's pre-update `existing` snapshot would
  // *mutate* alongside the subsequent `updateMany` call and the diff
  // would always compute as "nothing changed". Clone on read so the
  // service's snapshot semantics match production.
  function clone<T>(row: T): T {
    return { ...row } as T;
  }

  const prisma = {
    integrationSyncRecord: {
      async findMany() { return []; },
    },
    article: {
      async findFirst(args: { where: Prisma.ArticleWhereInput }) {
        const hit = articles.find((a) => matchesWhere(a, args.where));
        return hit ? clone(hit) : null;
      },
      async findFirstOrThrow(args: { where: Prisma.ArticleWhereInput }) {
        const hit = articles.find((a) => matchesWhere(a, args.where));
        if (!hit) throw new Error('not found');
        return clone(hit);
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
        return results.map(clone);
      },
      async create(args: { data: Prisma.ArticleUncheckedCreateInput }): Promise<ArticleRow> {
        const d = args.data;
        const row: ArticleRow = {
          id: `art-${articles.length + 1}`,
          companyId: d.companyId,
          folderId: (d.folderId as string | null) ?? null,
          title: d.title,
          slug: d.slug,
          editorMode: (d.editorMode as string) ?? 'tiptap',
          content:
            d.content === Prisma.DbNull || d.content === null
              ? null
              : (d.content as unknown as Prisma.JsonValue),
          markdownSource: (d.markdownSource as string | null) ?? null,
          contentPlaintext: d.contentPlaintext as string,
          excerpt: (d.excerpt as string | null) ?? null,
          derivedExcerpt: (d.derivedExcerpt as string | null) ?? null,
          aiSummary: null,
          aiSummaryModel: null,
          // Honors the service's gate-aware stamp: null = pending.
          aiSummaryAt:
            'aiSummaryAt' in d ? ((d.aiSummaryAt as Date | null) ?? null) : new Date(0),
          visibleToClients: (d.visibleToClients as boolean) ?? true,
          createdAt: new Date(),
          updatedAt: new Date(),
          createdBy: (d.createdBy as string | null) ?? null,
          updatedBy: (d.updatedBy as string | null) ?? null,
          revision: 1,
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
      // target another). Mirror that here with a two-predicate filter,
      // plus the optimistic-concurrency predicates (`revision`,
      // `archivedAt: null`) the guarded apply path adds to the WHERE.
      async updateMany(args: {
        where: {
          id?: string;
          companyId?: string;
          revision?: number;
          archivedAt?: Date | null;
        };
        data: Prisma.ArticleUncheckedUpdateManyInput;
      }) {
        const targets = articles.filter(
          (a) =>
            (!args.where.id || a.id === args.where.id) &&
            (!args.where.companyId || a.companyId === args.where.companyId) &&
            (args.where.revision === undefined ||
              a.revision === args.where.revision) &&
            (!('archivedAt' in args.where) ||
              args.where.archivedAt !== null ||
              a.archivedAt === null),
        );
        const d = args.data as Record<string, unknown>;
        for (const row of targets) {
          if ('title' in d) row.title = d.title as string;
          if ('slug' in d) row.slug = d.slug as string;
          if ('folderId' in d) row.folderId = d.folderId as string | null;
          if ('archivedAt' in d) row.archivedAt = d.archivedAt as Date | null;
          if ('editorMode' in d) row.editorMode = d.editorMode as string;
          if ('markdownSource' in d)
            row.markdownSource = d.markdownSource as string | null;
          if ('content' in d) {
            row.content =
              d.content === Prisma.DbNull || d.content === null
                ? null
                : (d.content as Prisma.JsonValue);
          }
          if ('contentPlaintext' in d)
            row.contentPlaintext = d.contentPlaintext as string;
          if ('excerpt' in d) row.excerpt = (d.excerpt as string) ?? null;
          if ('derivedExcerpt' in d)
            row.derivedExcerpt = (d.derivedExcerpt as string) ?? null;
          if ('aiSummary' in d) row.aiSummary = (d.aiSummary as string) ?? null;
          if ('aiSummaryModel' in d)
            row.aiSummaryModel = (d.aiSummaryModel as string) ?? null;
          if ('aiSummaryAt' in d)
            row.aiSummaryAt = (d.aiSummaryAt as Date) ?? null;
          if ('visibleToClients' in d)
            row.visibleToClients = d.visibleToClients as boolean;
          if ('revision' in d) {
            const r = d.revision as number | { increment: number };
            row.revision =
              typeof r === 'number' ? r : row.revision + r.increment;
          }
          if ('updatedBy' in d) row.updatedBy = d.updatedBy as string | null;
          row.updatedAt = new Date();
        }
        return { count: targets.length };
      },
      async deleteMany(args: {
        where: { id?: string; companyId?: string };
      }) {
        const before = articles.length;
        for (let i = articles.length - 1; i >= 0; i--) {
          const a = articles[i]!;
          if (
            (!args.where.id || a.id === args.where.id) &&
            (!args.where.companyId || a.companyId === args.where.companyId)
          ) {
            articles.splice(i, 1);
          }
        }
        return { count: before - articles.length };
      },
    },
    upload: {
      async updateMany(args: {
        where: {
          id?: { in?: string[] };
          companyId?: string;
          attachedToType?: string;
          deletedAt?: Date | null;
        };
        data: { deletedAt?: Date };
      }) {
        const idIn = args.where.id?.in;
        let count = 0;
        for (const u of uploadRows) {
          if (idIn && !idIn.includes(u.id)) continue;
          if (args.where.companyId && u.companyId !== args.where.companyId) continue;
          if (args.where.attachedToType && u.attachedToType !== args.where.attachedToType) continue;
          if (args.where.deletedAt === null && u.deletedAt !== null) continue;
          if (args.data.deletedAt !== undefined) u.deletedAt = args.data.deletedAt;
          count += 1;
        }
        return { count };
      },
    },
    // Minimal in-memory model for `article_versions`. Only the
    // operations the service actually performs are stubbed; missing
    // operations explode loudly during the test rather than silently
    // returning empty data.
    articleVersion: {
      async create(args: { data: Record<string, unknown> }): Promise<ArticleVersionRow> {
        versionIdCounter += 1;
        const d = args.data;
        const row: ArticleVersionRow = {
          id: `av-${versionIdCounter}`,
          articleId: d.articleId as string,
          companyId: d.companyId as string,
          version: d.version as number,
          isDraft: (d.isDraft as boolean) ?? false,
          title: d.title as string,
          slug: d.slug as string,
          folderId: (d.folderId as string | null) ?? null,
          visibleToClients: (d.visibleToClients as boolean) ?? true,
          editorMode: (d.editorMode as string) ?? 'tiptap',
          content:
            d.content === Prisma.DbNull || d.content === null
              ? null
              : (d.content as Prisma.JsonValue),
          markdownSource: (d.markdownSource as string | null) ?? null,
          contentPlaintext: (d.contentPlaintext as string) ?? '',
          excerpt: (d.excerpt as string | null) ?? null,
          changedFields: ((d.changedFields as string[] | undefined) ?? []) as string[],
          changedBy: d.changedBy as string,
          changeReason: (d.changeReason as string | null) ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        versions.push(row);
        return row;
      },
      async findFirst(args: {
        where?: {
          articleId?: string;
          companyId?: string;
          isDraft?: boolean;
          version?: number;
          visibleToClients?: boolean;
        };
        orderBy?: { version?: 'asc' | 'desc' };
      }): Promise<ArticleVersionRow | null> {
        const where = args.where ?? {};
        const matches = versions.filter((v) => {
          if (where.articleId && v.articleId !== where.articleId) return false;
          if (where.companyId && v.companyId !== where.companyId) return false;
          if (where.isDraft !== undefined && v.isDraft !== where.isDraft) return false;
          if (where.version !== undefined && v.version !== where.version) return false;
          if (
            where.visibleToClients !== undefined &&
            v.visibleToClients !== where.visibleToClients
          )
            return false;
          return true;
        });
        if (args.orderBy?.version === 'desc') {
          matches.sort((a, b) => b.version - a.version);
        } else if (args.orderBy?.version === 'asc') {
          matches.sort((a, b) => a.version - b.version);
        }
        return matches[0] ?? null;
      },
      async findMany(args: {
        where?: {
          articleId?: string;
          companyId?: string;
          isDraft?: boolean;
          visibleToClients?: boolean;
        };
        orderBy?: { version?: 'asc' | 'desc' };
        select?: Record<string, boolean>;
      }): Promise<Array<Partial<ArticleVersionRow>>> {
        const where = args.where ?? {};
        let matches = versions.filter((v) => {
          if (where.articleId && v.articleId !== where.articleId) return false;
          if (where.companyId && v.companyId !== where.companyId) return false;
          if (where.isDraft !== undefined && v.isDraft !== where.isDraft) return false;
          if (
            where.visibleToClients !== undefined &&
            v.visibleToClients !== where.visibleToClients
          )
            return false;
          return true;
        });
        if (args.orderBy?.version === 'desc') {
          matches = [...matches].sort((a, b) => b.version - a.version);
        } else if (args.orderBy?.version === 'asc') {
          matches = [...matches].sort((a, b) => a.version - b.version);
        }
        if (args.select) {
          return matches.map((v) => {
            const projected: Partial<ArticleVersionRow> = {};
            for (const key of Object.keys(args.select!) as Array<
              keyof ArticleVersionRow
            >) {
              if (args.select![key as string]) {
                (projected as Record<string, unknown>)[key as string] = v[key];
              }
            }
            return projected;
          });
        }
        return matches;
      },
      async aggregate(args: {
        where?: { articleId?: string; companyId?: string };
        _max?: { version?: boolean };
      }): Promise<{ _max: { version: number | null } }> {
        const where = args.where ?? {};
        const matches = versions.filter((v) => {
          if (where.articleId && v.articleId !== where.articleId) return false;
          if (where.companyId && v.companyId !== where.companyId) return false;
          return true;
        });
        const max = matches.reduce<number | null>(
          (acc, v) => (acc === null || v.version > acc ? v.version : acc),
          null,
        );
        return { _max: { version: max } };
      },
      async update(args: {
        where: { id: string };
        data: Record<string, unknown>;
      }): Promise<ArticleVersionRow> {
        const idx = versions.findIndex((v) => v.id === args.where.id);
        if (idx < 0) throw new Error('not found');
        const current = versions[idx]!;
        const d = args.data;
        const next: ArticleVersionRow = { ...current };
        if ('title' in d) next.title = d.title as string;
        if ('slug' in d) next.slug = d.slug as string;
        if ('folderId' in d) next.folderId = (d.folderId as string | null) ?? null;
        if ('visibleToClients' in d) next.visibleToClients = d.visibleToClients as boolean;
        if ('editorMode' in d) next.editorMode = d.editorMode as string;
        if ('content' in d) {
          next.content =
            d.content === Prisma.DbNull || d.content === null
              ? null
              : (d.content as Prisma.JsonValue);
        }
        if ('markdownSource' in d) next.markdownSource = (d.markdownSource as string | null) ?? null;
        if ('contentPlaintext' in d) next.contentPlaintext = d.contentPlaintext as string;
        if ('excerpt' in d) next.excerpt = (d.excerpt as string | null) ?? null;
        if ('isDraft' in d) next.isDraft = d.isDraft as boolean;
        if ('changedFields' in d) next.changedFields = d.changedFields as string[];
        if ('changedBy' in d) next.changedBy = d.changedBy as string;
        if ('changeReason' in d) next.changeReason = (d.changeReason as string | null) ?? null;
        next.updatedAt = new Date();
        versions[idx] = next;
        return next;
      },
      async delete(args: { where: { id: string } }): Promise<ArticleVersionRow> {
        const idx = versions.findIndex((v) => v.id === args.where.id);
        if (idx < 0) throw new Error('not found');
        const removed = versions[idx]!;
        versions.splice(idx, 1);
        return removed;
      },
      async updateMany(args: {
        where: { id?: string; companyId?: string; articleId?: string };
        data: Record<string, unknown>;
      }): Promise<{ count: number }> {
        const where = args.where;
        const matches = versions
          .map((v, idx) => ({ v, idx }))
          .filter(({ v }) => {
            if (where.id && v.id !== where.id) return false;
            if (where.companyId && v.companyId !== where.companyId) return false;
            if (where.articleId && v.articleId !== where.articleId) return false;
            return true;
          });
        const d = args.data;
        for (const { v: current, idx } of matches) {
          const next: ArticleVersionRow = { ...current };
          if ('title' in d) next.title = d.title as string;
          if ('slug' in d) next.slug = d.slug as string;
          if ('folderId' in d) next.folderId = (d.folderId as string | null) ?? null;
          if ('visibleToClients' in d) next.visibleToClients = d.visibleToClients as boolean;
          if ('editorMode' in d) next.editorMode = d.editorMode as string;
          if ('content' in d) {
            next.content =
              d.content === Prisma.DbNull || d.content === null
                ? null
                : (d.content as Prisma.JsonValue);
          }
          if ('markdownSource' in d)
            next.markdownSource = (d.markdownSource as string | null) ?? null;
          if ('contentPlaintext' in d) next.contentPlaintext = d.contentPlaintext as string;
          if ('excerpt' in d) next.excerpt = (d.excerpt as string | null) ?? null;
          if ('isDraft' in d) next.isDraft = d.isDraft as boolean;
          if ('changedFields' in d) next.changedFields = d.changedFields as string[];
          if ('changedBy' in d) next.changedBy = d.changedBy as string;
          if ('changeReason' in d)
            next.changeReason = (d.changeReason as string | null) ?? null;
          next.updatedAt = new Date();
          versions[idx] = next;
        }
        return { count: matches.length };
      },
      async deleteMany(args: {
        where: { id?: string; companyId?: string; articleId?: string };
      }): Promise<{ count: number }> {
        const where = args.where;
        const before = versions.length;
        for (let i = versions.length - 1; i >= 0; i--) {
          const v = versions[i]!;
          if (where.id && v.id !== where.id) continue;
          if (where.companyId && v.companyId !== where.companyId) continue;
          if (where.articleId && v.articleId !== where.articleId) continue;
          versions.splice(i, 1);
        }
        return { count: before - versions.length };
      },
      async count(args: {
        where?: { articleId?: string; companyId?: string; isDraft?: boolean };
      }): Promise<number> {
        const where = args.where ?? {};
        return versions.filter((v) => {
          if (where.articleId && v.articleId !== where.articleId) return false;
          if (where.companyId && v.companyId !== where.companyId) return false;
          if (where.isDraft !== undefined && v.isDraft !== where.isDraft) return false;
          return true;
        }).length;
      },
    },
     
    async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return fn(prisma);
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
      async findUnique(_args: {
        where: { id: string };
        select?: Record<string, boolean>;
      }) {
        return null as { id: string; name: string; email: string } | null;
      },
    },
  };

  const audit = { log: jest.fn(async () => {}) };

  const stars = {
    isStarred: jest.fn(async (_userId: string, _entityType: string, entityId: string) => {
      return starredArticleIds.includes(entityId);
    }),
  };

  const uploads = {
    softDeleteManyForArticle: jest.fn(async () => ({ softDeleted: 0 })),
  };

  const relations = {
    cleanupForArticle: jest.fn(async () => {}),
  };

  return {
    prisma,
    audit,
    stars,
    uploads,
    relations,
    articles,
    folders,
    uploadRows,
    versions,
  };
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
      const { prisma, audit, stars, uploads, relations } = makeStubs();
       
      const svc = new ArticlesService(prisma as any, audit as any, stars as any, uploads as any, relations as any, { isAutoSummariesEnabled: async () => false } as never, { enqueueArticleSummary: async () => 'job-1' } as never);
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
      const { prisma, audit, stars, uploads, relations } = makeStubs();
       
      const svc = new ArticlesService(prisma as any, audit as any, stars as any, uploads as any, relations as any, { isAutoSummariesEnabled: async () => false } as never, { enqueueArticleSummary: async () => 'job-1' } as never);
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
        editorMode: 'tiptap',
        markdownSource: null,
        content: {} as Prisma.JsonValue,
        contentPlaintext: '',
        excerpt: null,
        derivedExcerpt: null,
        aiSummary: null,
        aiSummaryModel: null,
        aiSummaryAt: new Date(0),
        visibleToClients: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: null,
        updatedBy: null,
        revision: 1,
        archivedAt: null,
      };
      const { prisma, audit, stars, uploads, relations } = makeStubs({ articles: [existing] });
       
      const svc = new ArticlesService(prisma as any, audit as any, stars as any, uploads as any, relations as any, { isAutoSummariesEnabled: async () => false } as never, { enqueueArticleSummary: async () => 'job-1' } as never);
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
        editorMode: 'tiptap',
        markdownSource: null,
        content: {} as Prisma.JsonValue,
        contentPlaintext: '',
        excerpt: null,
        derivedExcerpt: null,
        aiSummary: null,
        aiSummaryModel: null,
        aiSummaryAt: new Date(0),
        visibleToClients: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: null,
        updatedBy: null,
        revision: 1,
        archivedAt: null,
      };
      const { prisma, audit, stars, uploads, relations } = makeStubs({ articles: [other] });
       
      const svc = new ArticlesService(prisma as any, audit as any, stars as any, uploads as any, relations as any, { isAutoSummariesEnabled: async () => false } as never, { enqueueArticleSummary: async () => 'job-1' } as never);
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
      const { prisma, audit, stars, uploads, relations } = makeStubs({ folders: [folder] });
       
      const svc = new ArticlesService(prisma as any, audit as any, stars as any, uploads as any, relations as any, { isAutoSummariesEnabled: async () => false } as never, { enqueueArticleSummary: async () => 'job-1' } as never);
      await expect(
        svc.create(
          actor(),
          'c-1',
          { title: 'x', folderId: 'f-other', content: doc('y') } as never,
          meta(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('persists Markdown and derives search plaintext without Markdown syntax', async () => {
      const { prisma, audit, stars, uploads, relations } = makeStubs();
       
      const svc = new ArticlesService(prisma as any, audit as any, stars as any, uploads as any, relations as any, { isAutoSummariesEnabled: async () => false } as never, { enqueueArticleSummary: async () => 'job-1' } as never);
      const created = await svc.create(
        actor(),
        'c-1',
        {
          editorMode: 'markdown',
          title: 'MD post',
          markdownSource: '# Heading\n\n**Body** keyword',
        } as never,
        meta(),
      );
      expect(created.editorMode).toBe('markdown');
      expect(created.content).toBeNull();
      expect(created.markdownSource).toContain('# Heading');
      expect(created.contentPlaintext).toContain('keyword');
      expect(created.contentPlaintext).not.toContain('**');
    });
  });

  describe('update', () => {
    it('recomputes contentPlaintext when Markdown body changes', async () => {
      const row: ArticleRow = {
        id: 'art-md',
        companyId: 'c-1',
        folderId: null,
        title: 't',
        slug: 't',
        editorMode: 'markdown',
        markdownSource: '# A',
        content: null,
        contentPlaintext: 'A',
        excerpt: 'A',
        derivedExcerpt: null,
        aiSummary: null,
        aiSummaryModel: null,
        aiSummaryAt: new Date(0),
        visibleToClients: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: null,
        updatedBy: null,
        revision: 1,
        archivedAt: null,
      };
      const { prisma, audit, stars, uploads, relations } = makeStubs({ articles: [row] });
       
      const svc = new ArticlesService(prisma as any, audit as any, stars as any, uploads as any, relations as any, { isAutoSummariesEnabled: async () => false } as never, { enqueueArticleSummary: async () => 'job-1' } as never);
      const updated = await svc.update(
        actor(),
        'c-1',
        'art-md',
        {
          editorMode: 'markdown',
          markdownSource: '## B\n\n*x* found',
        } as never,
        meta(),
      );
      expect(updated.contentPlaintext.toLowerCase()).toContain('found');
      expect(updated.contentPlaintext).not.toContain('*');
    });

    it('rejects a bare Tiptap content patch on a Markdown article', async () => {
      const row: ArticleRow = {
        id: 'art-md',
        companyId: 'c-1',
        folderId: null,
        title: 't',
        slug: 't',
        editorMode: 'markdown',
        markdownSource: 'x',
        content: null,
        contentPlaintext: 'x',
        excerpt: null,
        derivedExcerpt: null,
        aiSummary: null,
        aiSummaryModel: null,
        aiSummaryAt: new Date(0),
        visibleToClients: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: null,
        updatedBy: null,
        revision: 1,
        archivedAt: null,
      };
      const { prisma, audit, stars, uploads, relations } = makeStubs({ articles: [row] });
       
      const svc = new ArticlesService(prisma as any, audit as any, stars as any, uploads as any, relations as any, { isAutoSummariesEnabled: async () => false } as never, { enqueueArticleSummary: async () => 'job-1' } as never);
      await expect(
        svc.update(actor(), 'c-1', 'art-md', { content: doc('y') } as never, meta()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('revision guard (WS-030)', () => {
    function mdRow(overrides: Partial<ArticleRow> = {}): ArticleRow {
      return {
        id: 'art-md',
        companyId: 'c-1',
        folderId: null,
        title: 't',
        slug: 't',
        editorMode: 'markdown',
        markdownSource: '# A',
        content: null,
        contentPlaintext: 'A',
        excerpt: 'A',
        derivedExcerpt: null,
        aiSummary: null,
        aiSummaryModel: null,
        aiSummaryAt: new Date(0),
        visibleToClients: true,
        revision: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: null,
        updatedBy: null,
        archivedAt: null,
        ...overrides,
      };
    }

    function mkSvc(initial: Parameters<typeof makeStubs>[0] = {}) {
      const stubs = makeStubs(initial);
      const svc = new ArticlesService(
         
        stubs.prisma as any,
         
        stubs.audit as any,
         
        stubs.stars as any,
         
        stubs.uploads as any,
         
        stubs.relations as any, { isAutoSummariesEnabled: async () => false } as never, { enqueueArticleSummary: async () => 'job-1' } as never);
      return { svc, ...stubs };
    }

    it('increments revision on an explicit content save', async () => {
      const { svc } = mkSvc({ articles: [mdRow()] });
      const updated = await svc.update(
        actor(),
        'c-1',
        'art-md',
        { editorMode: 'markdown', markdownSource: '## B' } as never,
        meta(),
      );
      expect(updated.revision).toBe(2);
    });

    it('increments revision on an autosave draft write', async () => {
      const { svc, articles } = mkSvc({ articles: [mdRow()] });
      await svc.update(
        actor(),
        'c-1',
        'art-md',
        { editorMode: 'markdown', markdownSource: '## B', draft: true } as never,
        meta(),
      );
      expect(articles[0]!.revision).toBe(2);
    });

    it('increments revision on a title-only change', async () => {
      const { svc } = mkSvc({ articles: [mdRow()] });
      const updated = await svc.update(
        actor(),
        'c-1',
        'art-md',
        { title: 'renamed' } as never,
        meta(),
      );
      expect(updated.revision).toBe(2);
    });

    it('does not touch revision on move', async () => {
      const { svc, articles } = mkSvc({ articles: [mdRow()] });
      await svc.move(actor(), 'c-1', 'art-md', { folderId: null } as never, meta());
      expect(articles[0]!.revision).toBe(1);
    });

    it('applies with a matching expectedRevision and carries the guard in the WHERE', async () => {
      const { svc, prisma } = mkSvc({ articles: [mdRow({ revision: 4 })] });
      const spy = jest.spyOn(prisma.article, 'updateMany');
      const updated = await svc.update(
        actor(),
        'c-1',
        'art-md',
        { editorMode: 'markdown', markdownSource: '## guarded' } as never,
        meta(),
        { expectedRevision: 4 },
      );
      expect(updated.revision).toBe(5);
      // The guard must literally ride the WHERE clause of the write —
      // never a separate read-then-check.
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'art-md',
            companyId: 'c-1',
            revision: 4,
            archivedAt: null,
          }),
        }),
      );
    });

    it('throws StaleArticleError on revision mismatch without writing history or audit', async () => {
      const { svc, articles, versions, audit } = mkSvc({
        articles: [mdRow({ revision: 6, markdownSource: '# newer' })],
      });
      await expect(
        svc.update(
          actor(),
          'c-1',
          'art-md',
          { editorMode: 'markdown', markdownSource: '## from-proposal' } as never,
          meta(),
          { expectedRevision: 5 },
        ),
      ).rejects.toBeInstanceOf(StaleArticleError);
      // The newer content survives untouched and nothing was recorded.
      expect(articles[0]!.markdownSource).toBe('# newer');
      expect(articles[0]!.revision).toBe(6);
      expect(versions).toHaveLength(0);
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('refuses a guarded write to an archived article', async () => {
      // The unguarded HTTP path pre-checks archived state before the tx;
      // the guarded path must also refuse INSIDE the WHERE. Bypass the
      // pre-check by archiving between snapshot and write is impossible
      // to stage with the stub, so assert the WHERE-level behavior
      // directly: a row that is archived matches zero rows.
      const { prisma } = mkSvc({
        articles: [mdRow({ archivedAt: new Date(), revision: 3 })],
      });
      const res = await prisma.article.updateMany({
        where: { id: 'art-md', companyId: 'c-1', revision: 3, archivedAt: null },
        data: { title: 'x' },
      });
      expect(res.count).toBe(0);
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
        editorMode: 'tiptap',
        markdownSource: null,
        content: {} as Prisma.JsonValue,
        contentPlaintext: '',
        excerpt: null,
        derivedExcerpt: null,
        aiSummary: null,
        aiSummaryModel: null,
        aiSummaryAt: new Date(0),
        visibleToClients: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: null,
        updatedBy: null,
        revision: 1,
        archivedAt: null,
      };
      const { prisma, audit, stars, uploads, relations } = makeStubs({ articles: [row] });
       
      const svc = new ArticlesService(prisma as any, audit as any, stars as any, uploads as any, relations as any, { isAutoSummariesEnabled: async () => false } as never, { enqueueArticleSummary: async () => 'job-1' } as never);
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
        editorMode: 'tiptap',
        markdownSource: null,
        content: {} as Prisma.JsonValue,
        contentPlaintext: '',
        excerpt: null,
        derivedExcerpt: null,
        aiSummary: null,
        aiSummaryModel: null,
        aiSummaryAt: new Date(0),
        visibleToClients: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: null,
        updatedBy: null,
        revision: 1,
        archivedAt: null,
      };
      const { prisma, audit, stars, uploads, relations } = makeStubs({ articles: [row] });
       
      const svc = new ArticlesService(prisma as any, audit as any, stars as any, uploads as any, relations as any, { isAutoSummariesEnabled: async () => false } as never, { enqueueArticleSummary: async () => 'job-1' } as never);
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
        editorMode: 'tiptap',
        markdownSource: null,
        content: {} as Prisma.JsonValue,
        contentPlaintext: '',
        excerpt: null,
        derivedExcerpt: null,
        aiSummary: null,
        aiSummaryModel: null,
        aiSummaryAt: new Date(0),
        visibleToClients: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: null,
        updatedBy: null,
        revision: 1,
        archivedAt: null,
      };
      const { prisma, audit, stars, uploads, relations } = makeStubs({ articles: [row] });
       
      const svc = new ArticlesService(prisma as any, audit as any, stars as any, uploads as any, relations as any, { isAutoSummariesEnabled: async () => false } as never, { enqueueArticleSummary: async () => 'job-1' } as never);
      const got = await svc.getById(actor(), 'c-1', 'art-1');
      expect(got.id).toBe('art-1');
    });
  });

  describe('list', () => {
    it('orders by archivedAt (nulls first), title, then id as the cursor tie-breaker', async () => {
      const { prisma, audit, stars, uploads, relations } = makeStubs();
      const findManySpy = jest.spyOn(prisma.article, 'findMany');

      const svc = new ArticlesService(prisma as any, audit as any, stars as any, uploads as any, relations as any, { isAutoSummariesEnabled: async () => false } as never, { enqueueArticleSummary: async () => 'job-1' } as never);

      await svc.list(actor(), 'c-1');

      // The trailing { id: 'asc' } is load-bearing: Prisma cursor
      // pagination needs a unique total order or duplicate titles make
      // pages skip/repeat rows. Real ordering semantics are covered by
      // articles.pagination.db.spec.ts (this fake ignores orderBy).
      expect(findManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ archivedAt: 'asc' }, { title: 'asc' }, { id: 'asc' }],
        }),
      );
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
        editorMode: 'tiptap',
        markdownSource: null,
        content: {} as Prisma.JsonValue,
        contentPlaintext: '',
        excerpt: null,
        derivedExcerpt: null,
        aiSummary: null,
        aiSummaryModel: null,
        aiSummaryAt: new Date(0),
        visibleToClients: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: null,
        updatedBy: null,
        revision: 1,
        archivedAt: null,
      };
      const { prisma, audit, stars, uploads, relations } = makeStubs({ articles: [row] });
       
      const svc = new ArticlesService(prisma as any, audit as any, stars as any, uploads as any, relations as any, { isAutoSummariesEnabled: async () => false } as never, { enqueueArticleSummary: async () => 'job-1' } as never);
      const archived = await svc.archive(actor(), 'c-1', 'art-1', meta());
      expect(archived.archivedAt).toBeInstanceOf(Date);

      await expect(
        svc.update(actor(), 'c-1', 'art-1', { title: 'renamed' }, meta()),
      ).rejects.toBeInstanceOf(BadRequestException);

      const restored = await svc.restore(actor(), 'c-1', 'art-1', meta());
      expect(restored.archivedAt).toBeNull();
    });
  });

  describe('purge', () => {
    function archivedRow(overrides: Partial<ArticleRow> = {}): ArticleRow {
      return {
        id: 'art-1',
        companyId: 'c-1',
        folderId: null,
        title: 'Doomed',
        slug: 'doomed',
        editorMode: 'tiptap',
        markdownSource: null,
        content: {} as Prisma.JsonValue,
        contentPlaintext: '',
        excerpt: null,
        derivedExcerpt: null,
        aiSummary: null,
        aiSummaryModel: null,
        aiSummaryAt: new Date(0),
        visibleToClients: true,
        revision: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: null,
        updatedBy: null,
        archivedAt: new Date('2024-01-01T00:00:00Z'),
        ...overrides,
      };
    }

    it('refuses to purge an article that is not archived', async () => {
      const row = archivedRow({ archivedAt: null });
      const { prisma, audit, stars, uploads, relations } = makeStubs({
        articles: [row],
      });
      const svc = new ArticlesService(
         
        prisma as any,
         
        audit as any,
         
        stars as any,
         
        uploads as any,
         
        relations as any, { isAutoSummariesEnabled: async () => false } as never, { enqueueArticleSummary: async () => 'job-1' } as never);

      await expect(svc.purge(actor(), 'c-1', 'art-1', meta())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('returns NotFound when the article belongs to another tenant', async () => {
      const row = archivedRow({ companyId: 'c-2' });
      const { prisma, audit, stars, uploads, relations } = makeStubs({
        articles: [row],
      });
      const svc = new ArticlesService(
         
        prisma as any,
         
        audit as any,
         
        stars as any,
         
        uploads as any,
         
        relations as any, { isAutoSummariesEnabled: async () => false } as never, { enqueueArticleSummary: async () => 'job-1' } as never);

      await expect(svc.purge(actor(), 'c-1', 'art-1', meta())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('deletes the row, cleans relations, and writes an article.purge audit entry', async () => {
      const row = archivedRow();
      const { prisma, audit, stars, uploads, relations, articles } = makeStubs({
        articles: [row],
      });
      const svc = new ArticlesService(
         
        prisma as any,
         
        audit as any,
         
        stars as any,
         
        uploads as any,
         
        relations as any, { isAutoSummariesEnabled: async () => false } as never, { enqueueArticleSummary: async () => 'job-1' } as never);

      const result = await svc.purge(actor(), 'c-1', 'art-1', meta());

      expect(result).toEqual({ id: 'art-1' });
      expect(articles).toHaveLength(0);
      expect(relations.cleanupForArticle).toHaveBeenCalledWith(
        expect.objectContaining({ companyId: 'c-1', articleId: 'art-1' }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'article.purge',
          entityType: 'Article',
          entityId: 'art-1',
          companyId: 'c-1',
          after: null,
        }),
      );
    });

    it('soft-deletes uploads embedded in the article body', async () => {
      const uploadId = '11111111-1111-1111-1111-111111111111';
      const body = `before /api/v1/companies/22222222-2222-2222-2222-222222222222/uploads/${uploadId}/image after`;
      const row = archivedRow({
        editorMode: 'markdown',
        content: null,
        markdownSource: body,
      });
      const { prisma, audit, stars, uploads, relations, uploadRows } = makeStubs({
        articles: [row],
        uploads: [
          {
            id: uploadId,
            companyId: 'c-1',
            attachedToType: 'article',
            deletedAt: null,
          },
        ],
      });
      const svc = new ArticlesService(
         
        prisma as any,
         
        audit as any,
         
        stars as any,
         
        uploads as any,
         
        relations as any, { isAutoSummariesEnabled: async () => false } as never, { enqueueArticleSummary: async () => 'job-1' } as never);

      await svc.purge(actor(), 'c-1', 'art-1', meta());

      const upload = uploadRows.find((u) => u.id === uploadId)!;
      expect(upload.deletedAt).toBeInstanceOf(Date);
    });

    it('soft-deletes uploads referenced only by historical versions', async () => {
      // Reproduces the bug where an image used in v1 but removed in v2
      // survived a permanent delete because purge only scanned the
      // live body. update() deliberately keeps these uploads alive (so
      // Restore is lossless), so purge has to clean them up.
      const liveUploadId = '11111111-1111-1111-1111-111111111111';
      const historyOnlyUploadId = '33333333-3333-3333-3333-333333333333';
      const companyUuid = '22222222-2222-2222-2222-222222222222';
      const liveBody = `live /api/v1/companies/${companyUuid}/uploads/${liveUploadId}/image`;
      const historyBody = `old /api/v1/companies/${companyUuid}/uploads/${historyOnlyUploadId}/image and /api/v1/companies/${companyUuid}/uploads/${liveUploadId}/image`;
      const row = archivedRow({
        editorMode: 'markdown',
        content: null,
        markdownSource: liveBody,
      });
      const v1: ArticleVersionRow = {
        id: 'av-1',
        articleId: 'art-1',
        companyId: 'c-1',
        version: 1,
        isDraft: false,
        title: 'Doomed',
        slug: 'doomed',
        folderId: null,
        visibleToClients: true,
        editorMode: 'markdown',
        content: null,
        markdownSource: historyBody,
        contentPlaintext: 'old',
        excerpt: null,
        changedFields: ['markdownSource'],
        changedBy: 'u-1',
        changeReason: 'initial version',
        createdAt: new Date('2024-01-01T00:00:00Z'),
        updatedAt: new Date('2024-01-01T00:00:00Z'),
      };
      const { prisma, audit, stars, uploads, relations, uploadRows } = makeStubs({
        articles: [row],
        versions: [v1],
        uploads: [
          {
            id: liveUploadId,
            companyId: 'c-1',
            attachedToType: 'article',
            deletedAt: null,
          },
          {
            id: historyOnlyUploadId,
            companyId: 'c-1',
            attachedToType: 'article',
            deletedAt: null,
          },
        ],
      });
      const svc = new ArticlesService(
         
        prisma as any,
         
        audit as any,
         
        stars as any,
         
        uploads as any,
         
        relations as any, { isAutoSummariesEnabled: async () => false } as never, { enqueueArticleSummary: async () => 'job-1' } as never);

      await svc.purge(actor(), 'c-1', 'art-1', meta());

      const live = uploadRows.find((u) => u.id === liveUploadId)!;
      const historyOnly = uploadRows.find((u) => u.id === historyOnlyUploadId)!;
      expect(live.deletedAt).toBeInstanceOf(Date);
      expect(historyOnly.deletedAt).toBeInstanceOf(Date);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'article.purge',
          before: expect.objectContaining({ softDeletedUploads: 2 }),
        }),
      );
    });
  });

  // ----------------------------------------------------------------
  // Versioning
  // ----------------------------------------------------------------

  describe('versioning', () => {
    function publishedRow(overrides: Partial<ArticleRow> = {}): ArticleRow {
      return {
        id: 'art-1',
        companyId: 'c-1',
        folderId: null,
        title: 'Original',
        slug: 'original',
        editorMode: 'tiptap',
        markdownSource: null,
        content: doc('original body') as unknown as Prisma.JsonValue,
        contentPlaintext: 'original body',
        excerpt: 'original body',
        derivedExcerpt: null,
        aiSummary: null,
        aiSummaryModel: null,
        aiSummaryAt: new Date(0),
        visibleToClients: true,
        createdAt: new Date('2024-01-01T00:00:00Z'),
        updatedAt: new Date('2024-01-01T00:00:00Z'),
        createdBy: 'u-1',
        updatedBy: 'u-1',
        revision: 1,
        archivedAt: null,
        ...overrides,
      };
    }

    function v1Row(overrides: Partial<ArticleVersionRow> = {}): ArticleVersionRow {
      return {
        id: 'av-seed',
        articleId: 'art-1',
        companyId: 'c-1',
        version: 1,
        isDraft: false,
        title: 'Original',
        slug: 'original',
        folderId: null,
        visibleToClients: true,
        editorMode: 'tiptap',
        content: doc('original body') as unknown as Prisma.JsonValue,
        markdownSource: null,
        contentPlaintext: 'original body',
        excerpt: 'original body',
        changedFields: ['title', 'content'],
        changedBy: 'u-1',
        changeReason: 'initial version',
        createdAt: new Date('2024-01-01T00:00:00Z'),
        updatedAt: new Date('2024-01-01T00:00:00Z'),
        ...overrides,
      };
    }

    function mkSvc(initial: Parameters<typeof makeStubs>[0] = {}) {
      const stubs = makeStubs(initial);
      const svc = new ArticlesService(
         
        stubs.prisma as any,
         
        stubs.audit as any,
         
        stubs.stars as any,
         
        stubs.uploads as any,
         
        stubs.relations as any, { isAutoSummariesEnabled: async () => false } as never, { enqueueArticleSummary: async () => 'job-1' } as never);
      return { svc, ...stubs };
    }

    it('create writes v1 published in the same tx as the article row', async () => {
      const { svc, versions, articles } = mkSvc();
      await svc.create(
        actor(),
        'c-1',
        { title: 'Brand new', content: doc('hi') } as never,
        meta(),
      );
      expect(articles).toHaveLength(1);
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({
        articleId: articles[0]!.id,
        version: 1,
        isDraft: false,
        changeReason: 'initial version',
      });
    });

    it('explicit Save with no existing draft inserts a new published v=2', async () => {
      const { svc, versions } = mkSvc({
        articles: [publishedRow()],
        versions: [v1Row()],
      });
      await svc.update(
        actor(),
        'c-1',
        'art-1',
        { title: 'Renamed' } as never,
        meta(),
      );
      const published = versions
        .filter((v) => !v.isDraft)
        .sort((a, b) => a.version - b.version);
      expect(published.map((v) => v.version)).toEqual([1, 2]);
      expect(published[1]).toMatchObject({
        title: 'Renamed',
        changedFields: ['title'],
      });
    });

    it('explicit Save with an existing draft promotes it in place (no new row)', async () => {
      const draft = v1Row({
        id: 'av-draft',
        version: 2,
        isDraft: true,
        changeReason: 'autosave draft',
        title: 'Renamed',
      });
      const { svc, versions } = mkSvc({
        articles: [publishedRow({ title: 'Renamed' })],
        versions: [v1Row(), draft],
      });
      await svc.update(
        actor(),
        'c-1',
        'art-1',
        { title: 'Renamed again' } as never,
        meta(),
      );
      const v2 = versions.find((v) => v.version === 2)!;
      expect(v2.isDraft).toBe(false);
      expect(v2.id).toBe('av-draft');
      expect(versions).toHaveLength(2);
    });

    it('explicit Save promotes an existing draft even when the body is unchanged (no-op)', async () => {
      // Autosave writes the live article row AND the draft row to the
      // same body, so a later explicit Save (manual, or the AI
      // chat-apply path) reports no changed fields. It must still
      // promote the draft — otherwise the article stays stuck on
      // "draft in progress" forever.
      const draft = v1Row({
        id: 'av-draft',
        version: 2,
        isDraft: true,
        changeReason: 'autosave draft',
        changedFields: ['title'],
      });
      const { svc, versions } = mkSvc({
        articles: [publishedRow({ title: 'Original' })],
        versions: [v1Row(), draft],
      });
      const out = await svc.update(
        actor(),
        'c-1',
        'art-1',
        { title: 'Original' } as never, // same as the live row → no field change
        meta(),
      );
      expect(versions.filter((v) => v.isDraft)).toHaveLength(0);
      expect(out.hasDraft).toBe(false);
      const v2 = versions.find((v) => v.version === 2)!;
      expect(v2.id).toBe('av-draft');
      expect(v2.isDraft).toBe(false);
      expect(versions).toHaveLength(2);
    });

    it('autosave with no existing draft creates a new draft at v=2', async () => {
      const { svc, versions } = mkSvc({
        articles: [publishedRow()],
        versions: [v1Row()],
      });
      await svc.update(
        actor(),
        'c-1',
        'art-1',
        { title: 'Drafted', draft: true } as never,
        meta(),
      );
      const drafts = versions.filter((v) => v.isDraft);
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({
        version: 2,
        isDraft: true,
        changeReason: 'autosave draft',
        title: 'Drafted',
      });
    });

    it('autosave with an existing draft coalesces in place (same id, same version)', async () => {
      const draft = v1Row({
        id: 'av-draft',
        version: 2,
        isDraft: true,
        changeReason: 'autosave draft',
        changedFields: ['title'],
      });
      const { svc, versions } = mkSvc({
        articles: [publishedRow()],
        versions: [v1Row(), draft],
      });
      await svc.update(
        actor(),
        'c-1',
        'art-1',
        { title: 'Latest title', draft: true } as never,
        meta(),
      );
      const drafts = versions.filter((v) => v.isDraft);
      expect(drafts).toHaveLength(1);
      expect(drafts[0]!.id).toBe('av-draft');
      expect(drafts[0]!.version).toBe(2);
      expect(drafts[0]!.title).toBe('Latest title');
      // Unioned changedFields keeps the original 'title' plus any new
      // entries — the second autosave didn't touch a new field so the
      // set should still be ['title'].
      expect(drafts[0]!.changedFields).toContain('title');
    });

    it('autosave no-op (no field change) does not create a draft row', async () => {
      const { svc, versions } = mkSvc({
        articles: [publishedRow()],
        versions: [v1Row()],
      });
      // PATCH the same title back — `computeChangedFields` returns
      // empty, so the version layer should skip entirely.
      await svc.update(
        actor(),
        'c-1',
        'art-1',
        { title: 'Original', draft: true } as never,
        meta(),
      );
      expect(versions.filter((v) => v.isDraft)).toHaveLength(0);
      expect(versions).toHaveLength(1);
    });

    it('discardDraft deletes the draft and reverts the article row to the last published body', async () => {
      const draft = v1Row({
        id: 'av-draft',
        version: 2,
        isDraft: true,
        changeReason: 'autosave draft',
        title: 'Drafted',
        slug: 'drafted',
      });
      // Autosave maintained the live row's derived excerpt from the
      // DRAFT body — the revert must recompute it from the published
      // version, not carry the draft text forward into lists.
      const articleRow = publishedRow({
        title: 'Drafted',
        slug: 'drafted',
        derivedExcerpt: 'secret draft text',
      });
      const { svc, versions, articles, audit } = mkSvc({
        articles: [articleRow],
        versions: [v1Row(), draft],
      });
      const result = await svc.discardDraft(actor(), 'c-1', 'art-1', meta());
      expect(result.title).toBe('Original');
      expect(articles[0]!.title).toBe('Original');
      expect(articles[0]!.derivedExcerpt).toBe('original body');
      expect(versions.find((v) => v.isDraft)).toBeUndefined();
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'article.draft.discard',
          after: { discardedVersion: 2 },
        }),
      );
    });

    it('discardDraft is a no-op (and not an error) when no draft exists', async () => {
      const { svc, audit, versions } = mkSvc({
        articles: [publishedRow()],
        versions: [v1Row()],
      });
      await svc.discardDraft(actor(), 'c-1', 'art-1', meta());
      expect(audit.log).not.toHaveBeenCalled();
      expect(versions).toHaveLength(1);
    });

    it('discardDraft refuses on an archived article', async () => {
      const { svc } = mkSvc({
        articles: [publishedRow({ archivedAt: new Date() })],
        versions: [v1Row()],
      });
      await expect(
        svc.discardDraft(actor(), 'c-1', 'art-1', meta()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('archive auto-discards any in-progress draft inside the same tx', async () => {
      const draft = v1Row({
        id: 'av-draft',
        version: 2,
        isDraft: true,
        title: 'Drafted',
      });
      const { svc, versions, audit, articles } = mkSvc({
        articles: [
          publishedRow({ title: 'Drafted', derivedExcerpt: 'secret draft text' }),
        ],
        versions: [v1Row(), draft],
      });
      const archived = await svc.archive(actor(), 'c-1', 'art-1', meta());
      expect(archived.archivedAt).toBeInstanceOf(Date);
      // Draft gone, v1 still present, live article body reverted — the
      // derived excerpt included (same recompute as discardDraft).
      expect(versions.find((v) => v.isDraft)).toBeUndefined();
      expect(versions.find((v) => v.version === 1 && !v.isDraft)).toBeDefined();
      expect(articles[0]!.title).toBe('Original');
      expect(articles[0]!.derivedExcerpt).toBe('original body');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'article.archive',
          after: expect.objectContaining({ discardedDraftVersion: 2 }),
        }),
      );
    });

    it('purge cascades version rows (in-memory: clears them on article delete) and records versionCount', async () => {
      const { svc, audit, articles, versions } = mkSvc({
        articles: [publishedRow({ archivedAt: new Date() })],
        versions: [v1Row(), v1Row({ id: 'av-2', version: 2 })],
      });
      // Real Postgres handles the FK cascade; our in-memory stub
      // doesn't, so we clear it manually after the call to keep the
      // "after purge, no orphaned versions" invariant visible.
      await svc.purge(actor(), 'c-1', 'art-1', meta());
      versions.length = 0; // simulate FK cascade
      expect(articles).toHaveLength(0);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'article.purge',
          before: expect.objectContaining({ versionCount: 2 }),
          after: null,
        }),
      );
    });

    it('restoreVersion writes a new published row (forward-only history)', async () => {
      const v2 = v1Row({
        id: 'av-2',
        version: 2,
        title: 'Renamed v2',
        slug: 'renamed-v2',
        changedFields: ['title', 'slug'],
        changeReason: null,
      });
      const articleRow = publishedRow({
        title: 'Current',
        slug: 'current',
      });
      const { svc, versions, audit } = mkSvc({
        articles: [articleRow],
        versions: [v1Row(), v2],
      });
      await svc.restoreVersion(actor(), 'c-1', 'art-1', 1, meta());
      const published = versions.filter((v) => !v.isDraft);
      expect(published.map((v) => v.version)).toEqual([1, 2, 3]);
      expect(published[2]).toMatchObject({ title: 'Original' });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'article.version.restored',
          after: { restoredFromVersion: 1 },
        }),
      );
    });

    it('restoreVersion 404s on an unknown version', async () => {
      const { svc } = mkSvc({
        articles: [publishedRow()],
        versions: [v1Row()],
      });
      await expect(
        svc.restoreVersion(actor(), 'c-1', 'art-1', 999, meta()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('restoreVersion refuses on an archived article', async () => {
      const { svc } = mkSvc({
        articles: [publishedRow({ archivedAt: new Date() })],
        versions: [v1Row()],
      });
      await expect(
        svc.restoreVersion(actor(), 'c-1', 'art-1', 1, meta()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('listVersions excludes drafts and orders newest-first', async () => {
      const { svc } = mkSvc({
        articles: [publishedRow()],
        versions: [
          v1Row(),
          v1Row({ id: 'av-2', version: 2 }),
          v1Row({ id: 'av-3', version: 3, isDraft: true, changeReason: 'autosave draft' }),
        ],
      });
      const list = await svc.listVersions(actor(), 'c-1', 'art-1');
      expect(list.map((v) => v.version)).toEqual([2, 1]);
      expect(list.every((v) => !v.isDraft)).toBe(true);
    });

    it('listVersions returns NotFound for CLIENT_USER on a hidden article', async () => {
      const { svc } = mkSvc({
        articles: [publishedRow({ visibleToClients: false })],
        versions: [v1Row()],
      });
      await expect(
        svc.listVersions(actor({ role: 'CLIENT_USER' }), 'c-1', 'art-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getVersion returns 404 for a draft version number', async () => {
      const { svc } = mkSvc({
        articles: [publishedRow()],
        versions: [
          v1Row(),
          v1Row({ id: 'av-draft', version: 2, isDraft: true, changeReason: 'autosave draft' }),
        ],
      });
      await expect(
        svc.getVersion(actor(), 'c-1', 'art-1', 2),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    // WS-002: version-level visibility must gate client access, not just
    // the article's current flag. An article that is visible now can have
    // historical versions that were internal when written.
    describe('WS-002 version-level visibility for client users', () => {
      // current-visible / history-hidden: the client may read the article
      // and its visible versions, but hidden historical versions must not
      // appear in the list or be fetchable by version number.
      it('listVersions hides history-hidden versions of a now-visible article from CLIENT_USER', async () => {
        const { svc } = mkSvc({
          articles: [publishedRow({ visibleToClients: true })],
          versions: [
            v1Row({ id: 'av-1', version: 1, visibleToClients: false }),
            v1Row({ id: 'av-2', version: 2, visibleToClients: true }),
          ],
        });
        const list = await svc.listVersions(
          actor({ role: 'CLIENT_USER' }),
          'c-1',
          'art-1',
        );
        expect(list.map((v) => v.version)).toEqual([2]);
      });

      it('getVersion 404s a history-hidden version of a now-visible article for CLIENT_USER', async () => {
        const { svc } = mkSvc({
          articles: [publishedRow({ visibleToClients: true })],
          versions: [
            v1Row({ id: 'av-1', version: 1, visibleToClients: false }),
            v1Row({ id: 'av-2', version: 2, visibleToClients: true }),
          ],
        });
        await expect(
          svc.getVersion(actor({ role: 'CLIENT_USER' }), 'c-1', 'art-1', 1),
        ).rejects.toBeInstanceOf(NotFoundException);
        // The client-visible version is still reachable.
        const v2 = await svc.getVersion(
          actor({ role: 'CLIENT_USER' }),
          'c-1',
          'art-1',
          2,
        );
        expect(v2.version).toBe(2);
      });

      // current-hidden / history-visible: the article is now private, so
      // the whole history (even formerly-visible versions) is off-limits.
      it('listVersions 404s a now-hidden article for CLIENT_USER even with visible history', async () => {
        const { svc } = mkSvc({
          articles: [publishedRow({ visibleToClients: false })],
          versions: [v1Row({ id: 'av-1', version: 1, visibleToClients: true })],
        });
        await expect(
          svc.listVersions(actor({ role: 'CLIENT_USER' }), 'c-1', 'art-1'),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('getVersion 404s a now-hidden article for CLIENT_USER even for a formerly-visible version', async () => {
        const { svc } = mkSvc({
          articles: [publishedRow({ visibleToClients: false })],
          versions: [v1Row({ id: 'av-1', version: 1, visibleToClients: true })],
        });
        await expect(
          svc.getVersion(actor({ role: 'CLIENT_USER' }), 'c-1', 'art-1', 1),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      // Operators/admins are unaffected: full history regardless of the
      // per-version visibility snapshot.
      it('listVersions returns history-hidden versions to non-client actors', async () => {
        const { svc } = mkSvc({
          articles: [publishedRow({ visibleToClients: true })],
          versions: [
            v1Row({ id: 'av-1', version: 1, visibleToClients: false }),
            v1Row({ id: 'av-2', version: 2, visibleToClients: true }),
          ],
        });
        const list = await svc.listVersions(actor(), 'c-1', 'art-1');
        expect(list.map((v) => v.version)).toEqual([2, 1]);
      });

      it('getVersion returns a history-hidden version to non-client actors', async () => {
        const { svc } = mkSvc({
          articles: [publishedRow({ visibleToClients: true })],
          versions: [v1Row({ id: 'av-1', version: 1, visibleToClients: false })],
        });
        const v1 = await svc.getVersion(actor(), 'c-1', 'art-1', 1);
        expect(v1.version).toBe(1);
        expect(v1.visibleToClients).toBe(false);
      });
    });
  });
});

describe('AI summary lifecycle (Phase 4)', () => {
  function harness(gateOn: boolean) {
    const stubs = makeStubs();
    const gate = {
      isAutoSummariesEnabled: jest.fn().mockResolvedValue(gateOn),
    };
    const queues = {
      enqueueArticleSummary: jest.fn().mockResolvedValue('job-1'),
    };
    const svc = new ArticlesService(
      stubs.prisma as never,
      stubs.audit as never,
      stubs.stars as never,
      stubs.uploads as never,
      stubs.relations as never,
      gate as never,
      queues as never,
    );
    return { ...stubs, gate, queues, svc };
  }

  function seedRow(articles: unknown[], over: Record<string, unknown> = {}) {
    const row = {
      id: 'art-1',
      companyId: 'c-1',
      folderId: null,
      title: 'Runbook',
      slug: 'runbook',
      editorMode: 'markdown',
      markdownSource: '# Runbook\n\nSteps here.',
      content: null,
      contentPlaintext: 'Runbook Steps here.',
      excerpt: null,
      derivedExcerpt: 'Runbook Steps here.',
      aiSummary: 'Old summary',
      aiSummaryModel: 'm-1',
      aiSummaryAt: new Date('2026-07-01T00:00:00Z'),
      visibleToClients: true,
      createdAt: new Date('2026-06-01T00:00:00Z'),
      updatedAt: new Date('2026-06-01T00:00:00Z'),
      createdBy: 'u-1',
      updatedBy: 'u-1',
      revision: 3,
      archivedAt: null,
    };
    Object.assign(row, over);
    (articles as Record<string, unknown>[]).push(row);
    return row;
  }

  it('gate ON: title-only edit clears the summary, stamps PENDING, and enqueues post-commit with the new revision', async () => {
    const { svc, articles, gate, queues } = harness(true);
    const row = seedRow(articles);

    await svc.update(actor(), 'c-1', row.id, { title: 'Renamed' } as never, meta());

    expect(row.aiSummary).toBeNull();
    expect(row.aiSummaryModel).toBeNull();
    expect(row.aiSummaryAt).toBeNull();
    expect(row.revision).toBe(4);
    expect(gate.isAutoSummariesEnabled).toHaveBeenCalledTimes(1);
    expect(queues.enqueueArticleSummary).toHaveBeenCalledWith({
      kind: 'generate',
      articleId: row.id,
      companyId: 'c-1',
      revision: 4,
    });
  });

  it('gate OFF: the edit stamps SETTLED (never pending) and enqueues nothing — no backlog accrues while disabled', async () => {
    const { svc, articles, queues } = harness(false);
    const row = seedRow(articles);

    await svc.update(actor(), 'c-1', row.id, { title: 'Renamed' } as never, meta());

    expect(row.aiSummary).toBeNull();
    expect(row.aiSummaryAt).toBeInstanceOf(Date);
    expect(queues.enqueueArticleSummary).not.toHaveBeenCalled();
  });

  it('enqueue uses only the captured in-transaction decision — a gate flip after the write cannot enqueue a settled row', async () => {
    const { svc, articles, gate, queues } = harness(false);
    const row = seedRow(articles);
    // The write's single read sees OFF; every read after it sees ON. A
    // post-commit re-read would then enqueue a row the write just
    // stamped settled; the captured decision must not.
    gate.isAutoSummariesEnabled
      .mockReset()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    await svc.update(actor(), 'c-1', row.id, { title: 'Renamed' } as never, meta());

    expect(gate.isAutoSummariesEnabled).toHaveBeenCalledTimes(1);
    expect(row.aiSummaryAt).toBeInstanceOf(Date);
    expect(queues.enqueueArticleSummary).not.toHaveBeenCalled();
  });

  it('autosave drafts touch no AI column and never consult the gate', async () => {
    const { svc, articles, gate, queues } = harness(true);
    const row = seedRow(articles);

    await svc.update(
      actor(),
      'c-1',
      row.id,
      { editorMode: 'markdown', markdownSource: '# Draft body', draft: true } as never,
      meta(),
    );

    expect(row.aiSummary).toBe('Old summary');
    expect(row.aiSummaryAt).toEqual(new Date('2026-07-01T00:00:00Z'));
    expect(gate.isAutoSummariesEnabled).not.toHaveBeenCalled();
    expect(queues.enqueueArticleSummary).not.toHaveBeenCalled();
  });

  it('explicit-excerpt-only update touches no AI column (legacy column is unserved; body unchanged)', async () => {
    const { svc, articles, queues } = harness(true);
    const row = seedRow(articles);

    await svc.update(actor(), 'c-1', row.id, { excerpt: 'Authored' } as never, meta());

    expect(row.excerpt).toBe('Authored');
    expect(row.aiSummary).toBe('Old summary');
    expect(row.aiSummaryAt).toEqual(new Date('2026-07-01T00:00:00Z'));
    expect(queues.enqueueArticleSummary).not.toHaveBeenCalled();
  });

  it('a throwing queue never fails the save (sweep reconciles)', async () => {
    const { svc, articles, queues } = harness(true);
    const row = seedRow(articles);
    queues.enqueueArticleSummary.mockRejectedValue(new Error('redis down'));

    const out = await svc.update(
      actor(),
      'c-1',
      row.id,
      { title: 'Renamed' } as never,
      meta(),
    );

    expect(out.title).toBe('Renamed');
    // Cleared + pending — exactly the state the sweep drains.
    expect(row.aiSummaryAt).toBeNull();
  });

  it('create with gate ON stamps pending and enqueues revision 1; gate OFF stamps settled', async () => {
    const on = harness(true);
    const created = await on.svc.create(
      actor(),
      'c-1',
      { title: 'New', editorMode: 'markdown', markdownSource: '# Body' } as never,
      meta(),
    );
    const onRow = (on.articles as Array<Record<string, unknown>>).find(
      (a) => a.id === created.id,
    )!;
    expect(onRow.aiSummaryAt).toBeNull();
    expect(on.queues.enqueueArticleSummary).toHaveBeenCalledWith({
      kind: 'generate',
      articleId: created.id,
      companyId: 'c-1',
      revision: 1,
    });

    const off = harness(false);
    const created2 = await off.svc.create(
      actor(),
      'c-1',
      { title: 'New', editorMode: 'markdown', markdownSource: '# Body' } as never,
      meta(),
    );
    const offRow = (off.articles as Array<Record<string, unknown>>).find(
      (a) => a.id === created2.id,
    )!;
    expect(offRow.aiSummaryAt).toBeInstanceOf(Date);
    expect(off.queues.enqueueArticleSummary).not.toHaveBeenCalled();
  });

  it('body writes maintain derivedExcerpt machine-only (the caller excerpt never leaks into it)', async () => {
    const { svc, articles } = harness(false);
    const row = seedRow(articles, { derivedExcerpt: 'stale' });

    await svc.update(
      actor(),
      'c-1',
      row.id,
      {
        editorMode: 'markdown',
        markdownSource: '# Fresh body\n\nNew steps.',
        excerpt: 'Authored override',
      } as never,
      meta(),
    );

    expect(row.excerpt).toBe('Authored override');
    expect(row.derivedExcerpt).toContain('New steps');
    expect(row.derivedExcerpt).not.toContain('Authored');
  });

  it('list serves aiSummary ?? derivedExcerpt and no body fields', async () => {
    const { svc, articles } = harness(false);
    seedRow(articles, { id: 'art-a', slug: 'a', title: 'A', aiSummary: 'AI wins' });
    seedRow(articles, {
      id: 'art-b',
      slug: 'b',
      title: 'B',
      aiSummary: null,
      derivedExcerpt: 'Derived fallback',
    });

    const { items } = await svc.list(actor(), 'c-1');
    const a = items.find((i) => i.id === 'art-a')!;
    const b = items.find((i) => i.id === 'art-b')!;
    expect(a.excerpt).toBe('AI wins');
    expect(b.excerpt).toBe('Derived fallback');
    for (const item of items) {
      expect(item).not.toHaveProperty('content');
      expect(item).not.toHaveProperty('markdownSource');
      expect(item).not.toHaveProperty('contentPlaintext');
    }
  });

  it('detail serves the coalesce too — one rule on every read path', async () => {
    const { svc, articles } = harness(false);
    const row = seedRow(articles, { aiSummary: 'AI summary' });
    const out = await svc.getById(actor(), 'c-1', row.id);
    expect(out.excerpt).toBe('AI summary');
  });
});

describe('AI summary lifecycle — integration writer (Phase 4)', () => {
  // The integration path stamps gate-aware but NEVER enqueues inline —
  // it can run inside the sync runner's long page transaction where a
  // delayed job could execute pre-commit; pending rows belong to the
  // sweep.
  function harness(gateOn: boolean) {
    const stubs = makeStubs();
    // The integration write path uses the tx-scoped audit writer and
    // the integration-actor assertion, which the shared stub omits.
    Object.assign(stubs.audit as object, {
      assertIntegrationActor: jest.fn().mockResolvedValue(undefined),
      logWithClient: jest.fn().mockResolvedValue(undefined),
    });
    const gate = { isAutoSummariesEnabled: jest.fn().mockResolvedValue(gateOn) };
    const queues = { enqueueArticleSummary: jest.fn().mockResolvedValue('job-1') };
    const svc = new ArticlesService(
      stubs.prisma as never,
      stubs.audit as never,
      stubs.stars as never,
      stubs.uploads as never,
      stubs.relations as never,
      gate as never,
      queues as never,
    );
    return { ...stubs, gate, queues, svc };
  }

  const writeInput = {
    companyId: 'c-1',
    integrationId: 'int-1',
    integrationCompanyMappingId: 'map-1',
    resourceId: 'res-1',
    externalId: 'ext-1',
    auditActorId: 'a0000000-0000-4000-8000-0000000000a9',
    dryRun: false,
    title: 'Synced doc',
    slug: 'synced-doc',
    folderId: null,
    markdown: '# Synced\n\nBody.',
    visibleToClients: true,
  };

  it('gate ON: created row is PENDING with zero inline enqueues', async () => {
    const { svc, articles, queues } = harness(true);

    const result = await svc.writeFromIntegration(writeInput as never);
    expect(result.change).toBe('created');
    const row = (articles as Array<Record<string, unknown>>).find(
      (a) => a.id === result.targetId,
    )!;
    expect(row.aiSummaryAt).toBeNull();
    expect(queues.enqueueArticleSummary).not.toHaveBeenCalled();
  });

  it('gate OFF: created row is SETTLED — a disabled install accrues no backlog from nightly syncs', async () => {
    const { svc, articles, queues } = harness(false);

    const result = await svc.writeFromIntegration(writeInput as never);
    expect(result.change).toBe('created');
    const row = (articles as Array<Record<string, unknown>>).find(
      (a) => a.id === result.targetId,
    )!;
    expect(row.aiSummaryAt).toBeInstanceOf(Date);
    expect(queues.enqueueArticleSummary).not.toHaveBeenCalled();
  });
});
