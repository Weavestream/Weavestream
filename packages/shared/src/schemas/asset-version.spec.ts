import {
  ASSET_VERSION_IDENTITY_FIELDS,
  ASSET_VERSION_RESTORABLE_TOKENS,
  assetVersionDetailSchema,
  assetVersionListQuerySchema,
  assetVersionListSchema,
  redactAssetVersionsSchema,
  restoreAssetVersionSchema,
} from './asset-version.js';

const FIELD_A = '11111111-1111-4111-8111-111111111111';
const FIELD_B = '22222222-2222-4222-8222-222222222222';

describe('restoreAssetVersionSchema', () => {
  it('defaults an absent body to a whole-version restore (no fields)', () => {
    expect(restoreAssetVersionSchema.parse(undefined)).toEqual({});
    expect(restoreAssetVersionSchema.parse({}).fields).toBeUndefined();
  });

  it('accepts field ids and the name token and de-duplicates', () => {
    expect(
      restoreAssetVersionSchema.parse({ fields: [FIELD_A, FIELD_A, 'name', FIELD_B] }).fields,
    ).toEqual([FIELD_A, 'name', FIELD_B]);
    expect(ASSET_VERSION_IDENTITY_FIELDS).toEqual(['name', 'externalId', 'externalSource']);
    expect(ASSET_VERSION_RESTORABLE_TOKENS).toEqual(['name']);
  });

  it('never allows restoring the external identity (sync binding) from history', () => {
    expect(restoreAssetVersionSchema.safeParse({ fields: ['externalId'] }).success).toBe(false);
    expect(restoreAssetVersionSchema.safeParse({ fields: ['externalSource'] }).success).toBe(false);
  });

  it('rejects slugs, free text, an empty list, oversize lists and extra keys', () => {
    expect(restoreAssetVersionSchema.safeParse({ fields: ['hostname'] }).success).toBe(false);
    expect(restoreAssetVersionSchema.safeParse({ fields: [] }).success).toBe(false);
    expect(restoreAssetVersionSchema.safeParse({ fields: [FIELD_A], x: 1 }).success).toBe(false);
    const many = Array.from(
      { length: 201 },
      (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
    );
    expect(restoreAssetVersionSchema.safeParse({ fields: many }).success).toBe(false);
  });
});

describe('assetVersionListSchema', () => {
  it('parses a lightweight list with a system-authored version and no values', () => {
    const parsed = assetVersionListSchema.parse({
      fields: [{ id: FIELD_A, name: 'Hostname', fieldType: 'TEXT', options: {} }],
      items: [
        {
          version: 2,
          changedFields: [FIELD_A],
          changedBy: null,
          changedByName: null,
          changeReason: 'integration sync',
          createdAt: '2026-01-02T00:00:00.000Z',
          redacted: false,
        },
      ],
      nextCursor: null,
    });
    expect(parsed.items[0]).not.toHaveProperty('values');
  });
});

describe('assetVersionListQuerySchema', () => {
  it('defaults the limit and coerces query strings', () => {
    expect(assetVersionListQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(assetVersionListQuerySchema.parse({ limit: '5', cursor: '7' })).toEqual({
      limit: 5,
      cursor: 7,
    });
  });

  it('rejects out-of-range, non-numeric and unknown parameters', () => {
    expect(assetVersionListQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(assetVersionListQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(assetVersionListQuerySchema.safeParse({ cursor: 'abc' }).success).toBe(false);
    expect(assetVersionListQuerySchema.safeParse({ cursor: '0' }).success).toBe(false);
    expect(assetVersionListQuerySchema.safeParse({ q: 'x' }).success).toBe(false);
  });
});

describe('assetVersionDetailSchema', () => {
  it('parses values, redaction markers and a previous state', () => {
    const parsed = assetVersionDetailSchema.parse({
      version: 3,
      changedFields: ['name'],
      changedBy: null,
      changedByName: null,
      changeReason: null,
      createdAt: '2026-01-02T00:00:00.000Z',
      redacted: true,
      name: 'Edge',
      externalId: null,
      externalSource: null,
      values: { [FIELD_A]: 'x' },
      redactedFields: [FIELD_B],
      previous: { name: 'Old', values: {}, redactedFields: [] },
    });
    expect(parsed.previous?.name).toBe('Old');
  });
});

describe('redactAssetVersionsSchema', () => {
  it('accepts a field id, a version, or both', () => {
    expect(redactAssetVersionsSchema.safeParse({ fieldId: FIELD_A }).success).toBe(true);
    expect(redactAssetVersionsSchema.safeParse({ version: 2 }).success).toBe(true);
    expect(redactAssetVersionsSchema.safeParse({ fieldId: FIELD_A, version: 2 }).success).toBe(true);
  });

  it('requires at least one, a uuid, a positive int, and rejects extra keys', () => {
    expect(redactAssetVersionsSchema.safeParse({}).success).toBe(false);
    expect(redactAssetVersionsSchema.safeParse({ fieldId: 'hostname' }).success).toBe(false);
    expect(redactAssetVersionsSchema.safeParse({ version: 0 }).success).toBe(false);
    expect(redactAssetVersionsSchema.safeParse({ version: 1.5 }).success).toBe(false);
    expect(redactAssetVersionsSchema.safeParse({ version: 1, x: 1 }).success).toBe(false);
  });
});
