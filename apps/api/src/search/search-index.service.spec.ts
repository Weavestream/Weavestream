import { FieldTypesRegistry } from '../field-types/field-types.registry.js';
import { SearchIndexService } from './search-index.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '@prisma/client';
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
 * Archived fields and non-searchable field types (BOOLEAN,
 * ASSET_REFERENCE, VAULTWARDEN_LINK) must appear in neither body. Strategies pull their
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

  it('excludes non-searchable field types (BOOLEAN, ASSET_REFERENCE, VAULTWARDEN_LINK)', () => {
    const asset = {
      name: 'Docs host',
      assetLayout: {
        fields: [
          field({ id: 'f1', slug: 'hostname', fieldType: 'TEXT' }),
          field({ id: 'f2', slug: 'managed', fieldType: 'BOOLEAN' }),
          field({ id: 'f3', slug: 'parent', fieldType: 'ASSET_REFERENCE' }),
          field({ id: 'f4', slug: 'vault', fieldType: 'VAULTWARDEN_LINK' }),
        ],
      },
      fieldValues: [
        { assetFieldId: 'f1', value: 'docshost' },
        { assetFieldId: 'f2', value: true },
        { assetFieldId: 'f3', value: ['parent-asset-id'] },
        { assetFieldId: 'f4', value: 'https://vault/item' },
      ],
    };
    const result = svc.buildAssetBodies(asset);
    expect(result.bodyPublic).toContain('docshost');
    expect(result.bodyInternal).toContain('docshost');
    expect(result.bodyPublic).not.toMatch(/yes|parent-asset-id|vault\/item/);
    expect(result.bodyInternal).not.toMatch(/yes|parent-asset-id|vault\/item/);
  });

  it('indexes NUMBER, DATE, DATETIME and FILE names', () => {
    const asset = {
      name: 'Server',
      assetLayout: {
        fields: [
          field({ id: 'f1', slug: 'serial', fieldType: 'NUMBER' }),
          field({ id: 'f2', slug: 'warranty', fieldType: 'DATE' }),
          field({ id: 'f3', slug: 'seen', fieldType: 'DATETIME' }),
          field({ id: 'f4', slug: 'docs', fieldType: 'FILE' }),
        ],
      },
      fieldValues: [
        { assetFieldId: 'f1', value: 1234567 },
        { assetFieldId: 'f2', value: '2026-03-14' },
        { assetFieldId: 'f3', value: '2026-04-01T08:30:00Z' },
        { assetFieldId: 'f4', value: [{ uploadId: 'u1', filename: 'invoice-778.pdf' }] },
      ],
    };
    const result = svc.buildAssetBodies(asset);
    for (const text of ['1234567', '2026-03-14', '2026-04-01T08:30:00Z', 'invoice-778.pdf']) {
      expect(result.bodyInternal).toContain(text);
      expect(result.bodyPublic).toContain(text);
    }
  });

  it('indexes TAGS by resolved name, drops unknown ids, and keeps hidden tags out of bodyPublic', () => {
    const asset = {
      name: 'Switch',
      assetLayout: {
        fields: [
          field({ id: 'f1', slug: 'tags', fieldType: 'TAGS' }),
          field({ id: 'f2', slug: 'internal_tags', fieldType: 'TAGS', visibleToClients: false }),
          field({ id: 'f3', slug: 'count', fieldType: 'NUMBER', visibleToClients: false }),
        ],
      },
      fieldValues: [
        { assetFieldId: 'f1', value: ['t-1', 't-missing', 'production'] },
        { assetFieldId: 'f2', value: ['t-2'] },
        { assetFieldId: 'f3', value: 42 },
      ],
    };
    const tagNames = new Map([
      ['t-1', 'Core network'],
      ['t-2', 'Decommission soon'],
    ]);
    const result = svc.buildAssetBodies(asset, tagNames);
    expect(result.bodyInternal).toContain('Core network');
    expect(result.bodyInternal).toContain('Decommission soon');
    expect(result.bodyInternal).toContain('42');
    expect(result.bodyPublic).toContain('Core network');
    expect(result.bodyPublic).not.toContain('Decommission soon');
    expect(result.bodyPublic).not.toContain('42');
    expect(result.bodyInternal).not.toMatch(/t-missing|production|t-1/);
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
    return { asset, $queryRaw: jest.fn(), $executeRaw: jest.fn() } as unknown as Prisma.TransactionClient;
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
    const prisma: Record<string, unknown> = {
      company: guarded('Company'),
      asset: guarded('Asset'),
      $queryRaw: jest.fn(),
      $executeRaw: jest.fn(),
    };
    prisma['$transaction'] = (fn: (tx: unknown) => Promise<unknown>) => fn(prisma);
    const svc = new SearchIndexService(prisma as unknown as PrismaService, new FieldTypesRegistry());
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

/** The SQL text of one tagged-template raw call. */
function rawSql(call: unknown[]): string {
  return (call[0] as TemplateStringsArray).join('?').replace(/\s+/g, ' ');
}

/**
 * `upsertAsset` locks the asset row before any read, so 2 rebuilds of
 * one asset never interleave (a stale backfill cannot write hidden field
 * text back into `body_public`), and it resolves TAGS ids to names on
 * the caller's transaction while dropping legacy non-UUID values.
 */
describe('SearchIndexService.upsertAsset', () => {
  const COMPANY = '2ba00000-0000-4000-8000-00000000c301';
  const ASSET = '2ba00000-0000-4000-8000-00000000a301';
  const TAG = '2ba00000-0000-4000-8000-00000000e301';

  function client(tagsValue: unknown) {
    const calls: string[] = [];
    const tx = {
      $queryRaw: jest.fn((...args: unknown[]) => {
        calls.push(`queryRaw:${rawSql(args)}`);
        return Promise.resolve([]);
      }),
      $executeRaw: jest.fn((..._args: unknown[]) => {
        calls.push('executeRaw');
        return Promise.resolve(1);
      }),
      asset: {
        findFirst: jest.fn(() => {
          calls.push('asset.findFirst');
          return Promise.resolve({
            id: ASSET,
            companyId: COMPANY,
            name: 'Edge switch',
            assetLayoutId: 'layout-1',
            archivedAt: null,
            updatedAt: new Date('2026-01-01'),
            assetLayout: {
              fields: [
                { id: 'f1', slug: 'tags', fieldType: 'TAGS', visibleToClients: true, archivedAt: null, options: {} },
                { id: 'f2', slug: 'serial', fieldType: 'TEXT', visibleToClients: true, archivedAt: null, options: {} },
              ],
            },
            fieldValues: [
              { assetFieldId: 'f1', value: tagsValue },
              { assetFieldId: 'f2', value: 'SN-301' },
            ],
          });
        }),
      },
      tag: {
        findMany: jest.fn(() => Promise.resolve([{ id: TAG, name: 'Core network' }])),
      },
    };
    return { tx, calls };
  }

  const svc = new SearchIndexService({} as unknown as PrismaService, new FieldTypesRegistry());

  /** Bound values of the INSERT: [type?, id, company, title, bodyPublic, bodyInternal, ...]. */
  const insertValues = (tx: ReturnType<typeof client>['tx']) =>
    tx.$executeRaw.mock.calls[0]!.slice(1) as unknown[];

  it('locks the asset row FOR UPDATE before it reads anything', async () => {
    const { tx, calls } = client([TAG]);
    await svc.upsertAsset(tx as unknown as Prisma.TransactionClient, ASSET, COMPANY);
    expect(calls[0]).toMatch(/^queryRaw:.*FROM "assets".*FOR UPDATE/);
    expect(calls[1]).toBe('asset.findFirst');
    expect(tx.$queryRaw.mock.calls[0]!.slice(1)).toEqual([ASSET, COMPANY]);
  });

  it('indexes resolved tag names and drops legacy non-UUID values from the lookup', async () => {
    const { tx } = client(['production', TAG]);
    await svc.upsertAsset(tx as unknown as Prisma.TransactionClient, ASSET, COMPANY);
    expect(tx.tag.findMany).toHaveBeenCalledWith({
      where: { id: { in: [TAG] } },
      select: { id: true, name: true },
    });
    const values = insertValues(tx);
    expect(values).toContain('Core network\nSN-301');
  });

  it('skips the tag lookup for a legacy-only TAGS value and still indexes the other fields', async () => {
    const { tx } = client(['production', 'staging']);
    await svc.upsertAsset(tx as unknown as Prisma.TransactionClient, ASSET, COMPANY);
    expect(tx.tag.findMany).not.toHaveBeenCalled();
    expect(insertValues(tx)).toContain('SN-301');
  });
});

describe('SearchIndexService.matchAssetIds', () => {
  const COMPANY = '2ba00000-0000-4000-8000-00000000c401';

  function setup() {
    const findMany = jest.fn().mockResolvedValue([{ entityId: 'a-1' }]);
    const prisma = { searchIndex: { findMany } } as unknown as PrismaService;
    return { svc: new SearchIndexService(prisma, new FieldTypesRegistry()), findMany };
  }

  type Where = {
    entityType: string;
    companyId: string;
    AND: Array<{ OR: Array<Record<string, { contains: string; mode: string }>> }>;
  };
  const whereOf = (findMany: jest.Mock) => (findMany.mock.calls[0]![0] as { where: Where }).where;

  it('needs every word in the name or the internal body, scoped to the company', async () => {
    const { svc, findMany } = setup();
    await expect(
      svc.matchAssetIds(COMPANY, '  dell   5420 ', { clientVisibleOnly: false }),
    ).resolves.toEqual(['a-1']);
    const where = whereOf(findMany);
    expect(where.entityType).toBe('asset');
    expect(where.companyId).toBe(COMPANY);
    expect(where.AND).toEqual([
      {
        OR: [
          { title: { contains: 'dell', mode: 'insensitive' } },
          { bodyInternal: { contains: 'dell', mode: 'insensitive' } },
        ],
      },
      {
        OR: [
          { title: { contains: '5420', mode: 'insensitive' } },
          { bodyInternal: { contains: '5420', mode: 'insensitive' } },
        ],
      },
    ]);
  });

  it('reads only the public body for client users', async () => {
    const { svc, findMany } = setup();
    await svc.matchAssetIds(COMPANY, 'switch', { clientVisibleOnly: true });
    const keys = whereOf(findMany).AND[0]!.OR.map((c) => Object.keys(c)[0]);
    expect(keys).toEqual(['title', 'bodyPublic']);
  });

  it('escapes LIKE wildcards so they match literally', async () => {
    const { svc, findMany } = setup();
    await svc.matchAssetIds(COMPANY, 'ABC_123 100% C:\\temp', { clientVisibleOnly: false });
    const patterns = whereOf(findMany).AND.map((w) => w.OR[0]!['title']!.contains);
    expect(patterns).toEqual(['ABC\\_123', '100\\%', 'C:\\\\temp']);
  });

  it('accepts 8 words and refuses a 9th instead of dropping it', async () => {
    const { svc, findMany } = setup();
    await svc.matchAssetIds(COMPANY, 'a b c d e f g h', { clientVisibleOnly: false });
    expect(whereOf(findMany).AND).toHaveLength(8);

    findMany.mockClear();
    await expect(
      svc.matchAssetIds(COMPANY, 'a b c d e f g h i', { clientVisibleOnly: false }),
    ).rejects.toMatchObject({
      response: { error: 'SearchTermTooLong', message: 'A search term can have at most 8 words.' },
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('accepts 200 characters and refuses a longer term instead of cutting it', async () => {
    const { svc, findMany } = setup();
    await svc.matchAssetIds(COMPANY, ` ${'x'.repeat(200)} `, { clientVisibleOnly: false });
    expect(findMany).toHaveBeenCalledTimes(1);

    findMany.mockClear();
    await expect(
      svc.matchAssetIds(COMPANY, 'x'.repeat(201), { clientVisibleOnly: false }),
    ).rejects.toMatchObject({ response: { error: 'SearchTermTooLong' } });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('does not query for a blank search', async () => {
    const { svc, findMany } = setup();
    await expect(svc.matchAssetIds(COMPANY, '   ', { clientVisibleOnly: false })).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
