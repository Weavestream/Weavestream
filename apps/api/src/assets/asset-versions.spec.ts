import { ConflictException } from '@nestjs/common';
import {
  ASSET_VERSION_CAP,
  buildAssetSnapshot,
  diffAssetSnapshots,
  enforceVersionCap,
  lockAndSnapshotAsset,
  projectVersionDetail,
  projectVersionSummary,
  reasonForClient,
  recordAssetVersion,
  restoreChangeReason,
  type AssetSnapshot,
} from './asset-versions.js';

const COMPANY = '11000000-0000-4000-8000-000000000001';
const ASSET = '11000000-0000-4000-8000-000000000002';
const F_HOST = '11000000-0000-4000-8000-0000000000a1';
const F_NOTE = '11000000-0000-4000-8000-0000000000a2';
const F_SECRETISH = '11000000-0000-4000-8000-0000000000a3';

function snap(over: Partial<AssetSnapshot> = {}): AssetSnapshot {
  return {
    name: 'Edge 01',
    externalId: null,
    externalSource: null,
    fieldValues: { [F_HOST]: 'edge-01' },
    ...over,
  };
}

describe('buildAssetSnapshot', () => {
  it('keys values by field id and drops null/undefined rows', () => {
    const s = buildAssetSnapshot(
      { name: 'A', externalId: 'x', externalSource: 'breeze' },
      [
        { assetFieldId: F_HOST, value: 'edge-01' },
        { assetFieldId: F_NOTE, value: null },
      ],
    );
    expect(s).toEqual({
      name: 'A',
      externalId: 'x',
      externalSource: 'breeze',
      fieldValues: { [F_HOST]: 'edge-01' },
    });
  });
});

describe('diffAssetSnapshots', () => {
  it('is empty when nothing changed, ignoring key order and empty-vs-absent', () => {
    const a = snap({ fieldValues: { [F_HOST]: { b: 1, a: [1, 2] }, [F_NOTE]: '' } });
    const b = snap({ fieldValues: { [F_HOST]: { a: [1, 2], b: 1 } } });
    expect(diffAssetSnapshots(a, b)).toEqual([]);
  });

  it('reports name, identity and field ids that changed, and only those', () => {
    const a = snap({ fieldValues: { [F_HOST]: 'a', [F_NOTE]: 'keep' } });
    const b = snap({
      name: 'Renamed',
      externalId: 'ext-1',
      fieldValues: { [F_HOST]: 'b', [F_NOTE]: 'keep', [F_SECRETISH]: 'new' },
    });
    expect(diffAssetSnapshots(a, b)).toEqual(['name', 'externalId', F_HOST, F_SECRETISH]);
  });

  it('treats a cleared field as a change', () => {
    expect(diffAssetSnapshots(snap(), snap({ fieldValues: {} }))).toEqual([F_HOST]);
  });
});

describe('recordAssetVersion', () => {
  function makeTx(opts: {
    max: number | null;
    asset?: Record<string, unknown>;
    rows?: unknown[];
    total?: number;
  }) {
    let max = opts.max;
    const tx = {
      asset: {
        findFirst: jest.fn().mockResolvedValue(
          opts.asset ?? { name: 'Edge 01', externalId: null, externalSource: null },
        ),
      },
      assetFieldValue: {
        findMany: jest
          .fn()
          .mockResolvedValue(opts.rows ?? [{ assetFieldId: F_HOST, value: 'edge-02' }]),
      },
      assetVersion: {
        aggregate: jest.fn().mockImplementation(async () => ({ _max: { version: max } })),
        createMany: jest.fn().mockImplementation(async () => {
          max = 1;
          return { count: 1 };
        }),
        create: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(opts.total ?? 3),
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    return tx;
  }

  const prev = { ...snap(), updatedAt: new Date('2026-01-01T00:00:00.000Z') };

  it('writes version 1 "initial version" on create, every query company-scoped', async () => {
    const tx = makeTx({ max: null });
    const out = await recordAssetVersion(tx as never, {
      companyId: COMPANY,
      assetId: ASSET,
      previous: null,
      changedBy: 'user-1',
    });
    expect(out?.version).toBe(1);
    expect(tx.assetVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        assetId: ASSET,
        companyId: COMPANY,
        version: 1,
        changedBy: 'user-1',
        changeReason: 'initial version',
        fieldValues: { [F_HOST]: 'edge-02' },
      }),
    });
    expect(tx.asset.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ASSET, companyId: COMPANY } }),
    );
    expect(tx.assetFieldValue.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { assetId: ASSET, companyId: COMPANY } }),
    );
    expect(tx.assetVersion.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { assetId: ASSET, companyId: COMPANY } }),
    );
  });

  it('writes nothing when the normalised state did not change', async () => {
    const tx = makeTx({ max: 3, rows: [{ assetFieldId: F_HOST, value: 'edge-01' }] });
    const out = await recordAssetVersion(tx as never, {
      companyId: COMPANY,
      assetId: ASSET,
      previous: prev,
      changedBy: 'user-1',
    });
    expect(out).toBeNull();
    expect(tx.assetVersion.create).not.toHaveBeenCalled();
    expect(tx.assetVersion.createMany).not.toHaveBeenCalled();
  });

  it('appends max+1 with the changed field ids', async () => {
    const tx = makeTx({ max: 3 });
    const out = await recordAssetVersion(tx as never, {
      companyId: COMPANY,
      assetId: ASSET,
      previous: prev,
      changedBy: null,
      changeReason: 'Integration sync',
    });
    expect(out).toEqual({ version: 4, changedFields: [F_HOST] });
    expect(tx.assetVersion.createMany).not.toHaveBeenCalled();
    expect(tx.assetVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        version: 4,
        changedFields: [F_HOST],
        changedBy: null,
        changeReason: 'Integration sync',
      }),
    });
  });

  it('first tracked edit of a pre-feature asset records the prior state as a baseline first', async () => {
    const tx = makeTx({ max: null });
    const out = await recordAssetVersion(tx as never, {
      companyId: COMPANY,
      assetId: ASSET,
      previous: prev,
      changedBy: 'user-1',
    });
    expect(out?.version).toBe(2);
    expect(tx.assetVersion.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          assetId: ASSET,
          companyId: COMPANY,
          version: 1,
          name: 'Edge 01',
          fieldValues: { [F_HOST]: 'edge-01' },
          changedFields: [],
          changedBy: null,
          createdAt: prev.updatedAt,
        }),
      ],
      skipDuplicates: true,
    });
  });

  it('does not write a baseline when the edit changed nothing', async () => {
    const tx = makeTx({ max: null, rows: [{ assetFieldId: F_HOST, value: 'edge-01' }] });
    await recordAssetVersion(tx as never, {
      companyId: COMPANY,
      assetId: ASSET,
      previous: prev,
      changedBy: 'user-1',
    });
    expect(tx.assetVersion.createMany).not.toHaveBeenCalled();
  });

  it('turns a concurrent duplicate version into a 409', async () => {
    const tx = makeTx({ max: 3 });
    tx.assetVersion.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    await expect(
      recordAssetVersion(tx as never, {
        companyId: COMPANY,
        assetId: ASSET,
        previous: prev,
        changedBy: 'user-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('prunes past the cap right after appending (never the first or latest)', async () => {
    const tx = makeTx({ max: 3, total: ASSET_VERSION_CAP + 2 });
    tx.assetVersion.findMany.mockResolvedValue([{ version: 2 }, { version: 3 }]);
    await recordAssetVersion(tx as never, {
      companyId: COMPANY,
      assetId: ASSET,
      previous: prev,
      changedBy: 'user-1',
    });
    expect(tx.assetVersion.create).toHaveBeenCalledTimes(1);
    expect(tx.assetVersion.deleteMany).toHaveBeenCalledWith({
      where: { assetId: ASSET, companyId: COMPANY, version: { in: [2, 3] } },
    });
  });
});

describe('enforceVersionCap', () => {
  function tx(total: number, doomed: number[]) {
    return {
      assetVersion: {
        count: jest.fn().mockResolvedValue(total),
        findMany: jest.fn().mockResolvedValue(doomed.map((version) => ({ version }))),
        deleteMany: jest.fn().mockResolvedValue({ count: doomed.length }),
      },
    };
  }

  it('does nothing at or under the cap', async () => {
    const t = tx(ASSET_VERSION_CAP, []);
    expect(await enforceVersionCap(t as never, COMPANY, ASSET)).toBe(0);
    expect(t.assetVersion.findMany).not.toHaveBeenCalled();
    expect(t.assetVersion.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes the oldest surplus, skipping the first row, scoped to asset and company', async () => {
    const t = tx(ASSET_VERSION_CAP + 3, [2, 3, 4]);
    expect(await enforceVersionCap(t as never, COMPANY, ASSET)).toBe(3);
    expect(t.assetVersion.findMany).toHaveBeenCalledWith({
      where: { assetId: ASSET, companyId: COMPANY },
      select: { version: true },
      orderBy: { version: 'asc' },
      skip: 1,
      take: 3,
    });
    expect(t.assetVersion.deleteMany).toHaveBeenCalledWith({
      where: { assetId: ASSET, companyId: COMPANY, version: { in: [2, 3, 4] } },
    });
  });

  it('caps at 500 by default', () => {
    expect(ASSET_VERSION_CAP).toBe(500);
  });
});

describe('lockAndSnapshotAsset', () => {
  function tx(asset: unknown) {
    const order: string[] = [];
    return {
      order,
      $queryRaw: jest.fn(async (...a: unknown[]) => {
        order.push('lock');
        return a;
      }),
      asset: {
        findFirst: jest.fn(async () => {
          order.push('read');
          return asset;
        }),
      },
      assetFieldValue: {
        findMany: jest.fn().mockResolvedValue([{ assetFieldId: F_HOST, value: 'edge-01' }]),
      },
    };
  }
  const row = { name: 'Edge 01', externalId: null, externalSource: null, updatedAt: new Date('2026-01-01') };

  it('locks the asset row (FOR UPDATE, company-scoped) before reading its state', async () => {
    const t = tx(row);
    const out = await lockAndSnapshotAsset(t as never, COMPANY, ASSET);
    expect(t.order).toEqual(['lock', 'read']);
    const [strings, ...values] = t.$queryRaw.mock.calls[0] as unknown as [string[], ...string[]];
    expect(strings.join('?')).toMatch(/FOR UPDATE/);
    expect(strings.join('?')).toMatch(/company_id/);
    expect(values).toEqual([ASSET, COMPANY]);
    expect(t.asset.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ASSET, companyId: COMPANY } }),
    );
    expect(t.assetFieldValue.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { assetId: ASSET, companyId: COMPANY } }),
    );
    expect(out).toEqual({
      name: 'Edge 01',
      externalId: null,
      externalSource: null,
      fieldValues: { [F_HOST]: 'edge-01' },
      updatedAt: row.updatedAt,
    });
  });

  it('returns null for an asset that is not in the company', async () => {
    expect(await lockAndSnapshotAsset(tx(null) as never, COMPANY, ASSET)).toBeNull();
  });
});

describe('restoreChangeReason / reasonForClient', () => {
  it('stores only the version number (never field names)', () => {
    expect(restoreChangeReason(3, false)).toBe('restore from v3');
    expect(restoreChangeReason(3, true)).toBe('restore from v3 (field restore)');
  });

  it('shows clients only the generic restore reason', () => {
    expect(reasonForClient('restore from v3 (field restore)')).toBe('restore from v3');
    expect(reasonForClient('integration sync')).toBeNull();
    expect(reasonForClient('Baseline: state before version history began')).toBeNull();
    expect(reasonForClient(null)).toBeNull();
  });
});

describe('version projections', () => {
  const fields = [
    { id: F_HOST, name: 'Hostname', fieldType: 'TEXT', visibleToClients: true, archivedAt: null },
    { id: F_NOTE, name: 'Internal note', fieldType: 'TEXT', visibleToClients: false, archivedAt: null },
    {
      id: F_SECRETISH,
      name: 'Old field',
      fieldType: 'TEXT',
      visibleToClients: true,
      archivedAt: new Date(),
    },
  ] as never;
  const row = {
    version: 2,
    name: 'Edge 01',
    externalId: null,
    externalSource: null,
    fieldValues: { [F_HOST]: 'h', [F_NOTE]: 'internal-only', [F_SECRETISH]: 'old' },
    changedFields: ['name', F_HOST, F_NOTE, F_SECRETISH],
    changedBy: 'user-1',
    changeReason: 'restore from v1 (field restore)',
    redactedAt: null,
    redactedFields: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
  const names = new Map([['user-1', 'Op Erator']]);

  it('staff see author, reason and every live field; archived fields are dropped', () => {
    const p = projectVersionDetail(row, null, fields, 'OPERATOR', names);
    expect(p.values).toEqual({ [F_HOST]: 'h', [F_NOTE]: 'internal-only' });
    expect(p.changedFields).toEqual(['name', F_HOST, F_NOTE]);
    expect(p.changedBy).toBe('user-1');
    expect(p.changedByName).toBe('Op Erator');
    expect(p.changeReason).toBe('restore from v1 (field restore)');
    expect(p.previous).toBeNull();
  });

  it('client users never see hidden values or ids, nor who changed it or free-text reasons', () => {
    const p = projectVersionDetail(
      { ...row, changeReason: 'integration sync' },
      row,
      fields,
      'CLIENT_USER',
      names,
    );
    expect(p.values).toEqual({ [F_HOST]: 'h' });
    expect(p.changedFields).toEqual(['name', F_HOST]);
    expect(p.changedBy).toBeNull();
    expect(p.changedByName).toBeNull();
    expect(p.changeReason).toBeNull();
    expect(p.previous?.values).toEqual({ [F_HOST]: 'h' });
    const json = JSON.stringify(p);
    expect(json).not.toContain('internal-only');
    expect(json).not.toContain(F_NOTE);
    expect(json).not.toContain('user-1');
    expect(json).not.toContain('Op Erator');
  });

  it('client users get only the generic restore reason', () => {
    const p = projectVersionSummary(row, fields, 'CLIENT_USER', names);
    expect(p.changeReason).toBe('restore from v1');
  });

  it('flags redaction: row-level to everyone, field-level only for readable fields to clients', () => {
    const whole = { ...row, redactedAt: new Date(), redactedFields: [] };
    expect(projectVersionSummary(whole, fields, 'CLIENT_USER', names).redacted).toBe(true);
    const hiddenOnly = { ...row, redactedAt: new Date(), redactedFields: [F_NOTE] };
    expect(projectVersionSummary(hiddenOnly, fields, 'CLIENT_USER', names).redacted).toBe(false);
    expect(projectVersionSummary(hiddenOnly, fields, 'OPERATOR', names).redacted).toBe(true);
    const state = projectVersionDetail(hiddenOnly, null, fields, 'OPERATOR', names);
    expect(state.redactedFields).toEqual([F_NOTE]);
    expect(projectVersionDetail(hiddenOnly, null, fields, 'CLIENT_USER', names).redactedFields).toEqual([]);
  });
});
