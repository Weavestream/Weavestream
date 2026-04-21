import { BadRequestException } from '@nestjs/common';
import { RelationsService } from './relations.service.js';
import type { UserRole } from '@weavestream/shared';

/**
 * Phase 5 tests for the read-side of RelationsService: `listRelated`,
 * `listRelationTypes`, `deleteById`, and the endpoint-company guard.
 *
 * These use in-memory fakes rather than a real Prisma client so the spec
 * can run alongside the Phase-3 unit tests without Postgres. The fakes
 * mirror only the narrow surface the service actually hits — expand as
 * new methods get added.
 */

interface RelationRow {
  id: string;
  companyId: string;
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  relationType: string;
  createdBy: string | null;
  createdAt: Date;
}

interface AssetRow {
  id: string;
  companyId: string;
  name: string;
  archivedAt: Date | null;
  assetLayout: { name: string; icon: string | null; color: string | null } | null;
}

interface ArticleRow {
  id: string;
  companyId: string;
  title: string;
  excerpt: string | null;
  archivedAt: Date | null;
  visibleToClients: boolean;
}

function makePrisma(fixtures: {
  relations: RelationRow[];
  assets: AssetRow[];
  articles: ArticleRow[];
}) {
  const state = {
    relations: [...fixtures.relations],
    assets: [...fixtures.assets],
    articles: [...fixtures.articles],
  };

  function matchOrClause(r: RelationRow, or: Array<Record<string, unknown>>): boolean {
    return or.some((clause) =>
      Object.entries(clause).every(
        ([k, v]) => (r as unknown as Record<string, unknown>)[k] === v,
      ),
    );
  }

  return {
    relation: {
      async findMany(args: {
        where: Record<string, unknown>;
        orderBy?: unknown;
        select?: { relationType?: boolean };
        distinct?: string[];
        take?: number;
      }) {
        const w = args.where;
        let rows = state.relations.filter((r) => {
          if (w['companyId'] && r.companyId !== w['companyId']) return false;
          if (Array.isArray(w['OR']) && !matchOrClause(r, w['OR'] as Array<Record<string, unknown>>)) {
            return false;
          }
          const rt = w['relationType'] as { contains?: string } | string | undefined;
          if (typeof rt === 'string' && r.relationType !== rt) return false;
          if (rt && typeof rt === 'object' && rt.contains) {
            if (!r.relationType.toLowerCase().includes(rt.contains.toLowerCase())) return false;
          }
          return true;
        });
        // Newest first for createdAt desc.
        rows = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        if (args.select?.relationType && args.distinct) {
          const seen = new Set<string>();
          const out: { relationType: string }[] = [];
          for (const r of rows) {
            if (seen.has(r.relationType)) continue;
            seen.add(r.relationType);
            out.push({ relationType: r.relationType });
          }
          out.sort((a, b) => a.relationType.localeCompare(b.relationType));
          return args.take ? out.slice(0, args.take) : out;
        }
        return args.take ? rows.slice(0, args.take) : rows;
      },
      async findFirst(args: { where: Record<string, unknown>; select?: unknown }) {
        const w = args.where;
        return (
          state.relations.find((r) => {
            for (const [k, v] of Object.entries(w)) {
              if (v === undefined) continue;
              if ((r as unknown as Record<string, unknown>)[k] !== v) return false;
            }
            return true;
          }) ?? null
        );
      },
      async deleteMany(args: { where: Record<string, unknown> }) {
        const before = state.relations.length;
        state.relations = state.relations.filter((r) => {
          for (const [k, v] of Object.entries(args.where)) {
            if ((r as unknown as Record<string, unknown>)[k] !== v) return true;
          }
          return false;
        });
        return { count: before - state.relations.length };
      },
    },
    asset: {
      async findMany(args: { where: Record<string, unknown> }) {
        const w = args.where;
        return state.assets.filter((a) => {
          if (w['companyId'] && a.companyId !== w['companyId']) return false;
          const ids = (w['id'] as { in: string[] } | undefined)?.in;
          if (ids && !ids.includes(a.id)) return false;
          if (w['archivedAt'] === null && a.archivedAt !== null) return false;
          return true;
        });
      },
      async findFirst(args: { where: Record<string, unknown> }) {
        const w = args.where;
        return (
          state.assets.find((a) => {
            if (w['id'] && a.id !== w['id']) return false;
            if (w['companyId'] && a.companyId !== w['companyId']) return false;
            if (w['archivedAt'] === null && a.archivedAt !== null) return false;
            return true;
          }) ?? null
        );
      },
    },
    article: {
      async findMany(args: { where: Record<string, unknown> }) {
        const w = args.where;
        return state.articles.filter((a) => {
          if (w['companyId'] && a.companyId !== w['companyId']) return false;
          const ids = (w['id'] as { in: string[] } | undefined)?.in;
          if (ids && !ids.includes(a.id)) return false;
          if (w['archivedAt'] === null && a.archivedAt !== null) return false;
          if (w['visibleToClients'] === true && !a.visibleToClients) return false;
          return true;
        });
      },
      async findFirst(args: { where: Record<string, unknown> }) {
        const w = args.where;
        return (
          state.articles.find((a) => {
            if (w['id'] && a.id !== w['id']) return false;
            if (w['companyId'] && a.companyId !== w['companyId']) return false;
            if (w['archivedAt'] === null && a.archivedAt !== null) return false;
            return true;
          }) ?? null
        );
      },
    },
    __state: state,
  };
}

function asset(partial: Partial<AssetRow> & { id: string; companyId: string; name: string }): AssetRow {
  return {
    archivedAt: null,
    assetLayout: { name: 'Workstation', icon: 'laptop', color: '#38bdf8' },
    ...partial,
  };
}

function article(
  partial: Partial<ArticleRow> & { id: string; companyId: string; title: string },
): ArticleRow {
  return {
    excerpt: null,
    archivedAt: null,
    visibleToClients: true,
    ...partial,
  };
}

function relation(
  partial: Partial<RelationRow> & {
    id: string;
    companyId: string;
    sourceType: string;
    sourceId: string;
    targetType: string;
    targetId: string;
  },
): RelationRow {
  return {
    relationType: 'manual',
    createdBy: null,
    createdAt: new Date(),
    ...partial,
  };
}

function actor(role: UserRole = 'OPERATOR') {
  return { id: 'u-1', role };
}

describe('RelationsService.listRelated', () => {
  it('hydrates asset + article counterparts and groups them by kind', async () => {
    const prisma = makePrisma({
      relations: [
        relation({
          id: 'r-1',
          companyId: 'c-1',
          sourceType: 'Asset',
          sourceId: 'asset-root',
          targetType: 'Asset',
          targetId: 'asset-b',
          relationType: 'depends_on',
          createdAt: new Date('2026-01-01'),
        }),
        relation({
          id: 'r-2',
          companyId: 'c-1',
          sourceType: 'Article',
          sourceId: 'article-x',
          targetType: 'Asset',
          targetId: 'asset-root',
          relationType: 'manual',
          createdAt: new Date('2026-01-02'),
        }),
      ],
      assets: [
        asset({ id: 'asset-root', companyId: 'c-1', name: 'Root server' }),
        asset({ id: 'asset-b', companyId: 'c-1', name: 'DB server' }),
      ],
      articles: [
        article({ id: 'article-x', companyId: 'c-1', title: 'Runbook', excerpt: 'Steps' }),
      ],
    });
    const svc = new RelationsService(prisma as never);
    const res = await svc.listRelated({
      actor: actor(),
      companyId: 'c-1',
      entityType: 'asset',
      entityId: 'asset-root',
    });
    expect(res.totalCount).toBe(2);
    expect(res.groups.asset.map((i) => i.id)).toEqual(['asset-b']);
    expect(res.groups.article.map((i) => i.id)).toEqual(['article-x']);
    expect(res.groups.asset[0]!.direction).toBe('outgoing');
    expect(res.groups.article[0]!.direction).toBe('incoming');
    expect(res.groups.article[0]!.isFieldManaged).toBe(false); // relationType = manual
    expect(res.groups.asset[0]!.isFieldManaged).toBe(true); // relationType = depends_on
  });

  it('drops counterparts that are archived', async () => {
    const prisma = makePrisma({
      relations: [
        relation({
          id: 'r-1',
          companyId: 'c-1',
          sourceType: 'Asset',
          sourceId: 'asset-root',
          targetType: 'Asset',
          targetId: 'asset-archived',
        }),
      ],
      assets: [
        asset({ id: 'asset-root', companyId: 'c-1', name: 'Root server' }),
        asset({
          id: 'asset-archived',
          companyId: 'c-1',
          name: 'Old server',
          archivedAt: new Date('2025-01-01'),
        }),
      ],
      articles: [],
    });
    const svc = new RelationsService(prisma as never);
    const res = await svc.listRelated({
      actor: actor(),
      companyId: 'c-1',
      entityType: 'asset',
      entityId: 'asset-root',
    });
    expect(res.totalCount).toBe(0);
  });

  it('hides articles that are not visible to clients when actor is CLIENT_USER', async () => {
    const prisma = makePrisma({
      relations: [
        relation({
          id: 'r-1',
          companyId: 'c-1',
          sourceType: 'Asset',
          sourceId: 'asset-root',
          targetType: 'Article',
          targetId: 'article-public',
        }),
        relation({
          id: 'r-2',
          companyId: 'c-1',
          sourceType: 'Asset',
          sourceId: 'asset-root',
          targetType: 'Article',
          targetId: 'article-internal',
        }),
      ],
      assets: [asset({ id: 'asset-root', companyId: 'c-1', name: 'Root' })],
      articles: [
        article({
          id: 'article-public',
          companyId: 'c-1',
          title: 'Public runbook',
          visibleToClients: true,
        }),
        article({
          id: 'article-internal',
          companyId: 'c-1',
          title: 'Internal runbook',
          visibleToClients: false,
        }),
      ],
    });
    const svc = new RelationsService(prisma as never);
    const client = await svc.listRelated({
      actor: actor('CLIENT_USER'),
      companyId: 'c-1',
      entityType: 'asset',
      entityId: 'asset-root',
    });
    expect(client.groups.article.map((i) => i.id)).toEqual(['article-public']);

    const op = await svc.listRelated({
      actor: actor('OPERATOR'),
      companyId: 'c-1',
      entityType: 'asset',
      entityId: 'asset-root',
    });
    expect(op.groups.article.map((i) => i.id).sort()).toEqual([
      'article-internal',
      'article-public',
    ]);
  });

  it('never leaks counterparts from other companies', async () => {
    const prisma = makePrisma({
      relations: [
        relation({
          id: 'r-own',
          companyId: 'c-1',
          sourceType: 'Asset',
          sourceId: 'asset-root',
          targetType: 'Asset',
          targetId: 'asset-ok',
        }),
        relation({
          id: 'r-other',
          companyId: 'c-2',
          sourceType: 'Asset',
          sourceId: 'asset-root',
          targetType: 'Asset',
          targetId: 'asset-other',
        }),
      ],
      assets: [
        asset({ id: 'asset-root', companyId: 'c-1', name: 'Root' }),
        asset({ id: 'asset-ok', companyId: 'c-1', name: 'OK' }),
        asset({ id: 'asset-other', companyId: 'c-2', name: 'Other-co' }),
      ],
      articles: [],
    });
    const svc = new RelationsService(prisma as never);
    const res = await svc.listRelated({
      actor: actor(),
      companyId: 'c-1',
      entityType: 'asset',
      entityId: 'asset-root',
    });
    expect(res.groups.asset.map((i) => i.id)).toEqual(['asset-ok']);
  });
});

describe('RelationsService.listRelationTypes', () => {
  it('returns distinct labels, filtered by q', async () => {
    const prisma = makePrisma({
      relations: [
        relation({
          id: 'r-1',
          companyId: 'c-1',
          sourceType: 'Asset',
          sourceId: 'a',
          targetType: 'Asset',
          targetId: 'b',
          relationType: 'primary_user',
        }),
        relation({
          id: 'r-2',
          companyId: 'c-1',
          sourceType: 'Asset',
          sourceId: 'a',
          targetType: 'Asset',
          targetId: 'c',
          relationType: 'primary_user',
        }),
        relation({
          id: 'r-3',
          companyId: 'c-1',
          sourceType: 'Asset',
          sourceId: 'a',
          targetType: 'Asset',
          targetId: 'd',
          relationType: 'depends_on',
        }),
      ],
      assets: [],
      articles: [],
    });
    const svc = new RelationsService(prisma as never);
    expect(await svc.listRelationTypes('c-1')).toEqual(['depends_on', 'primary_user']);
    expect(await svc.listRelationTypes('c-1', 'prim')).toEqual(['primary_user']);
  });
});

describe('RelationsService.deleteById', () => {
  it('deletes a row within the company and returns its key', async () => {
    const prisma = makePrisma({
      relations: [
        relation({
          id: 'r-1',
          companyId: 'c-1',
          sourceType: 'Asset',
          sourceId: 'a',
          targetType: 'Asset',
          targetId: 'b',
        }),
      ],
      assets: [],
      articles: [],
    });
    const svc = new RelationsService(prisma as never);
    const res = await svc.deleteById('c-1', 'r-1');
    expect(res?.sourceId).toBe('a');
    expect(prisma.__state.relations).toHaveLength(0);
  });

  it('returns null when the row belongs to another company', async () => {
    const prisma = makePrisma({
      relations: [
        relation({
          id: 'r-1',
          companyId: 'c-2',
          sourceType: 'Asset',
          sourceId: 'a',
          targetType: 'Asset',
          targetId: 'b',
        }),
      ],
      assets: [],
      articles: [],
    });
    const svc = new RelationsService(prisma as never);
    const res = await svc.deleteById('c-1', 'r-1');
    expect(res).toBeNull();
    expect(prisma.__state.relations).toHaveLength(1);
  });
});

describe('RelationsService.assertEndpointsInCompany', () => {
  it('rejects endpoints that live in another company', async () => {
    const prisma = makePrisma({
      relations: [],
      assets: [
        asset({ id: 'asset-ok', companyId: 'c-1', name: 'OK' }),
        asset({ id: 'asset-other', companyId: 'c-2', name: 'Other-co' }),
      ],
      articles: [article({ id: 'article-ok', companyId: 'c-1', title: 'ok' })],
    });
    const svc = new RelationsService(prisma as never);
    await expect(
      svc.assertEndpointsInCompany({
        companyId: 'c-1',
        sourceType: 'asset',
        sourceId: 'asset-ok',
        targetType: 'asset',
        targetId: 'asset-other',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // control: same-company pair succeeds.
    await expect(
      svc.assertEndpointsInCompany({
        companyId: 'c-1',
        sourceType: 'asset',
        sourceId: 'asset-ok',
        targetType: 'article',
        targetId: 'article-ok',
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects archived endpoints', async () => {
    const prisma = makePrisma({
      relations: [],
      assets: [
        asset({ id: 'asset-ok', companyId: 'c-1', name: 'OK' }),
        asset({
          id: 'asset-archived',
          companyId: 'c-1',
          name: 'Old',
          archivedAt: new Date('2025-01-01'),
        }),
      ],
      articles: [],
    });
    const svc = new RelationsService(prisma as never);
    await expect(
      svc.assertEndpointsInCompany({
        companyId: 'c-1',
        sourceType: 'asset',
        sourceId: 'asset-ok',
        targetType: 'asset',
        targetId: 'asset-archived',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
