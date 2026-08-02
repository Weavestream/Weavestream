import type { AssetField } from '@prisma/client';
import { FieldTypesRegistry } from '../field-types/field-types.registry.js';
import { buildAssetZodSchema } from './build-asset-schema.js';

/**
 * The dynamic Zod schema is rebuilt on every request so layout edits
 * take effect without cache invalidation. These tests pin down the
 * contract the AssetsService relies on: required fields must refuse
 * empty values on write, unknown slugs must be rejected, and
 * CLIENT_USER writes must strip invisible fields before validation.
 */

function field(partial: Partial<AssetField>): AssetField {
  return {
    id: partial.id ?? 'f-' + Math.random().toString(36).slice(2, 8),
    assetLayoutId: partial.assetLayoutId ?? 'layout-1',
    name: partial.name ?? 'Field',
    slug: partial.slug ?? 'field',
    fieldType: partial.fieldType ?? 'TEXT',
    position: partial.position ?? 0,
    isRequired: partial.isRequired ?? false,
    isUniquePerCompany: partial.isUniquePerCompany ?? false,
    visibleToClients: partial.visibleToClients ?? true,
    isPrimary: partial.isPrimary ?? false,
    options: (partial.options ?? {}) as AssetField['options'],
    archivedAt: partial.archivedAt ?? null,
    createdAt: partial.createdAt ?? new Date(),
    updatedAt: partial.updatedAt ?? new Date(),
  } as AssetField;
}

describe('buildAssetZodSchema', () => {
  const registry = new FieldTypesRegistry();

  it('rejects unknown slugs via strict()', () => {
    const fields = [field({ slug: 'hostname', fieldType: 'TEXT' })];
    const schema = buildAssetZodSchema(fields, registry, { mode: 'write' });
    const res = schema.safeParse({ hostname: 'ok', bogus: 'x' });
    expect(res.success).toBe(false);
  });

  it('enforces required fields on write but not on update', () => {
    const fields = [
      field({ slug: 'hostname', fieldType: 'TEXT', isRequired: true, isPrimary: true }),
    ];

    const writeSchema = buildAssetZodSchema(fields, registry, { mode: 'write' });
    expect(writeSchema.safeParse({ hostname: '' }).success).toBe(false);
    expect(writeSchema.safeParse({ hostname: 'host-1' }).success).toBe(true);

    const updateSchema = buildAssetZodSchema(fields, registry, { mode: 'update' });
    expect(updateSchema.safeParse({}).success).toBe(true);
    expect(updateSchema.safeParse({ hostname: null }).success).toBe(true);
  });

  it('skips archived fields entirely', () => {
    const fields = [
      field({ slug: 'live', fieldType: 'TEXT' }),
      field({ slug: 'dead', fieldType: 'TEXT', archivedAt: new Date() }),
    ];
    const schema = buildAssetZodSchema(fields, registry, { mode: 'write' });
    // archived slug is unknown → strict() rejects.
    expect(schema.safeParse({ live: 'ok', dead: 'x' }).success).toBe(false);
    expect(schema.safeParse({ live: 'ok' }).success).toBe(true);
  });

  it('drops CLIENT_USER-invisible fields from the shape', () => {
    const fields = [
      field({ slug: 'shared', fieldType: 'TEXT', visibleToClients: true }),
      field({
        slug: 'internal',
        fieldType: 'TEXT',
        visibleToClients: false,
        isRequired: true,
      }),
    ];
    const schema = buildAssetZodSchema(fields, registry, {
      mode: 'write',
      role: 'CLIENT_USER',
    });
    // `internal` is not in the shape at all for CLIENT_USER, so
    // omitting it is fine; including it gets rejected by strict().
    expect(schema.safeParse({ shared: 'ok' }).success).toBe(true);
    expect(schema.safeParse({ shared: 'ok', internal: 'x' }).success).toBe(false);
  });

  it('propagates per-type validation (EMAIL, NUMBER)', () => {
    const fields = [
      field({ slug: 'email', fieldType: 'EMAIL', isRequired: true }),
      field({ slug: 'count', fieldType: 'NUMBER' }),
    ];
    const schema = buildAssetZodSchema(fields, registry, { mode: 'write' });
    expect(schema.safeParse({ email: 'nope' }).success).toBe(false);
    expect(schema.safeParse({ email: 'ok@example.com', count: 4 }).success).toBe(true);
    expect(schema.safeParse({ email: 'ok@example.com', count: 'x' }).success).toBe(false);
  });

  it('accepts only well-formed HTTP(S) values for URL fields', () => {
    const fields = [field({ slug: 'admin_url', fieldType: 'URL' })];
    const schema = buildAssetZodSchema(fields, registry, { mode: 'write' });

    expect(schema.safeParse({ admin_url: 'https://router.example/admin' }).success).toBe(true);
    expect(schema.safeParse({ admin_url: 'http://10.0.0.1:8080' }).success).toBe(true);
    expect(schema.safeParse({ admin_url: null }).success).toBe(true);

    for (const admin_url of [
      'router.example',
      'https://',
      'javascript:alert(1)',
      'data:text/html,hello',
      'file:///etc/passwd',
    ]) {
      expect(schema.safeParse({ admin_url }).success).toBe(false);
    }
  });
});
