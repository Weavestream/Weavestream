import { BadRequestException } from '@nestjs/common';
import { RelationsService } from './relations.service.js';

type Row = {
  companyId: string;
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  relationType: string;
  createdBy: string | null;
};

function makeStubPrisma(initial: Row[] = []) {
  let rows = [...initial];

  const relation = {
    async upsert(args: {
      where: {
        sourceType_sourceId_targetType_targetId_relationType: {
          sourceType: string;
          sourceId: string;
          targetType: string;
          targetId: string;
          relationType: string;
        };
      };
      create: Row;
    }) {
      const key = args.where.sourceType_sourceId_targetType_targetId_relationType;
      const existing = rows.find(
        (r) =>
          r.sourceType === key.sourceType &&
          r.sourceId === key.sourceId &&
          r.targetType === key.targetType &&
          r.targetId === key.targetId &&
          r.relationType === key.relationType,
      );
      if (existing) return existing;
      rows.push(args.create);
      return args.create;
    },
    async deleteMany(args: {
      where: Record<string, unknown>;
    }) {
      const w = args.where;
      const before = rows.length;
      rows = rows.filter((r) => {
        const notClause = (w['NOT'] ?? null) as { targetId?: { in?: string[] } } | null;
        const targetIdNotIn = notClause?.targetId?.in;
        if (w['companyId'] && r.companyId !== w['companyId']) return true;
        if (w['sourceType'] && r.sourceType !== w['sourceType']) return true;
        if (w['sourceId'] && r.sourceId !== w['sourceId']) return true;
        if (w['relationType'] && r.relationType !== w['relationType']) return true;
        if (w['targetType'] && r.targetType !== w['targetType']) return true;
        if (w['targetId'] && r.targetId !== w['targetId']) return true;
        if (Array.isArray(w['OR'])) {
          const or = w['OR'] as Array<Record<string, unknown>>;
          if (!or.some((clause) => matchesClause(r, clause))) return true;
        }
        if (targetIdNotIn && targetIdNotIn.includes(r.targetId)) {
          return true; // protected by NOT, don't delete
        }
        return false; // delete
      });
      return { count: before - rows.length };
    },
  };

  const asset = {
    async count(args: { where: { id: { in: string[] }; companyId: string } }) {
      const sameCompany = new Set(['a-1', 'a-2', 'a-3']);
      const ids = args.where.id.in;
      if (args.where.companyId !== 'c-1') return 0;
      return ids.filter((id) => sameCompany.has(id)).length;
    },
  };

  function matchesClause(r: Row, clause: Record<string, unknown>): boolean {
    for (const [k, v] of Object.entries(clause)) {
      if ((r as unknown as Record<string, unknown>)[k] !== v) return false;
    }
    return true;
  }

  return { relation, asset, rows: () => rows };
}

describe('RelationsService', () => {
  function makeService(initial: Row[] = []) {
    const stub = makeStubPrisma(initial);
    const svc = new RelationsService(stub as never);
    return { svc, stub, tx: stub as unknown as { relation: typeof stub.relation; asset: typeof stub.asset } };
  }

  it('link() persists Password targets with the right shape', async () => {
    const { svc, stub } = makeService();
    await svc.link({
      companyId: 'c-1',
      sourceType: 'Asset',
      sourceId: 'a-1',
      targetType: 'Password',
      targetId: 'pw-1',
      relationType: 'manual',
      actorId: 'u-1',
    });
    expect(stub.rows()).toHaveLength(1);
    expect(stub.rows()[0]).toMatchObject({
      sourceType: 'Asset',
      targetType: 'Password',
      targetId: 'pw-1',
      relationType: 'manual',
    });
  });

  it('link() is idempotent', async () => {
    const { svc, stub } = makeService();
    await svc.link({
      companyId: 'c-1',
      sourceType: 'Asset',
      sourceId: 'a-1',
      targetType: 'Asset',
      targetId: 'a-2',
      relationType: 'primary_user',
      actorId: 'u-1',
    });
    await svc.link({
      companyId: 'c-1',
      sourceType: 'Asset',
      sourceId: 'a-1',
      targetType: 'Asset',
      targetId: 'a-2',
      relationType: 'primary_user',
      actorId: 'u-1',
    });
    expect(stub.rows().length).toBe(1);
  });

  it('replaceForField upserts new rows and deletes dropped ones', async () => {
    const { svc, stub, tx } = makeService([
      {
        companyId: 'c-1',
        sourceType: 'Asset',
        sourceId: 'a-1',
        targetType: 'Asset',
        targetId: 'a-3',
        relationType: 'primary_user',
        createdBy: 'u-1',
      },
    ]);
    await svc.replaceForField({
      companyId: 'c-1',
      sourceType: 'Asset',
      sourceId: 'a-1',
      targetType: 'Asset',
      relationType: 'primary_user',
      targetIds: ['a-2'],
      actorId: 'u-1',
      tx: tx as never,
    });
    const now = stub.rows();
    expect(now).toHaveLength(1);
    expect(now[0]!.targetId).toBe('a-2');
  });

  it('replaceForField rejects cross-company targets', async () => {
    const { svc, tx } = makeService();
    await expect(
      svc.replaceForField({
        companyId: 'c-1',
        sourceType: 'Asset',
        sourceId: 'a-1',
        targetType: 'Asset',
        relationType: 'primary_user',
        targetIds: ['b-99'], // not in company c-1
        actorId: 'u-1',
        tx: tx as never,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('replaceForField with an empty targetIds list deletes all current rows', async () => {
    const { svc, stub, tx } = makeService([
      {
        companyId: 'c-1',
        sourceType: 'Asset',
        sourceId: 'a-1',
        targetType: 'Asset',
        targetId: 'a-3',
        relationType: 'primary_user',
        createdBy: 'u-1',
      },
    ]);
    await svc.replaceForField({
      companyId: 'c-1',
      sourceType: 'Asset',
      sourceId: 'a-1',
      targetType: 'Asset',
      relationType: 'primary_user',
      targetIds: [],
      actorId: 'u-1',
      tx: tx as never,
    });
    expect(stub.rows()).toHaveLength(0);
  });

  it('cleanupForAsset removes rows where the asset is on either side', async () => {
    const { svc, stub, tx } = makeService([
      {
        companyId: 'c-1',
        sourceType: 'Asset',
        sourceId: 'a-1',
        targetType: 'Asset',
        targetId: 'a-2',
        relationType: 'primary_user',
        createdBy: null,
      },
      {
        companyId: 'c-1',
        sourceType: 'Asset',
        sourceId: 'a-2',
        targetType: 'Asset',
        targetId: 'a-1',
        relationType: 'depends_on',
        createdBy: null,
      },
      {
        companyId: 'c-1',
        sourceType: 'Asset',
        sourceId: 'a-2',
        targetType: 'Asset',
        targetId: 'a-3',
        relationType: 'primary_user',
        createdBy: null,
      },
    ]);
    await svc.cleanupForAsset({
      companyId: 'c-1',
      assetId: 'a-1',
      tx: tx as never,
    });
    expect(stub.rows()).toHaveLength(1);
    expect(stub.rows()[0]!.sourceId).toBe('a-2');
    expect(stub.rows()[0]!.targetId).toBe('a-3');
  });
});
