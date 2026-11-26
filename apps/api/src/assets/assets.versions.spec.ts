import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { FULL_PASSWORD_ACCESS } from '../passwords/password-access-policy.js';
import { FieldTypesRegistry } from '../field-types/field-types.registry.js';

jest.mock('../uploads/uploads.service.js', () => ({
  UploadsService: class UploadsService {},
}));

let AssetsService: typeof import('./assets.service.js').AssetsService;
beforeAll(async () => {
  ({ AssetsService } = await import('./assets.service.js'));
});

const CO = '12000000-0000-4000-8000-000000000001';
const OTHER_CO = '12000000-0000-4000-8000-0000000000ff';
const LAYOUT = '12000000-0000-4000-8000-000000000002';
const F_HOST = '12000000-0000-4000-8000-0000000000a1';
const F_NOTES = '12000000-0000-4000-8000-0000000000a2';
const F_INTERNAL = '12000000-0000-4000-8000-0000000000a3';
const F_GONE = '12000000-0000-4000-8000-0000000000a4';
const F_FOREIGN = '12000000-0000-4000-8000-0000000000e1';
const USER = '12000000-0000-4000-8000-0000000000b1';

function field(over: Record<string, unknown>) {
  return {
    assetLayoutId: LAYOUT,
    isRequired: false,
    isUniquePerCompany: false,
    visibleToClients: true,
    isPrimary: false,
    showInTable: false,
    options: {},
    archivedAt: null,
    ...over,
  };
}
const FIELDS = [
  field({ id: F_HOST, slug: 'hostname', name: 'Hostname', fieldType: 'TEXT', position: 0, isPrimary: true }),
  field({ id: F_NOTES, slug: 'notes', name: 'Notes', fieldType: 'TEXTAREA', position: 1 }),
  field({
    id: F_INTERNAL,
    slug: 'internal',
    name: 'Internal note',
    fieldType: 'TEXT',
    position: 2,
    visibleToClients: false,
  }),
  field({
    id: F_GONE,
    slug: 'gone',
    name: 'Retired',
    fieldType: 'TEXT',
    position: 3,
    archivedAt: new Date('2026-01-01T00:00:00.000Z'),
  }),
];
const LAYOUT_ROW = { id: LAYOUT, name: 'Devices', slug: 'devices', archivedAt: null, fields: FIELDS };

type Where = Record<string, unknown>;
const actorOf = (role: AuthedUser['role']): AuthedUser => ({
  id: USER,
  email: 'versions-spec@example.com',
  role,
  globalAccess: null,
  platformCapabilities: [],
  sessionId: '12000000-0000-4000-8000-0000000000c1',
  mfaEnforcementCompletedAt: null,
  mfaPending: false,
  passwordAccess: FULL_PASSWORD_ACCESS,
});
const staff = actorOf('OPERATOR');
const client = actorOf('CLIENT_USER');
const meta = { ip: '127.0.0.1', userAgent: 'jest' };

/**
 * Stateful in-memory stand-in for the Prisma delegates the version flow
 * touches. Every assetVersion / assetFieldValue call must carry a
 * `companyId` in its `where` (the tenant middleware's rule); the fake
 * throws if one does not, so a missing filter fails a test.
 */
type RawCall = { text: string; params: unknown[] };
/** Flatten a tagged-template call (with nested Prisma.Sql) into SQL text + params. */
function renderRaw(strings: readonly string[], values: unknown[]): RawCall {
  let text = '';
  const params: unknown[] = [];
  strings.forEach((str, i) => {
    text += str;
    if (i >= values.length) return;
    const v = values[i] as { strings?: readonly string[]; values?: unknown[] } | unknown;
    if (v && typeof v === 'object' && 'strings' in (v as object) && 'values' in (v as object)) {
      const inner = renderRaw((v as { strings: readonly string[] }).strings, (v as { values: unknown[] }).values);
      text += inner.text;
      params.push(...inner.params);
    } else {
      text += `$${params.length + 1}`;
      params.push(v);
    }
  });
  return { text: text.replace(/\s+/g, ' ').trim(), params };
}

function makeWorld() {
  let beforeTransaction: (() => void) | null = null;
  const rawCalls: RawCall[] = [];
  type A = {
    id: string;
    companyId: string;
    assetLayoutId: string;
    name: string;
    externalId: string | null;
    externalSource: string | null;
    archivedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };
  const assets: A[] = [];
  const values: Array<{ id: string; companyId: string; assetId: string; assetFieldId: string; value: unknown }> = [];
  const versions: Array<Record<string, any>> = [];
  let seq = 0;
  const needCompany = (where: Where | undefined, what: string): void => {
    if (!where || typeof where['companyId'] !== 'string') {
      throw new Error(`tenant scope: ${what} without companyId`);
    }
  };
  const valuesFor = (assetId: string) => values.filter((v) => v.assetId === assetId);

  const tx = {
    assetLayout: { findUnique: jest.fn().mockResolvedValue(LAYOUT_ROW) },
    asset: {
      create: jest.fn(async ({ data }: { data: Record<string, any> }) => {
        const row: A = {
          id: `12000000-0000-4000-8000-0000000001${String(++seq).padStart(2, '0')}`,
          archivedAt: null,
          externalId: null,
          externalSource: null,
          createdAt: new Date('2026-02-01T00:00:00.000Z'),
          updatedAt: new Date('2026-02-01T00:00:00.000Z'),
          ...(data as Partial<A>),
        } as A;
        assets.push(row);
        return row;
      }),
      findFirst: jest.fn(async (args: { where: Where; include?: unknown; select?: unknown }) => {
        const w = args.where;
        const row = assets.find(
          (a) => a.id === w['id'] && (w['companyId'] === undefined || a.companyId === w['companyId']),
        );
        if (w['externalId'] !== undefined && !('id' in w)) return null;
        if (!row) return null;
        if (args.include) {
          // Copies, like a real read: a later concurrent write must not alias into this snapshot.
          return { ...row, assetLayout: LAYOUT_ROW, fieldValues: valuesFor(row.id).map((v) => ({ ...v })) };
        }
        if (args.select && 'assetLayout' in (args.select as object)) {
          return { id: row.id, assetLayout: LAYOUT_ROW };
        }
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        needCompany(where, 'asset.updateMany');
        const row = assets.find((a) => a.id === where['id'] && a.companyId === where['companyId']);
        if (!row) return { count: 0 };
        Object.assign(row, data, { updatedAt: new Date('2026-03-01T00:00:00.000Z') });
        return { count: 1 };
      }),
    },
    assetFieldValue: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn(async ({ where }: { where: Where }) => {
        needCompany(where, 'assetFieldValue.findMany');
        return values.filter((v) => v.assetId === where['assetId'] && v.companyId === where['companyId']);
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const key = where.assetId_assetFieldId;
        const hit = values.find((v) => v.assetId === key.assetId && v.assetFieldId === key.assetFieldId);
        if (hit) Object.assign(hit, update);
        else values.push({ id: `v${values.length}`, ...create });
        return {};
      }),
      deleteMany: jest.fn(async ({ where }: { where: Where }) => {
        needCompany(where, 'assetFieldValue.deleteMany');
        for (let i = values.length - 1; i >= 0; i -= 1) {
          const v = values[i]!;
          if (v.assetId === where['assetId'] && v.assetFieldId === where['assetFieldId']) values.splice(i, 1);
        }
        return { count: 1 };
      }),
    },
    assetVersion: {
      aggregate: jest.fn(async ({ where }: { where: Where }) => {
        needCompany(where, 'assetVersion.aggregate');
        const mine = versions.filter((v) => v.assetId === where['assetId'] && v.companyId === where['companyId']);
        return { _max: { version: mine.length ? Math.max(...mine.map((v) => v.version as number)) : null } };
      }),
      count: jest.fn(async ({ where }: { where: Where }) => {
        needCompany(where, 'assetVersion.count');
        return versions.filter((v) => v.assetId === where['assetId'] && v.companyId === where['companyId']).length;
      }),
      createMany: jest.fn(async ({ data }: { data: Array<Record<string, any>> }) => {
        for (const row of data) {
          if (typeof row['companyId'] !== 'string') throw new Error('tenant scope: createMany row without companyId');
          if (!versions.some((v) => v.assetId === row['assetId'] && v.version === row['version'])) {
            versions.push({ redactedAt: null, redactedFields: [], ...row });
          }
        }
        return { count: data.length };
      }),
      create: jest.fn(async ({ data }: { data: Record<string, any> }) => {
        if (typeof data['companyId'] !== 'string') throw new Error('tenant scope: create without companyId');
        versions.push({ redactedAt: null, redactedFields: [], ...data });
        return data;
      }),
      deleteMany: jest.fn(async ({ where }: { where: Where }) => {
        needCompany(where, 'assetVersion.deleteMany');
        const doomed = (where['version'] as { in: number[] }).in;
        let n = 0;
        for (let i = versions.length - 1; i >= 0; i -= 1) {
          const v = versions[i]!;
          if (v.assetId === where['assetId'] && v.companyId === where['companyId'] && doomed.includes(v.version)) {
            versions.splice(i, 1);
            n += 1;
          }
        }
        return { count: n };
      }),
      findMany: jest.fn(async (args: { where: Where; select?: Record<string, boolean>; orderBy?: { version: 'asc' | 'desc' }; skip?: number; take?: number }) => {
        const { where } = args;
        needCompany(where, 'assetVersion.findMany');
        const lt = (where['version'] as { lt?: number } | undefined)?.lt;
        let rows = versions
          .filter((v) => v.assetId === where['assetId'] && v.companyId === where['companyId'])
          .filter((v) => lt === undefined || v.version < lt)
          .sort((a, b) => (args.orderBy?.version === 'asc' ? 1 : -1) * ((a.version as number) - (b.version as number)));
        rows = rows.slice(args.skip ?? 0, args.take === undefined ? undefined : (args.skip ?? 0) + args.take);
        if (args.select) {
          return rows.map((r) => Object.fromEntries(Object.keys(args.select!).map((k) => [k, r[k]])));
        }
        return rows;
      }),
      findFirst: jest.fn(async ({ where, orderBy }: { where: Where; orderBy?: { version: 'desc' } }) => {
        needCompany(where, 'assetVersion.findFirst');
        const v = where['version'];
        const hits = versions
          .filter((r) => r.assetId === where['assetId'] && r.companyId === where['companyId'])
          .filter((r) =>
            typeof v === 'number' ? r.version === v : v && typeof v === 'object' ? r.version < (v as { lt: number }).lt : true,
          )
          .sort((a, b) => (orderBy?.version === 'desc' ? -1 : 1) * ((a.version as number) - (b.version as number)));
        return hits[0] ?? null;
      }),
    },
    upload: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: USER, name: 'Op Erator' }]) },
    $queryRaw: jest.fn(async (strings: readonly string[], ...values: unknown[]) => {
      rawCalls.push(renderRaw(strings, values));
      return [];
    }),
    // Emulates the redaction UPDATEs by their SQL shape (the SQL itself is asserted separately).
    $executeRaw: jest.fn(async (strings: readonly string[], ...values: unknown[]) => {
      const call = renderRaw(strings, values);
      rawCalls.push(call);
      if (call.text.includes('field_values - ')) {
        // params: fieldId, fieldId, assetId, companyId, fieldId[, version]
        const fieldId = call.params[0] as string;
        const assetId = call.params[2] as string;
        const companyId = call.params[3] as string;
        const only = call.params[5] as number | undefined;
        let n = 0;
        for (const v of versions) {
          if (v.assetId !== assetId || v.companyId !== companyId) continue;
          if (only !== undefined && v.version !== only) continue;
          if (!(fieldId in (v['fieldValues'] as object))) continue;
          delete (v['fieldValues'] as Record<string, unknown>)[fieldId];
          v['redactedAt'] = new Date();
          v['redactedFields'] = Array.from(new Set([...(v['redactedFields'] as string[]), fieldId]));
          n += 1;
        }
        return n;
      }
      // whole-version: params = assetId, companyId, version
      const [assetId, companyId, version] = call.params as [string, string, number];
      let n = 0;
      for (const v of versions) {
        if (v.assetId === assetId && v.companyId === companyId && v.version === version) {
          v['fieldValues'] = {};
          v['redactedAt'] = new Date();
          v['redactedFields'] = [];
          n += 1;
        }
      }
      return n;
    }),
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn(async (cb: (c: unknown) => Promise<unknown>) => {
      beforeTransaction?.();
      return cb(tx);
    }),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined), logWithClient: jest.fn() };
  const searchIndex = { upsertAsset: jest.fn().mockResolvedValue(undefined) };
  const service = new AssetsService(
    prisma as never,
    audit as never,
    new FieldTypesRegistry() as never,
    {} as never,
    {} as never,
    searchIndex as never,
    {} as never,
    {} as never,
    {} as never,
  );
  jest.spyOn(service, 'get').mockImplementation(async (_a, _c, id) => ({ id }) as never);
  return {
    service,
    tx,
    audit,
    assets,
    values,
    versions,
    rawCalls,
    /** Run `fn` between update()'s pre-read and its transaction (a concurrent commit). */
    beforeTx: (fn: () => void) => {
      beforeTransaction = fn;
    },
  };
}

async function seeded() {
  const w = makeWorld();
  await w.service.create(
    staff,
    CO,
    { assetLayoutId: LAYOUT, fieldValues: { hostname: 'edge-01', notes: 'rack 4', internal: 'admin pw hint' } },
    meta,
  );
  return { ...w, id: w.assets[0]!.id };
}

describe('asset version history: recording', () => {
  it('create writes version 1 "initial version" keyed by field id, in the create transaction', async () => {
    const { versions, tx, assets } = await seeded();
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      assetId: assets[0]!.id,
      companyId: CO,
      version: 1,
      name: 'edge-01',
      changedBy: USER,
      changeReason: 'initial version',
      fieldValues: { [F_HOST]: 'edge-01', [F_NOTES]: 'rack 4', [F_INTERNAL]: 'admin pw hint' },
    });
    expect(tx.assetVersion.create).toHaveBeenCalledTimes(1);
  });

  it('update with a real change appends the next version with only the changed field ids', async () => {
    const { service, versions, id } = await seeded();
    await service.update(staff, CO, id, { fieldValues: { notes: 'rack 5' } }, meta);
    expect(versions).toHaveLength(2);
    expect(versions[1]).toMatchObject({
      version: 2,
      changedFields: [F_NOTES],
      changedBy: USER,
      changeReason: null,
      fieldValues: expect.objectContaining({ [F_NOTES]: 'rack 5', [F_HOST]: 'edge-01' }),
    });
  });

  it('update that changes nothing writes no version (normalised compare)', async () => {
    const { service, versions, id } = await seeded();
    await service.update(staff, CO, id, { fieldValues: { notes: 'rack 4', hostname: 'edge-01' } }, meta);
    expect(versions).toHaveLength(1);
  });

  it('first edit of an asset that predates version history records its prior state as a baseline', async () => {
    const { service, versions, id } = await seeded();
    versions.length = 0; // simulate a pre-0098 asset
    await service.update(staff, CO, id, { fieldValues: { notes: 'rack 9' } }, meta);
    expect(versions.map((v) => v['version'])).toEqual([1, 2]);
    expect(versions[0]).toMatchObject({
      changedBy: null,
      changedFields: [],
      fieldValues: expect.objectContaining({ [F_NOTES]: 'rack 4' }),
    });
    expect(versions[1]).toMatchObject({ changedFields: [F_NOTES] });
  });

  it('archived assets cannot be edited, so no version is written', async () => {
    const { service, versions, assets, id } = await seeded();
    assets[0]!.archivedAt = new Date();
    await expect(
      service.update(staff, CO, id, { fieldValues: { notes: 'x' } }, meta),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(versions).toHaveLength(1);
  });
});

describe('asset version history: listing and secrecy', () => {
  it('the list is lightweight: summaries only, no captured values, no value columns selected', async () => {
    const { service, tx, id } = await seeded();
    const out = await service.listVersions(staff, CO, id);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      version: 1,
      changedBy: USER,
      changedByName: 'Op Erator',
      changeReason: 'initial version',
      redacted: false,
    });
    expect(out.items[0]).not.toHaveProperty('values');
    expect(JSON.stringify(out)).not.toContain('admin pw hint');
    const select = tx.assetVersion.findMany.mock.calls.at(-1)![0].select as Record<string, boolean>;
    expect(select).not.toHaveProperty('fieldValues');
    expect(out.fields.map((f) => f.id)).toEqual([F_HOST, F_NOTES, F_INTERNAL]);
  });

  it('paginates newest first with a version cursor and no overlap', async () => {
    const { service, id } = await seeded();
    for (const n of ['a', 'b', 'c']) await service.update(staff, CO, id, { fieldValues: { notes: n } }, meta);
    const first = await service.listVersions(staff, CO, id, { limit: 2 });
    expect(first.items.map((i) => i.version)).toEqual([4, 3]);
    expect(first.nextCursor).toBe(3);
    const second = await service.listVersions(staff, CO, id, { limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((i) => i.version)).toEqual([2, 1]);
    expect(second.nextCursor).toBeNull();
  });

  it('detail returns captured values for staff, with the previous version state', async () => {
    const { service, id } = await seeded();
    await service.update(staff, CO, id, { fieldValues: { notes: 'rack 5' } }, meta);
    const d = await service.getVersion(staff, CO, id, 2);
    expect(d.values).toEqual({ [F_HOST]: 'edge-01', [F_NOTES]: 'rack 5', [F_INTERNAL]: 'admin pw hint' });
    expect(d.previous?.values[F_NOTES]).toBe('rack 4');
    expect(d.changedFields).toEqual([F_NOTES]);
    expect((await service.getVersion(staff, CO, id, 1)).previous).toBeNull();
  });

  it('client users never receive hidden values, ids or names, nor author or free-text reasons', async () => {
    const { service, id } = await seeded();
    await service.update(staff, CO, id, { fieldValues: { internal: 'new hint', notes: 'rack 5' } }, meta);
    const list = await service.listVersions(client, CO, id);
    const detail = await service.getVersion(client, CO, id, 2);
    const json = JSON.stringify({ list, detail });
    for (const secret of ['admin pw hint', 'new hint', F_INTERNAL, 'Internal note', 'Op Erator', USER, 'initial version']) {
      expect(json).not.toContain(secret);
    }
    expect(detail.values).toEqual({ [F_HOST]: 'edge-01', [F_NOTES]: 'rack 5' });
    expect(detail.changedFields).toEqual([F_NOTES]);
    expect(list.items.every((i) => i.changedBy === null && i.changedByName === null && i.changeReason === null)).toBe(true);
  });

  it('is tenant scoped: a foreign company gets a 404 on list and detail, and queries carry companyId', async () => {
    const { service, tx, id } = await seeded();
    await expect(service.listVersions(staff, OTHER_CO, id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getVersion(staff, OTHER_CO, id, 1)).rejects.toBeInstanceOf(NotFoundException);
    await service.listVersions(staff, CO, id);
    await service.getVersion(staff, CO, id, 1);
    for (const call of [...tx.assetVersion.findMany.mock.calls, ...tx.assetVersion.findFirst.mock.calls]) {
      expect((call[0] as { where: Where }).where['companyId']).toBe(CO);
    }
  });

  it('404s on an unknown or out-of-range version', async () => {
    const { service, id } = await seeded();
    await expect(service.getVersion(staff, CO, id, 9)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getVersion(staff, CO, id, 0)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getVersion(staff, CO, id, 2 ** 31)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not touch the asset list/detail payload: versions never ride on get()', async () => {
    const src = readFileSync(join(__dirname, 'assets.service.ts'), 'utf8');
    expect(src).not.toMatch(/include:\s*\{[^}]*versions:/);
  });
});

describe('asset version history: restore', () => {
  async function edited() {
    const w = await seeded();
    await w.service.update(staff, CO, w.id, { fieldValues: { hostname: 'edge-02', notes: 'rack 5' } }, meta);
    return w; // v1 {edge-01, rack 4}, v2 {edge-02, rack 5}
  }

  it('per-field restore changes only that field and records a forward version + audit with names only', async () => {
    const { service, versions, audit, tx, id } = await edited();
    audit.logWithClient.mockClear();
    await service.restoreVersion(staff, CO, id, 1, meta, [F_NOTES]);
    expect(versions).toHaveLength(3);
    expect(versions[2]).toMatchObject({
      version: 3,
      changedFields: [F_NOTES],
      changeReason: 'restore from v1 (field restore)',
      fieldValues: expect.objectContaining({ [F_NOTES]: 'rack 4', [F_HOST]: 'edge-02' }),
    });
    // Name pinned: the un-chosen primary field did not move the name.
    expect(versions[2]!['name']).toBe('edge-02');
    // Written inside update()'s transaction (logWithClient on the tx), not afterwards.
    const rows = audit.logWithClient.mock.calls.filter((c) => c[1].action === 'asset.version.restored');
    expect(rows).toHaveLength(1);
    expect(rows[0]![0]).toBe(tx);
    expect(audit.log.mock.calls.some((c) => c[0].action === 'asset.version.restored')).toBe(false);
    const call = rows[0]![1];
    expect(call).toMatchObject({
      entityType: 'Asset',
      entityId: id,
      companyId: CO,
      after: { fromVersion: 1, fields: ['Notes'] },
    });
    expect(JSON.stringify(call)).not.toContain('rack 4');
    expect(tx.assetFieldValue.upsert).toHaveBeenCalled();
  });

  it('per-field restore does not let the primary field re-derive a custom asset name', async () => {
    const w = makeWorld();
    await w.service.create(
      staff,
      CO,
      { assetLayoutId: LAYOUT, name: 'Custom Name', fieldValues: { hostname: 'edge-01', notes: 'a' } },
      meta,
    );
    const id = w.assets[0]!.id;
    await w.service.update(staff, CO, id, { name: 'Custom Name', fieldValues: { notes: 'b' } }, meta);
    await w.service.restoreVersion(staff, CO, id, 1, meta, [F_NOTES]);
    expect(w.assets[0]!.name).toBe('Custom Name');
    expect(w.versions.at(-1)).toMatchObject({ name: 'Custom Name', changedFields: [F_NOTES] });
  });

  it('whole-version restore reapplies name and values but never the external identity', async () => {
    const { service, versions, tx, assets, id } = await edited();
    assets[0]!.externalId = 'ext-now';
    assets[0]!.externalSource = 'breeze';
    tx.asset.updateMany.mockClear();
    await service.restoreVersion(staff, CO, id, 1, meta);
    const data = tx.asset.updateMany.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty('externalId');
    expect(data).not.toHaveProperty('externalSource');
    expect(versions.at(-1)).toMatchObject({
      changeReason: 'restore from v1',
      name: 'edge-01',
      fieldValues: expect.objectContaining({ [F_HOST]: 'edge-01', [F_NOTES]: 'rack 4' }),
    });
  });

  it('refuses an archived asset and writes nothing', async () => {
    const { service, versions, audit, assets, id } = await edited();
    assets[0]!.archivedAt = new Date();
    const before = versions.length;
    await expect(service.restoreVersion(staff, CO, id, 1, meta)).rejects.toThrow(/archived/);
    expect(versions).toHaveLength(before);
    expect(audit.log.mock.calls.some((c) => c[0].action === 'asset.version.restored')).toBe(false);
  });

  it('404s for an unknown version, a foreign company, and an out-of-range number', async () => {
    const { service, id } = await edited();
    await expect(service.restoreVersion(staff, CO, id, 99, meta)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.restoreVersion(staff, OTHER_CO, id, 1, meta)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.restoreVersion(staff, CO, id, 0, meta)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.restoreVersion(staff, CO, id, 2 ** 31, meta)).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    ['a slug', ['hostname']],
    ['a field id from another layout', [F_FOREIGN]],
    ['a retired field', [F_GONE]],
    ['an identity column', ['externalId']],
    ['an empty list', []],
  ])('rejects %s in the allowlist', async (_label, fields) => {
    const { service, id } = await edited();
    await expect(
      service.restoreVersion(staff, CO, id, 1, meta, fields as string[]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a client user cannot name a hidden field, so per-field restore cannot target it', async () => {
    const { service, id } = await edited();
    await expect(
      service.restoreVersion(client, CO, id, 1, meta, [F_INTERNAL]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('restoring a version identical to the current state writes and audits nothing', async () => {
    const { service, versions, audit, id } = await edited();
    audit.log.mockClear();
    audit.logWithClient.mockClear();
    await service.restoreVersion(staff, CO, id, 2, meta);
    expect(versions).toHaveLength(2);
    expect(audit.log).not.toHaveBeenCalled();
    expect(audit.logWithClient).not.toHaveBeenCalled();
  });

  it('emits no asset.version.restored row when update() records no version (nothing changed)', async () => {
    const { service, versions, audit, id } = await edited();
    audit.logWithClient.mockClear();
    await service.update(
      staff,
      CO,
      id,
      { fieldValues: { notes: 'rack 5' } }, // already the current value
      meta,
      undefined,
      { restore: { fromVersion: 1 } },
    );
    expect(versions).toHaveLength(2);
    expect(audit.logWithClient.mock.calls.some((c) => c[1].action === 'asset.version.restored')).toBe(false);
  });

  it('never stores field names in the reason, even for a hidden-from-client field', async () => {
    const { service, versions, audit, id } = await edited();
    await service.update(staff, CO, id, { fieldValues: { internal: 'changed hint' } }, meta);
    await service.restoreVersion(staff, CO, id, 1, meta, [F_INTERNAL]);
    expect(versions.at(-1)!['changeReason']).toBe('restore from v1 (field restore)');
    expect(JSON.stringify(versions.map((v) => v['changeReason']))).not.toContain('Internal note');
    // The staff-only audit row still names the field.
    const rows = audit.logWithClient.mock.calls.filter((c) => c[1].action === 'asset.version.restored');
    expect(rows.at(-1)![1].after).toEqual({ fromVersion: 1, fields: ['Internal note'] });
  });

  it('a version may restore a field to empty when it changed to/from empty there', async () => {
    const { service, versions, id } = await seeded();
    await service.update(staff, CO, id, { fieldValues: { notes: null } }, meta); // v2: notes cleared
    await service.restoreVersion(staff, CO, id, 1, meta, [F_NOTES]); // back to "rack 4"
    expect(versions.at(-1)).toMatchObject({ fieldValues: expect.objectContaining({ [F_NOTES]: 'rack 4' }) });
    await service.restoreVersion(staff, CO, id, 2, meta, [F_NOTES]); // v2 had it cleared
    expect(versions.at(-1)!['fieldValues']).not.toHaveProperty(F_NOTES);
  });
});

describe('asset version history: concurrency and cap', () => {
  it('diffs against the state locked inside the transaction, not a stale pre-read', async () => {
    const w = await seeded(); // v1: notes "rack 4"
    // A concurrent editor commits notes -> "rack X" (and its version) after our pre-read.
    w.beforeTx(() => {
      w.values.find((v) => v.assetFieldId === F_NOTES)!.value = 'rack X';
      w.versions.push({
        assetId: w.id,
        companyId: CO,
        version: 2,
        name: 'edge-01',
        externalId: null,
        externalSource: null,
        fieldValues: { [F_HOST]: 'edge-01', [F_NOTES]: 'rack X', [F_INTERNAL]: 'admin pw hint' },
        changedFields: [F_NOTES],
        changedBy: null,
        changeReason: null,
        redactedAt: null,
        redactedFields: [],
        createdAt: new Date(),
      });
    });
    // We write back the value we saw ("rack 4"): relative to the stale pre-read that is a
    // no-op (and would record nothing); relative to the committed state it is a change.
    await w.service.update(staff, CO, w.id, { fieldValues: { notes: 'rack 4' } }, meta);
    expect(w.versions.map((v) => v['version'])).toEqual([1, 2, 3]);
    expect(w.versions[2]).toMatchObject({ changedFields: [F_NOTES] });
    expect((w.versions[2]!['fieldValues'] as Record<string, unknown>)[F_NOTES]).toBe('rack 4');
  });

  it('locks the asset row (FOR UPDATE, company-scoped) before the write', async () => {
    const w = await seeded();
    w.rawCalls.length = 0;
    await w.service.update(staff, CO, w.id, { fieldValues: { notes: 'rack 7' } }, meta);
    const lock = w.rawCalls.find((c) => /FOR UPDATE/.test(c.text))!;
    expect(lock.text).toMatch(/company_id/);
    expect(lock.params).toEqual([w.id, CO]);
    expect(w.tx.$queryRaw.mock.invocationCallOrder[0]!).toBeLessThan(
      w.tx.asset.updateMany.mock.invocationCallOrder.at(-1)!,
    );
  });

  it('prunes the oldest versions past 500 per asset, keeping the first and the latest', async () => {
    const w = await seeded();
    for (let n = 2; n <= 505; n += 1) {
      w.versions.push({
        assetId: w.id,
        companyId: CO,
        version: n,
        name: 'edge-01',
        externalId: null,
        externalSource: null,
        fieldValues: {},
        changedFields: [],
        changedBy: null,
        changeReason: null,
        redactedAt: null,
        redactedFields: [],
        createdAt: new Date(),
      });
    }
    await w.service.update(staff, CO, w.id, { fieldValues: { notes: 'cap-test' } }, meta);
    const nums = w.versions.map((v) => v['version'] as number).sort((a, b) => a - b);
    expect(nums).toHaveLength(500);
    expect(nums[0]).toBe(1); // origin kept
    expect(nums.at(-1)).toBe(506); // latest kept
    expect(nums).not.toContain(2); // oldest surplus dropped
  });
});

describe('asset version history: redaction (erasure)', () => {
  async function history() {
    const w = await seeded();
    await w.service.update(staff, CO, w.id, { fieldValues: { internal: 'second secret', notes: 'rack 5' } }, meta);
    await w.service.update(staff, CO, w.id, { fieldValues: { internal: 'third secret' } }, meta);
    return w; // v1,v2,v3 each hold F_INTERNAL
  }
  const valuesOf = (w: { versions: Array<Record<string, any>> }, n: number) =>
    w.versions.find((v) => v['version'] === n)!['fieldValues'] as Record<string, unknown>;

  it('fieldId blanks that field in ALL versions, keeps the rows and marks them redacted', async () => {
    const w = await history();
    const out = await w.service.redactVersions(staff, CO, w.id, { fieldId: F_INTERNAL }, meta);
    expect(out).toEqual({ versionsRedacted: 3 });
    expect(w.versions).toHaveLength(3);
    for (const n of [1, 2, 3]) {
      expect(valuesOf(w, n)).not.toHaveProperty(F_INTERNAL);
      expect(valuesOf(w, n)).toHaveProperty(F_HOST); // other fields untouched
    }
    expect(w.versions.every((v) => v['redactedAt'] instanceof Date && v['redactedFields'][0] === F_INTERNAL)).toBe(true);
    // ...and it is visible in the list as a marker, with no value anywhere.
    const list = await w.service.listVersions(staff, CO, w.id);
    expect(list.items.every((i) => i.redacted)).toBe(true);
    expect(JSON.stringify(await w.service.getVersion(staff, CO, w.id, 2))).not.toContain('second secret');
  });

  it('version alone blanks every captured value of that version only', async () => {
    const w = await history();
    const out = await w.service.redactVersions(staff, CO, w.id, { version: 2 }, meta);
    expect(out).toEqual({ versionsRedacted: 1 });
    expect(valuesOf(w, 2)).toEqual({});
    expect(valuesOf(w, 1)).toHaveProperty(F_INTERNAL);
    expect(valuesOf(w, 3)).toHaveProperty(F_INTERNAL);
    expect(w.versions.find((v) => v['version'] === 2)).toMatchObject({ version: 2, name: 'edge-01' });
    expect((await w.service.getVersion(staff, CO, w.id, 2)).redacted).toBe(true);
  });

  it('fieldId plus version blanks that field in that version only', async () => {
    const w = await history();
    const out = await w.service.redactVersions(staff, CO, w.id, { fieldId: F_INTERNAL, version: 1 }, meta);
    expect(out).toEqual({ versionsRedacted: 1 });
    expect(valuesOf(w, 1)).not.toHaveProperty(F_INTERNAL);
    expect(valuesOf(w, 2)).toHaveProperty(F_INTERNAL);
  });

  it('audits ids and counts only, in the same transaction, never a value', async () => {
    const w = await history();
    w.audit.logWithClient.mockClear();
    await w.service.redactVersions(staff, CO, w.id, { fieldId: F_INTERNAL }, meta);
    const row = w.audit.logWithClient.mock.calls.find((c) => c[1].action === 'asset.version.redacted')!;
    expect(row[0]).toBe(w.tx);
    expect(row[1]).toMatchObject({
      entityType: 'Asset',
      entityId: w.id,
      companyId: CO,
      after: { fieldId: F_INTERNAL, versionsRedacted: 3 },
    });
    const json = JSON.stringify(row[1]);
    for (const secret of ['second secret', 'third secret', 'admin pw hint']) expect(json).not.toContain(secret);
  });

  it('is tenant scoped in SQL and lookups: a foreign company is a 404 and raw WHEREs carry company_id', async () => {
    const w = await history();
    await expect(
      w.service.redactVersions(staff, OTHER_CO, w.id, { fieldId: F_INTERNAL }, meta),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(valuesOf(w, 1)).toHaveProperty(F_INTERNAL);
    w.rawCalls.length = 0;
    await w.service.redactVersions(staff, CO, w.id, { fieldId: F_INTERNAL }, meta);
    await w.service.redactVersions(staff, CO, w.id, { version: 1 }, meta);
    const updates = w.rawCalls.filter((c) => /UPDATE asset_versions/.test(c.text));
    expect(updates).toHaveLength(2);
    for (const u of updates) {
      expect(u.text).toMatch(/asset_id = \$\d+::uuid AND company_id = \$\d+::uuid/);
      expect(u.params).toContain(CO);
      expect(u.params).toContain(w.id);
    }
  });

  it('404s for a field that is not on the layout or a version that does not exist; 400 for no target', async () => {
    const w = await history();
    await expect(w.service.redactVersions(staff, CO, w.id, { fieldId: F_FOREIGN }, meta)).rejects.toBeInstanceOf(NotFoundException);
    await expect(w.service.redactVersions(staff, CO, w.id, { version: 99 }, meta)).rejects.toBeInstanceOf(NotFoundException);
    await expect(w.service.redactVersions(staff, CO, w.id, {}, meta)).rejects.toBeInstanceOf(BadRequestException);
    expect(valuesOf(w, 1)).toHaveProperty(F_INTERNAL);
  });

  it('can scrub a retired (archived) field, which is exactly when it is needed', async () => {
    const w = await seeded();
    w.versions[0]!['fieldValues'] = { ...(w.versions[0]!['fieldValues'] as object), [F_GONE]: 'legacy secret' };
    const out = await w.service.redactVersions(staff, CO, w.id, { fieldId: F_GONE }, meta);
    expect(out.versionsRedacted).toBe(1);
    expect(JSON.stringify(w.versions)).not.toContain('legacy secret');
  });
});

describe('asset_versions schema', () => {
  const root = join(__dirname, '..', '..', '..', '..', 'packages', 'db', 'prisma');
  const migration = readFileSync(join(root, 'migrations', '0098_asset_versions', 'migration.sql'), 'utf8');
  const schema = readFileSync(join(root, 'schema.prisma'), 'utf8');

  it('cascades from the asset (purge removes history) and nulls the author on user delete', () => {
    expect(migration).toMatch(/asset_versions_asset_id_fkey[\s\S]*?ON DELETE CASCADE/);
    expect(migration).toMatch(/asset_versions_changed_by_fkey[\s\S]*?ON DELETE SET NULL/);
    expect(schema).toMatch(/asset\s+Asset\s+@relation\(fields: \[assetId\], references: \[id\], onDelete: Cascade\)/);
  });

  it('has the unique (asset, version) key and the (asset, created_at) index, and no unused company index', () => {
    expect(migration).toContain('CREATE UNIQUE INDEX "asset_versions_asset_version_uniq"');
    expect(migration).toContain('"asset_versions" ("asset_id", "created_at")');
    expect(migration).not.toContain('company_created_idx');
    expect(schema).not.toContain('asset_versions_company_created_idx');
  });

  it('carries the redaction markers in both the migration and the model', () => {
    expect(migration).toContain('"redacted_at"');
    expect(migration).toContain('"redacted_fields" TEXT[]');
    expect(schema).toMatch(/redactedAt\s+DateTime\?\s+@map\("redacted_at"\)/);
  });

  it('purging an asset hard-deletes the row, and the FK is what removes its versions', async () => {
    // The purge path deletes only the `assets` row; history must go with it by FK cascade
    // (the DB-backed spec proves it against Postgres). Pin both halves here.
    const service = readFileSync(join(__dirname, 'assets.service.ts'), 'utf8');
    const purge = service.slice(service.indexOf('async purge('), service.indexOf('async clone('));
    expect(purge).toMatch(/tx\.asset\.deleteMany\(/);
    expect(purge).not.toMatch(/assetVersion/); // no manual delete: relies on the cascade
    expect(migration).toMatch(/"asset_versions_asset_id_fkey"[\s\S]*?REFERENCES "assets"\("id"\)[\s\S]*?ON DELETE CASCADE/);
  });

  it('is purely additive', () => {
    const sql = migration.replace(/--.*$/gm, '').replace(/ON UPDATE CASCADE/g, '');
    expect(sql).not.toMatch(/ALTER TABLE "(?!asset_versions)/);
    expect(sql).not.toMatch(/DROP |UPDATE |INSERT /);
  });
});
