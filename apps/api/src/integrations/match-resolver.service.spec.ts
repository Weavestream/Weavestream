import { FieldTypesRegistry } from '../field-types/field-types.registry.js';
import { MatchResolverService } from './match-resolver.service.js';

/**
 * Phase 11 — match-by-key resolution tests.
 *
 * The service is intentionally side-effect-free, so we wire it up
 * with a hand-rolled Prisma stub instead of a real database. The
 * stub keeps three in-memory tables:
 *   - integrationSyncRecord (companyMappingId, externalId, assetId)
 *   - asset                 (id, companyId, externalSource, externalId, archivedAt, syncRecord?)
 *   - assetField            (id, fieldType)
 *   - assetFieldValue       (companyId, assetId, assetFieldId, value)
 *
 * For each test we seed exactly the rows the resolver should
 * encounter, run `resolve()` and assert the kind/ids it returns.
 */
type SyncRecord = {
  integrationCompanyMappingId: string;
  externalId: string;
  assetId: string;
};
type Asset = {
  id: string;
  companyId: string;
  externalSource: string | null;
  externalId: string | null;
  archivedAt: Date | null;
  hasSyncRecord: boolean;
};
type AssetField = { id: string; fieldType: string };
type AssetFieldValue = {
  companyId: string;
  assetId: string;
  assetFieldId: string;
  value: unknown;
};

function makeStubPrisma(seed: {
  syncRecords?: SyncRecord[];
  assets?: Asset[];
  assetFields?: AssetField[];
  values?: AssetFieldValue[];
}) {
  const syncRecords = seed.syncRecords ?? [];
  const assets = seed.assets ?? [];
  const fields = seed.assetFields ?? [];
  const values = seed.values ?? [];

  const valueMatches = (
    stored: unknown,
    variants: unknown[],
  ): boolean => {
    return variants.some((v) => {
      if (Array.isArray(v) && Array.isArray(stored)) {
        if (v.length !== stored.length) return false;
        return v.every((x, i) => x === stored[i]);
      }
      return v === stored;
    });
  };

  return {
    integrationSyncRecord: {
      async findUnique(args: {
        where: {
          integrationCompanyMappingId_externalId: {
            integrationCompanyMappingId: string;
            externalId: string;
          };
        };
      }) {
        const k = args.where.integrationCompanyMappingId_externalId;
        const hit = syncRecords.find(
          (r) =>
            r.integrationCompanyMappingId === k.integrationCompanyMappingId &&
            r.externalId === k.externalId,
        );
        return hit ? { assetId: hit.assetId } : null;
      },
    },
    asset: {
      async findFirst(args: {
        where: {
          companyId: string;
          externalId: string;
          externalSource: string;
          archivedAt: null;
        };
      }) {
        const w = args.where;
        const hit = assets.find(
          (a) =>
            a.companyId === w.companyId &&
            a.externalId === w.externalId &&
            a.externalSource === w.externalSource &&
            a.archivedAt === null,
        );
        return hit ? { id: hit.id } : null;
      },
    },
    assetField: {
      async findMany(args: { where: { id: { in: string[] } } }) {
        return fields.filter((f) => args.where.id.in.includes(f.id));
      },
    },
    assetFieldValue: {
      async findMany(args: {
        where: {
          companyId: string;
          assetFieldId: string;
          OR: Array<{ value: { equals: unknown } }>;
          asset: {
            archivedAt: null;
            integrationSyncRecord: { is: null };
            OR: Array<{
              externalSource: string | null;
              externalId?: string | null;
            }>;
          };
        };
      }) {
        const w = args.where;
        const variants = w.OR.map((c) => c.value.equals);
        const eligibleAssetIds = new Set(
          assets
            .filter((a) => {
              if (a.archivedAt !== null) return false;
              if (a.hasSyncRecord) return false;
              return w.asset.OR.some((branch) => {
                if (branch.externalSource === null) {
                  return a.externalSource === null;
                }
                return (
                  a.externalSource === branch.externalSource &&
                  ('externalId' in branch
                    ? a.externalId === (branch.externalId ?? null)
                    : true)
                );
              });
            })
            .map((a) => a.id),
        );

        return values
          .filter(
            (v) =>
              v.companyId === w.companyId &&
              v.assetFieldId === w.assetFieldId &&
              eligibleAssetIds.has(v.assetId) &&
              valueMatches(v.value, variants),
          )
          .map((v) => ({ assetId: v.assetId }));
      },
    },
  };
}

function makeService(seed: Parameters<typeof makeStubPrisma>[0]) {
  const prisma = makeStubPrisma(seed);
  const fieldTypes = new FieldTypesRegistry();
  return new MatchResolverService(
    prisma as never,
    fieldTypes,
  );
}

const FIELD_HOSTNAME = {
  id: 'fid-host',
  slug: 'hostname',
  fieldType: 'TEXT',
  options: {},
};
const FIELD_SERIAL = {
  id: 'fid-serial',
  slug: 'serial',
  fieldType: 'TEXT',
  options: {},
};
const FIELD_TAG_NUMBER = {
  id: 'fid-tag',
  slug: 'tag_number',
  fieldType: 'NUMBER',
  options: {},
};

describe('MatchResolverService.resolve', () => {
  it('returns reuse when an IntegrationSyncRecord already binds this externalId', async () => {
    const svc = makeService({
      syncRecords: [
        {
          integrationCompanyMappingId: 'icm-1',
          externalId: 'ext-1',
          assetId: 'asset-A',
        },
      ],
    });
    const out = await svc.resolve({
      companyId: 'c-1',
      integrationCompanyMappingId: 'icm-1',
      integrationDriver: 'action1',
      externalId: 'ext-1',
      source: { hostname: 'host01' },
      fieldMappings: [
        { sourceField: 'hostname', targetField: FIELD_HOSTNAME },
      ],
      matchKeyFieldIds: ['fid-host'],
    });
    expect(out).toEqual({ kind: 'reuse', assetId: 'asset-A' });
  });

  it('returns reuse when an asset already carries the externalSource/externalId', async () => {
    const svc = makeService({
      assets: [
        {
          id: 'asset-B',
          companyId: 'c-1',
          externalSource: 'action1',
          externalId: 'ext-2',
          archivedAt: null,
          hasSyncRecord: false,
        },
      ],
    });
    const out = await svc.resolve({
      companyId: 'c-1',
      integrationCompanyMappingId: 'icm-1',
      integrationDriver: 'action1',
      externalId: 'ext-2',
      source: {},
      fieldMappings: [],
      matchKeyFieldIds: [],
    });
    expect(out).toEqual({ kind: 'reuse', assetId: 'asset-B' });
  });

  it('returns create when no match keys are configured and nothing is linked', async () => {
    const svc = makeService({});
    const out = await svc.resolve({
      companyId: 'c-1',
      integrationCompanyMappingId: 'icm-1',
      integrationDriver: 'action1',
      externalId: 'ext-3',
      source: { hostname: 'newhost' },
      fieldMappings: [
        { sourceField: 'hostname', targetField: FIELD_HOSTNAME },
      ],
      matchKeyFieldIds: [],
    });
    expect(out).toEqual({ kind: 'create' });
  });

  it('claims a single unclaimed asset matching by hostname (case-insensitive)', async () => {
    const svc = makeService({
      assetFields: [{ id: 'fid-host', fieldType: 'TEXT' }],
      assets: [
        {
          id: 'asset-C',
          companyId: 'c-1',
          externalSource: null,
          externalId: null,
          archivedAt: null,
          hasSyncRecord: false,
        },
      ],
      values: [
        {
          companyId: 'c-1',
          assetId: 'asset-C',
          assetFieldId: 'fid-host',
          value: 'host01.lan',
        },
      ],
    });
    const out = await svc.resolve({
      companyId: 'c-1',
      integrationCompanyMappingId: 'icm-1',
      integrationDriver: 'action1',
      externalId: 'ext-4',
      source: { hostname: 'HOST01.LAN' },
      fieldMappings: [
        { sourceField: 'hostname', targetField: FIELD_HOSTNAME },
      ],
      matchKeyFieldIds: ['fid-host'],
    });
    expect(out).toEqual({ kind: 'claim', assetId: 'asset-C' });
  });

  it('returns ambiguous when two unclaimed assets share the same match-key value', async () => {
    const svc = makeService({
      assetFields: [{ id: 'fid-host', fieldType: 'TEXT' }],
      assets: [
        {
          id: 'asset-D',
          companyId: 'c-1',
          externalSource: null,
          externalId: null,
          archivedAt: null,
          hasSyncRecord: false,
        },
        {
          id: 'asset-E',
          companyId: 'c-1',
          externalSource: null,
          externalId: null,
          archivedAt: null,
          hasSyncRecord: false,
        },
      ],
      values: [
        {
          companyId: 'c-1',
          assetId: 'asset-D',
          assetFieldId: 'fid-host',
          value: 'shared.lan',
        },
        {
          companyId: 'c-1',
          assetId: 'asset-E',
          assetFieldId: 'fid-host',
          value: 'SHARED.LAN',
        },
      ],
    });
    const out = await svc.resolve({
      companyId: 'c-1',
      integrationCompanyMappingId: 'icm-1',
      integrationDriver: 'action1',
      externalId: 'ext-5',
      source: { hostname: 'shared.lan' },
      fieldMappings: [
        { sourceField: 'hostname', targetField: FIELD_HOSTNAME },
      ],
      matchKeyFieldIds: ['fid-host'],
    });
    expect(out.kind).toBe('ambiguous');
    if (out.kind === 'ambiguous') {
      expect(out.candidateAssetIds.sort()).toEqual(['asset-D', 'asset-E']);
    }
  });

  it('skips assets already pinned to a different IntegrationSyncRecord', async () => {
    const svc = makeService({
      assetFields: [{ id: 'fid-host', fieldType: 'TEXT' }],
      assets: [
        {
          id: 'asset-F',
          companyId: 'c-1',
          externalSource: 'action1',
          externalId: 'ext-other',
          archivedAt: null,
          hasSyncRecord: true,
        },
      ],
      values: [
        {
          companyId: 'c-1',
          assetId: 'asset-F',
          assetFieldId: 'fid-host',
          value: 'host01.lan',
        },
      ],
    });
    const out = await svc.resolve({
      companyId: 'c-1',
      integrationCompanyMappingId: 'icm-1',
      integrationDriver: 'action1',
      externalId: 'ext-6',
      source: { hostname: 'host01.lan' },
      fieldMappings: [
        { sourceField: 'hostname', targetField: FIELD_HOSTNAME },
      ],
      matchKeyFieldIds: ['fid-host'],
    });
    expect(out).toEqual({ kind: 'create' });
  });

  it('intersects when multiple match-keys are configured', async () => {
    const svc = makeService({
      assetFields: [
        { id: 'fid-host', fieldType: 'TEXT' },
        { id: 'fid-serial', fieldType: 'TEXT' },
      ],
      assets: [
        {
          id: 'asset-G',
          companyId: 'c-1',
          externalSource: null,
          externalId: null,
          archivedAt: null,
          hasSyncRecord: false,
        },
        {
          id: 'asset-H',
          companyId: 'c-1',
          externalSource: null,
          externalId: null,
          archivedAt: null,
          hasSyncRecord: false,
        },
      ],
      values: [
        // asset-G: matches both hostname AND serial
        {
          companyId: 'c-1',
          assetId: 'asset-G',
          assetFieldId: 'fid-host',
          value: 'host01.lan',
        },
        {
          companyId: 'c-1',
          assetId: 'asset-G',
          assetFieldId: 'fid-serial',
          value: 'SN-1234',
        },
        // asset-H: matches hostname only
        {
          companyId: 'c-1',
          assetId: 'asset-H',
          assetFieldId: 'fid-host',
          value: 'host01.lan',
        },
        {
          companyId: 'c-1',
          assetId: 'asset-H',
          assetFieldId: 'fid-serial',
          value: 'SN-9999',
        },
      ],
    });
    const out = await svc.resolve({
      companyId: 'c-1',
      integrationCompanyMappingId: 'icm-1',
      integrationDriver: 'action1',
      externalId: 'ext-7',
      source: { hostname: 'host01.lan', serial: 'SN-1234' },
      fieldMappings: [
        { sourceField: 'hostname', targetField: FIELD_HOSTNAME },
        { sourceField: 'serial', targetField: FIELD_SERIAL },
      ],
      matchKeyFieldIds: ['fid-host', 'fid-serial'],
    });
    expect(out).toEqual({ kind: 'claim', assetId: 'asset-G' });
  });

  it('uses strict equality for non-string match keys (NUMBER)', async () => {
    const svc = makeService({
      assetFields: [{ id: 'fid-tag', fieldType: 'NUMBER' }],
      assets: [
        {
          id: 'asset-I',
          companyId: 'c-1',
          externalSource: null,
          externalId: null,
          archivedAt: null,
          hasSyncRecord: false,
        },
      ],
      values: [
        {
          companyId: 'c-1',
          assetId: 'asset-I',
          assetFieldId: 'fid-tag',
          value: 42,
        },
      ],
    });

    const hit = await svc.resolve({
      companyId: 'c-1',
      integrationCompanyMappingId: 'icm-1',
      integrationDriver: 'action1',
      externalId: 'ext-8',
      source: { tag_number: '42' },
      fieldMappings: [
        { sourceField: 'tag_number', targetField: FIELD_TAG_NUMBER },
      ],
      matchKeyFieldIds: ['fid-tag'],
    });
    expect(hit).toEqual({ kind: 'claim', assetId: 'asset-I' });

    const miss = await svc.resolve({
      companyId: 'c-1',
      integrationCompanyMappingId: 'icm-1',
      integrationDriver: 'action1',
      externalId: 'ext-9',
      source: { tag_number: '43' },
      fieldMappings: [
        { sourceField: 'tag_number', targetField: FIELD_TAG_NUMBER },
      ],
      matchKeyFieldIds: ['fid-tag'],
    });
    expect(miss).toEqual({ kind: 'create' });
  });

  it('skips empty source values when projecting match-key fields', async () => {
    const svc = makeService({
      assetFields: [{ id: 'fid-host', fieldType: 'TEXT' }],
    });
    const out = await svc.resolve({
      companyId: 'c-1',
      integrationCompanyMappingId: 'icm-1',
      integrationDriver: 'action1',
      externalId: 'ext-10',
      source: { hostname: '' },
      fieldMappings: [
        { sourceField: 'hostname', targetField: FIELD_HOSTNAME },
      ],
      matchKeyFieldIds: ['fid-host'],
    });
    expect(out).toEqual({ kind: 'create' });
  });
});
