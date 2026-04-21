import { FieldTypesRegistry } from '../field-types/field-types.registry.js';
import { SearchIndexService } from './search-index.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Unit tests for the pure helper `buildAssetBodies`. We don't touch
 * Postgres — the invariant we care about is the visibility split:
 *
 *   body_public   — only fields with `visibleToClients = true`
 *   body_internal — every searchable, non-archived field
 *
 * Archived fields and non-searchable field types (FILE, ASSET_REFERENCE,
 * VAULTWARDEN_LINK) must appear in neither body. Strategies pull their
 * real `searchable` flag from the production registry, so any future
 * type added without the flag gets caught here automatically.
 */
describe('SearchIndexService.buildAssetBodies', () => {
  const registry = new FieldTypesRegistry();
  const svc = new SearchIndexService(
    {} as unknown as PrismaService,
    registry,
  );

  function field(overrides: {
    id: string;
    slug: string;
    fieldType: string;
    visibleToClients?: boolean;
    archivedAt?: Date | null;
    options?: unknown;
  }) {
    return {
      visibleToClients: true,
      archivedAt: null,
      options: {},
      ...overrides,
    };
  }

  it('separates public and internal bodies by visibleToClients', () => {
    const asset = {
      name: 'Acme firewall',
      assetLayout: {
        fields: [
          field({ id: 'f1', slug: 'hostname', fieldType: 'TEXT', visibleToClients: true }),
          field({ id: 'f2', slug: 'admin_pass', fieldType: 'TEXT', visibleToClients: false }),
        ],
      },
      fieldValues: [
        { assetFieldId: 'f1', value: 'fw01.example.com' },
        { assetFieldId: 'f2', value: 'SecretHostPassword' },
      ],
    };
    const result = svc.buildAssetBodies(asset);
    expect(result.title).toBe('Acme firewall');
    expect(result.bodyPublic).toContain('fw01.example.com');
    expect(result.bodyPublic).not.toContain('SecretHostPassword');
    expect(result.bodyInternal).toContain('fw01.example.com');
    expect(result.bodyInternal).toContain('SecretHostPassword');
  });

  it('excludes archived fields from both bodies', () => {
    const asset = {
      name: 'Old router',
      assetLayout: {
        fields: [
          field({ id: 'f1', slug: 'hostname', fieldType: 'TEXT' }),
          field({
            id: 'f2',
            slug: 'serial',
            fieldType: 'TEXT',
            archivedAt: new Date('2024-01-01'),
          }),
        ],
      },
      fieldValues: [
        { assetFieldId: 'f1', value: 'rtr01' },
        { assetFieldId: 'f2', value: 'SN-VALUE-SHOULD-NOT-APPEAR' },
      ],
    };
    const result = svc.buildAssetBodies(asset);
    expect(result.bodyPublic).toContain('rtr01');
    expect(result.bodyInternal).toContain('rtr01');
    expect(result.bodyPublic).not.toContain('SN-VALUE-SHOULD-NOT-APPEAR');
    expect(result.bodyInternal).not.toContain('SN-VALUE-SHOULD-NOT-APPEAR');
  });

  it('excludes non-searchable field types (FILE, ASSET_REFERENCE, VAULTWARDEN_LINK)', () => {
    const asset = {
      name: 'Docs host',
      assetLayout: {
        fields: [
          field({ id: 'f1', slug: 'hostname', fieldType: 'TEXT' }),
          field({ id: 'f2', slug: 'attachment', fieldType: 'FILE' }),
          field({ id: 'f3', slug: 'parent', fieldType: 'ASSET_REFERENCE' }),
          field({ id: 'f4', slug: 'vault', fieldType: 'VAULTWARDEN_LINK' }),
        ],
      },
      fieldValues: [
        { assetFieldId: 'f1', value: 'docshost' },
        { assetFieldId: 'f2', value: { uploadId: 'abcd' } },
        { assetFieldId: 'f3', value: 'parent-asset-id' },
        { assetFieldId: 'f4', value: 'https://vault/item' },
      ],
    };
    const result = svc.buildAssetBodies(asset);
    expect(result.bodyPublic).toContain('docshost');
    expect(result.bodyInternal).toContain('docshost');
    expect(result.bodyPublic).not.toMatch(/abcd|parent-asset-id|vault\/item/);
    expect(result.bodyInternal).not.toMatch(/abcd|parent-asset-id|vault\/item/);
  });

  it('renders choice labels, not raw slugs', () => {
    const asset = {
      name: 'Laptop',
      assetLayout: {
        fields: [
          field({
            id: 'f1',
            slug: 'status',
            fieldType: 'DROPDOWN',
            options: {
              choices: [
                { slug: 'active', label: 'Active' },
                { slug: 'retired', label: 'Retired' },
              ],
            },
          }),
        ],
      },
      fieldValues: [{ assetFieldId: 'f1', value: 'active' }],
    };
    const result = svc.buildAssetBodies(asset);
    expect(result.bodyPublic).toContain('Active');
    expect(result.bodyInternal).toContain('Active');
  });

  it('ignores unknown field types without throwing', () => {
    const asset = {
      name: 'Weird asset',
      assetLayout: {
        fields: [
          field({ id: 'f1', slug: 'hostname', fieldType: 'TEXT' }),
          field({ id: 'f2', slug: 'mystery', fieldType: 'TOTALLY_INVALID_TYPE' }),
        ],
      },
      fieldValues: [
        { assetFieldId: 'f1', value: 'x' },
        { assetFieldId: 'f2', value: 'should-not-appear' },
      ],
    };
    const result = svc.buildAssetBodies(asset);
    expect(result.bodyInternal).toContain('x');
    expect(result.bodyInternal).not.toContain('should-not-appear');
  });

  it('returns empty bodies for an asset with no searchable content', () => {
    const asset = {
      name: '',
      assetLayout: { fields: [] },
      fieldValues: [],
    };
    const result = svc.buildAssetBodies(asset);
    expect(result.title).toBe('');
    expect(result.bodyPublic).toBe('');
    expect(result.bodyInternal).toBe('');
  });
});
