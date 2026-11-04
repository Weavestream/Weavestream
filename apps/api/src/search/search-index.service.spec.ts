import { FieldTypesRegistry } from '../field-types/field-types.registry.js';
import { SearchIndexService } from './search-index.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { TenantContext } from '@weavestream/shared';
import { getTenantContext, runWithTenantContext } from '@weavestream/shared/server';
import { assertTenantScope, TenantScopeViolationError } from '../prisma/tenant-scoped-models.js';

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

/**
 * Issue #109: `upsertAsset` runs inside every asset write transaction.
 * A read without a `companyId` filter passes the tenant middleware only
 * for callers with a read bypass (SUPER_ADMIN, globalAccess FULL or
 * READONLY), so an operator pinned to their memberships got a 500 on
 * every asset create and update. The fake client runs the real guard
 * on each model call, so any unscoped read here fails the test.
 */
describe('SearchIndexService.upsertAsset tenant scope', () => {
  const COMPANY = '2ba00000-0000-4000-8000-00000000c109';
  const OTHER_COMPANY = '2ba00000-0000-4000-8000-00000000c110';
  const ASSET = '2ba00000-0000-4000-8000-00000000a109';

  function operator(allowedCompanyIds: string[]): TenantContext {
    return {
      userId: 'u-109',
      role: 'OPERATOR',
      email: 'operator@example.test',
      allowedCompanyIds,
      isSuperAdmin: false,
      globalAccess: 'NONE',
      requestId: 'req-109',
      ip: '127.0.0.1',
      userAgent: 'jest',
    };
  }

  function guardedClient(ctx: TenantContext) {
    const asset = new Proxy(
      {},
      {
        get: (_t, action: string) => async (args: Record<string, unknown>) => {
          assertTenantScope({ model: 'Asset', action, args }, ctx);
          return null;
        },
      },
    );
    return { asset, $executeRaw: jest.fn() } as unknown as PrismaService;
  }

  const svc = new SearchIndexService({} as unknown as PrismaService, new FieldTypesRegistry());

  it('scopes the asset read so a company-only operator passes the guard', async () => {
    const client = guardedClient(operator([COMPANY]));
    await expect(svc.upsertAsset(client, ASSET, COMPANY)).resolves.toBeUndefined();
  });

  it('still rejects a company outside the operator scope', async () => {
    const client = guardedClient(operator([OTHER_COMPANY]));
    await expect(svc.upsertAsset(client, ASSET, COMPANY)).rejects.toBeInstanceOf(
      TenantScopeViolationError,
    );
  });
});

/**
 * `reindexLayout` runs after a layout change by a `LAYOUT_MANAGE`
 * holder, who may have no membership at all. Layouts are global, so the
 * reads must run in an explicit all-company scope. The fake client runs
 * the real guard under whatever tenant context is active.
 */
describe('SearchIndexService.reindexLayout tenant scope', () => {
  const LAYOUT = '2ba00000-0000-4000-8000-00000000f109';
  const COMPANIES = ['2ba00000-0000-4000-8000-00000000c201', '2ba00000-0000-4000-8000-00000000c202'];

  function guarded(model: string) {
    return new Proxy(
      {},
      {
        get: (_t, action: string) => async (args: Record<string, unknown>) => {
          const ctx = getTenantContext();
          if (ctx) assertTenantScope({ model, action, args }, ctx);
          if (model === 'Company') return COMPANIES.map((id) => ({ id }));
          if (action === 'findMany') {
            return COMPANIES.map((companyId, i) => ({ id: `a-${i}`, companyId }));
          }
          return null;
        },
      },
    );
  }

  it('rebuilds every company for a layout manager with no membership', async () => {
    const prisma = {
      company: guarded('Company'),
      asset: guarded('Asset'),
      $executeRaw: jest.fn(),
    } as unknown as PrismaService;
    const svc = new SearchIndexService(prisma, new FieldTypesRegistry());
    const ctx: TenantContext = {
      userId: 'u-layout',
      role: 'OPERATOR',
      email: 'layouts@example.test',
      allowedCompanyIds: [],
      isSuperAdmin: false,
      globalAccess: 'NONE',
      requestId: 'req-layout',
      ip: '127.0.0.1',
      userAgent: 'jest',
    };

    await expect(runWithTenantContext(ctx, () => svc.reindexLayout(LAYOUT))).resolves.toBe(2);
  });
});
