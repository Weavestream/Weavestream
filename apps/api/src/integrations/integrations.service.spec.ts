import type { DriverDescriptor } from '@weavestream/shared';
import { IntegrationsService, ensureResourceDestination, validateResourceRegistry, validateResourceTargetConfig, assertResourcePatchCompatible } from './integrations.service.js';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { RecommendedDestination } from './drivers/integration-driver.js';
import { BREEZE_RECOMMENDED_DESTINATIONS } from './drivers/breeze/breeze.driver.js';
import {
  getTenantContext,
  runWithTenantContext,
  type TenantContext,
} from '@weavestream/shared/server';
import { assertTenantScope } from '../prisma/tenant-scoped-models.js';

const baseDescriptor = {
  key: 'test',
  label: 'Test',
  description: null,
  iconKey: null,
  configFields: [],
  secretFields: [],
  capabilities: { kind: 'pull', listSourceOrgs: true, dryRun: true, ticketing: false },
} as const;

describe('validateResourceRegistry', () => {
  it('rejects missing writers before resource reconciliation', () => {
    const descriptor = {
      ...baseDescriptor,
      resources: [
        {
          key: 'subnets',
          label: 'Subnets',
          targetKind: 'subnet',
          targetConfig: { normalization: 'cidr' },
          dependsOnResourceKeys: [],
        },
      ],
    } as unknown as DriverDescriptor;

    expect(() => validateResourceRegistry(descriptor, { has: () => false })).toThrow(
      /writer.*subnet/i,
    );
  });

  it('requires bindingResourceKey to be an explicit asset dependency', () => {
    const descriptor = {
      ...baseDescriptor,
      resources: [
        {
          key: 'devices',
          label: 'Devices',
          targetKind: 'asset',
          targetConfig: {},
          dependsOnResourceKeys: [],
        },
        {
          key: 'inventory',
          label: 'Inventory',
          targetKind: 'asset',
          targetConfig: { bindingResourceKey: 'devices' },
          dependsOnResourceKeys: [],
        },
      ],
    } as unknown as DriverDescriptor;

    expect(() => validateResourceRegistry(descriptor, { has: () => true })).toThrow(
      /bindingResourceKey.*dependsOnResourceKeys/i,
    );
  });
});

describe('validateResourceTargetConfig', () => {
  it('validates configuration against the immutable descriptor target kind', () => {
    const article = {
      key: 'scripts', label: 'Scripts', targetKind: 'article',
      targetConfig: { sourceEndpoint: '/scripts', folderSlug: 'scripts', visibility: 'internal' },
      dependsOnResourceKeys: [],
    } as const;
    expect(validateResourceTargetConfig(article as never, {
      sourceEndpoint: '/scripts', folderSlug: 'scripts', visibility: 'internal',
    })).toEqual({ sourceEndpoint: '/scripts', folderSlug: 'scripts', visibility: 'internal' });
    expect(() => validateResourceTargetConfig(article as never, { normalization: 'cidr' }))
      .toThrow(/target configuration/i);
    expect(() => validateResourceTargetConfig(article as never, {
      sourceEndpoint: '/attacker-controlled-route', folderSlug: 'scripts', visibility: 'internal',
    })).toThrow(/descriptor-owned/i);
  });

  it.each([
    ['bindingResourceKey', { bindingResourceKey: 'foreign-resource' }],
    ['sourceEndpoint', { sourceEndpoint: '/attacker-controlled-route' }],
  ])('rejects an injected descriptor-owned %s when an asset descriptor omits it', (
    _field,
    targetConfig,
  ) => {
    const asset = {
      key: 'devices', label: 'Devices', targetKind: 'asset',
      targetConfig: {}, dependsOnResourceKeys: [],
    } as const;
    expect(() => validateResourceTargetConfig(asset as never, targetConfig))
      .toThrow(/descriptor-owned/i);
  });

  // The runner reads target configuration only from the driver descriptor,
  // so these once-editable fields would be saved and then ignored.
  it.each([
    ['folderSlug', { folderSlug: 'procedures', visibility: 'internal' }],
    ['visibility', { folderSlug: 'scripts', visibility: 'company' }],
    ['template', { folderSlug: 'scripts', visibility: 'internal', template: '# {{title}}' }],
  ])('rejects a changed article %s the runner would ignore', (_field, targetConfig) => {
    const article = {
      key: 'scripts', label: 'Scripts', targetKind: 'article',
      targetConfig: { folderSlug: 'scripts', visibility: 'internal' },
      dependsOnResourceKeys: [],
    } as const;
    expect(() => validateResourceTargetConfig(article as never, targetConfig))
      .toThrow(/descriptor-owned/i);
  });

  it('rejects a relation typeMapping the runner would ignore', () => {
    const relation = {
      key: 'relationships', label: 'Relationships', targetKind: 'relation',
      targetConfig: { sourceEndpoint: '/relationships' }, dependsOnResourceKeys: ['devices'],
    } as const;
    expect(() => validateResourceTargetConfig(relation as never, {
      sourceEndpoint: '/relationships', typeMapping: { host_vm: 'depends_on' },
    })).toThrow(/descriptor-owned/i);
    expect(validateResourceTargetConfig(relation as never, { sourceEndpoint: '/relationships' }))
      .toEqual({ sourceEndpoint: '/relationships' });
  });

  it('rejects an omitted descriptor field', () => {
    const article = {
      key: 'scripts', label: 'Scripts', targetKind: 'article',
      targetConfig: { folderSlug: 'scripts', visibility: 'internal' },
      dependsOnResourceKeys: [],
    } as const;
    expect(() => validateResourceTargetConfig(article as never, { folderSlug: 'scripts' }))
      .toThrow(/descriptor-owned/i);
  });
});

it('rejects asset layout and match controls for non-asset resources', () => {
  expect(() => assertResourcePatchCompatible({ targetKind: 'article' } as never, {
    assetLayoutId: '00000000-0000-4000-8000-000000000001',
  })).toThrow(/asset resources/i);
  expect(() => assertResourcePatchCompatible({ targetKind: 'subnet' } as never, {
    matchKeyFieldIds: [],
  })).toThrow(/asset resources/i);
  expect(() => assertResourcePatchCompatible({ targetKind: 'asset' } as never, {
    matchKeyFieldIds: [],
  })).not.toThrow();
});

it('rejects persisted resource target-kind drift before applying a patch', () => {
  expect(() => (assertResourcePatchCompatible as unknown as (
    descriptor: { targetKind: string }, input: object, persistedTargetKind: string,
  ) => void)({ targetKind: 'article' }, {}, 'asset')).toThrow(/target kind/i);
});

describe('ensureResourceDestination', () => {
  const recommendation: RecommendedDestination = {
    layout: { name: 'Breeze Devices', slug: 'breeze_devices', icon: 'monitor', color: 'iris' },
    fields: [
      {
        sourceField: 'breezeId',
        name: 'Breeze ID',
        slug: 'breeze_id',
        fieldType: 'TEXT',
        syncDirection: 'source_wins',
        isPrimary: false,
        showInTable: false,
        options: {},
      },
      {
        sourceField: 'hostname',
        name: 'Hostname',
        slug: 'hostname',
        fieldType: 'TEXT',
        syncDirection: 'preserve_manual',
        isPrimary: true,
        showInTable: true,
        options: {},
      },
    ],
  };

  function fakePrisma(overrides: Record<string, unknown> = {}) {
    const layout = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slug: 'breeze_devices' };
    const fields = recommendation.fields.map((field, index) => ({
      id: `${index + 1}`.padStart(8, '0') + '-0000-4000-8000-000000000000',
      slug: field.slug,
      fieldType: field.fieldType,
    }));
    const prisma = {
      integrationResource: {
        findUnique: jest
          .fn()
          .mockResolvedValue({
            id: 'resource-1',
            assetLayoutId: null,
            _count: { fieldMappings: 0 },
          }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      assetLayout: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(layout),
      },
      assetField: {
        findMany: jest.fn().mockResolvedValue(fields),
        createMany: jest.fn().mockResolvedValue({ count: fields.length }),
      },
      integrationFieldMapping: {
        count: jest.fn().mockResolvedValue(0),
        createMany: jest.fn().mockResolvedValue({ count: fields.length }),
      },
      ...overrides,
    } as any;
    prisma.$transaction ??= jest.fn(
      async (callback: (tx: typeof prisma) => Promise<void>) => callback(prisma),
    );
    return prisma;
  }

  it('creates deterministic fields/mappings once and is repeatable', async () => {
    const prisma = fakePrisma();
    await ensureResourceDestination(prisma, 'integration-1', 'devices', recommendation);
    expect(prisma.assetLayout.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ slug: 'breeze_devices' }),
      }),
    );
    expect(prisma.assetField.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.integrationFieldMapping.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ sourceField: 'hostname', syncDirection: 'preserve_manual' }),
      ]),
      skipDuplicates: true,
    });
    expect(prisma.integrationResource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ assetLayoutId: null, fieldMappings: { none: {} } }),
      }),
    );

    prisma.integrationResource.findUnique.mockResolvedValue({
      id: 'resource-1',
      assetLayoutId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      _count: { fieldMappings: 2 },
    });
    await ensureResourceDestination(prisma, 'integration-1', 'devices', recommendation);
    expect(prisma.assetLayout.create).toHaveBeenCalledTimes(1);
    expect(prisma.integrationFieldMapping.createMany).toHaveBeenCalledTimes(1);
  });

  it('provisions one complete Breeze site layout with resource-specific mappings', async () => {
    const layoutId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const resources = new Map([
      ['sites', { id: 'sites-resource', assetLayoutId: null as string | null, mappings: [] as string[] }],
      [
        'site-inventory',
        {
          id: 'site-inventory-resource',
          assetLayoutId: null as string | null,
          mappings: [] as string[],
        },
      ],
    ]);
    let layout: { id: string; slug: string; isActive: boolean } | null = null;
    const fields: Array<{ id: string; slug: string; fieldType: string }> = [];
    const tx = {
      integrationResource: {
        findUnique: jest.fn(async ({ where }: any) => {
          const row = resources.get(where.integrationId_resourceKey.resourceKey)!;
          return {
            id: row.id,
            assetLayoutId: row.assetLayoutId,
            _count: { fieldMappings: row.mappings.length },
          };
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const row = [...resources.values()].find((candidate) => candidate.id === where.id)!;
          if (row.assetLayoutId || row.mappings.length > 0) return { count: 0 };
          row.assetLayoutId = data.assetLayoutId;
          return { count: 1 };
        }),
      },
      assetLayout: {
        findFirst: jest.fn(async () => layout),
        create: jest.fn(async ({ data }: any) => {
          layout = { id: layoutId, slug: data.slug, isActive: true };
          return layout;
        }),
      },
      assetField: {
        createMany: jest.fn(async ({ data }: any) => {
          for (const item of data) {
            fields.push({
              id: `field-${fields.length + 1}`,
              slug: item.slug,
              fieldType: item.fieldType,
            });
          }
          return { count: data.length };
        }),
        findMany: jest.fn(async ({ where }: any) =>
          fields.filter((field) => where.slug.in.includes(field.slug)),
        ),
      },
      integrationFieldMapping: {
        createMany: jest.fn(async ({ data }: any) => {
          for (const item of data) {
            const row = [...resources.values()].find(
              (candidate) => candidate.id === item.resourceId,
            )!;
            row.mappings.push(item.sourceField);
          }
          return { count: data.length };
        }),
      },
    };
    const prisma = {
      ...tx,
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<void>) =>
        callback(tx),
      ),
    };

    await ensureResourceDestination(
      prisma as never,
      'integration-1',
      'sites',
      BREEZE_RECOMMENDED_DESTINATIONS.sites!,
    );
    await ensureResourceDestination(
      prisma as never,
      'integration-1',
      'site-inventory',
      BREEZE_RECOMMENDED_DESTINATIONS['site-inventory']!,
    );

    expect(tx.assetLayout.create).toHaveBeenCalledTimes(1);
    expect(resources.get('sites')).toMatchObject({ assetLayoutId: layoutId });
    expect(resources.get('site-inventory')).toMatchObject({ assetLayoutId: layoutId });
    expect(fields.map((field) => field.slug)).toEqual(
      expect.arrayContaining(['name', 'network_equipment', 'network_segments']),
    );
    expect(resources.get('sites')!.mappings).toContain('name');
    expect(resources.get('sites')!.mappings).not.toContain('networkEquipment');
    expect(resources.get('site-inventory')!.mappings).toEqual(
      expect.arrayContaining(['networkEquipment', 'networkSegments']),
    );
  });

  it.each([
    { assetLayoutId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', mappings: 0 },
    { assetLayoutId: null, mappings: 1 },
  ])('preserves customized destinations: %o', async ({ assetLayoutId, mappings }) => {
    const prisma = fakePrisma();
    prisma.integrationResource.findUnique.mockResolvedValue({
      id: 'resource-1',
      assetLayoutId,
      _count: { fieldMappings: mappings },
    });
    await ensureResourceDestination(prisma, 'integration-1', 'devices', recommendation);
    expect(prisma.assetLayout.create).not.toHaveBeenCalled();
    expect(prisma.assetField.createMany).not.toHaveBeenCalled();
    expect(prisma.integrationFieldMapping.createMany).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'partial',
      fields: [
        { id: '00000001-0000-4000-8000-000000000000', slug: 'breeze_id', fieldType: 'TEXT' },
      ],
    },
    {
      name: 'incompatible',
      fields: [
        { id: '00000001-0000-4000-8000-000000000000', slug: 'breeze_id', fieldType: 'NUMBER' },
        { id: '00000002-0000-4000-8000-000000000000', slug: 'hostname', fieldType: 'TEXT' },
      ],
    },
  ])('leaves an administrator-owned $name recommended layout untouched', async ({ fields }) => {
    const prisma = fakePrisma();
    prisma.assetLayout.findFirst.mockResolvedValue({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      slug: 'breeze_devices',
    });
    prisma.assetField.findMany.mockReset().mockResolvedValue(fields);
    await ensureResourceDestination(prisma, 'integration-1', 'devices', recommendation);
    expect(prisma.assetLayout.create).not.toHaveBeenCalled();
    expect(prisma.assetField.createMany).not.toHaveBeenCalled();
    expect(prisma.integrationResource.updateMany).not.toHaveBeenCalled();
    expect(prisma.integrationFieldMapping.createMany).not.toHaveBeenCalled();
  });

  it('re-reads a concurrent layout winner without mutating its fields', async () => {
    const prisma = fakePrisma();
    prisma.$transaction = jest.fn(async (callback: (tx: typeof prisma) => Promise<void>) =>
      callback(prisma));
    const winner = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slug: 'breeze_devices' };
    prisma.assetLayout.findFirst.mockResolvedValueOnce(null).mockResolvedValue(winner);
    prisma.assetLayout.create.mockRejectedValue(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );
    prisma.assetField.findMany.mockReset().mockResolvedValue(
      recommendation.fields.map((field, index) => ({
        id: `${index + 1}`.padStart(8, '0') + '-0000-4000-8000-000000000000',
        slug: field.slug,
        fieldType: field.fieldType,
      })),
    );
    await ensureResourceDestination(prisma, 'integration-1', 'devices', recommendation);
    expect(prisma.assetField.createMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.integrationResource.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.integrationFieldMapping.createMany).toHaveBeenCalledTimes(1);
  });

  it('does not attach an inactive recommended layout', async () => {
    const prisma = fakePrisma();
    prisma.assetLayout.findFirst.mockResolvedValue({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      slug: 'breeze_devices',
      isActive: false,
    });
    prisma.assetField.findMany.mockReset().mockResolvedValue(
      recommendation.fields.map((field, index) => ({
        id: `${index + 1}`.padStart(8, '0') + '-0000-4000-8000-000000000000',
        slug: field.slug,
        fieldType: field.fieldType,
      })),
    );
    await ensureResourceDestination(prisma, 'integration-1', 'devices', recommendation);
    expect(prisma.integrationResource.updateMany).not.toHaveBeenCalled();
    expect(prisma.integrationFieldMapping.createMany).not.toHaveBeenCalled();
  });

  it('rolls back a newly created layout when field creation is incomplete', async () => {
    const state: { layout: null | { id: string; slug: string }; fields: unknown[] } = {
      layout: null,
      fields: [],
    };
    const tx = {
      integrationResource: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'resource-1', assetLayoutId: null, _count: { fieldMappings: 0 },
        }),
        updateMany: jest.fn(),
      },
      assetLayout: {
        findFirst: jest.fn(async () => state.layout),
        create: jest.fn(async () => {
          state.layout = {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slug: 'breeze_devices',
          };
          return state.layout;
        }),
      },
      assetField: {
        findMany: jest.fn(async () => state.fields),
        createMany: jest.fn(async () => {
          state.fields = [{ slug: 'breeze_id' }];
          return { count: 1 };
        }),
      },
      integrationFieldMapping: { createMany: jest.fn() },
    };
    const prisma = {
      ...tx,
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<void>) => {
        const before = { layout: state.layout, fields: [...state.fields] };
        try {
          return await callback(tx);
        } catch (error) {
          state.layout = before.layout;
          state.fields = before.fields;
          throw error;
        }
      }),
    } as any;
    await expect(
      ensureResourceDestination(prisma, 'integration-1', 'devices', recommendation),
    ).rejects.toThrow(/field creation was incomplete/i);
    expect(state).toEqual({ layout: null, fields: [] });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('updateResource target configuration', () => {
  const ids = {
    actor: '00000000-0000-4000-8000-000000000001',
    integration: '00000000-0000-4000-8000-000000000002',
    resource: '00000000-0000-4000-8000-000000000003',
  };
  const scripts = {
    key: 'scripts', label: 'Scripts', targetKind: 'article',
    targetConfig: { folderSlug: 'breeze-scripts', visibility: 'internal' },
    dependsOnResourceKeys: [],
  };

  // The row holds an operator value saved while folderSlug, visibility,
  // template, and typeMapping were editable.
  function setup() {
    const row = {
      id: ids.resource, integrationId: ids.integration, resourceKey: 'scripts',
      enabled: true, targetKind: 'article',
      targetConfig: { folderSlug: 'procedures', visibility: 'company', template: '# {{title}}' },
      dependsOnResourceKeys: [], assetLayoutId: null, assetLayout: null,
      matchKeyFieldIds: [], _count: { fieldMappings: 0 },
      createdAt: new Date(0), updatedAt: new Date(0),
    };
    const prisma = {
      integration: {
        findUnique: jest.fn().mockResolvedValue({ id: ids.integration, driver: 'breeze' }),
      },
      integrationResource: {
        findUnique: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue(row),
      },
      integrationFieldMapping: { count: jest.fn().mockResolvedValue(0) },
    };
    const drivers = {
      get: jest.fn().mockReturnValue({ descriptor: { ...baseDescriptor, resources: [scripts] } }),
    };
    const audit = { logChange: jest.fn().mockResolvedValue(undefined) };
    const service = new IntegrationsService(
      prisma as never, {} as never, audit as never, drivers as never,
      {} as never, {} as never, {} as never,
    );
    return { prisma, service };
  }
  const meta = { ip: '127.0.0.1', userAgent: 'jest' };

  it('lets an old operator value through an enabled-only patch without rewriting it', async () => {
    const { prisma, service } = setup();
    await service.updateResource(
      { id: ids.actor } as never, ids.integration, 'scripts', { enabled: false }, meta,
    );
    expect(prisma.integrationResource.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ enabled: false, targetConfig: undefined }),
    }));
  });

  it('rejects a targetConfig patch that differs from the descriptor', async () => {
    const { prisma, service } = setup();
    await expect(service.updateResource(
      { id: ids.actor } as never, ids.integration, 'scripts',
      { targetConfig: { folderSlug: 'procedures', visibility: 'internal' } }, meta,
    )).rejects.toThrow(/descriptor-owned/i);
    expect(prisma.integrationResource.update).not.toHaveBeenCalled();
  });

  it('writes the descriptor value for a targetConfig patch that matches it', async () => {
    const { prisma, service } = setup();
    await service.updateResource(
      { id: ids.actor } as never, ids.integration, 'scripts',
      { targetConfig: { folderSlug: 'breeze-scripts', visibility: 'internal' } }, meta,
    );
    expect(prisma.integrationResource.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        targetConfig: { folderSlug: 'breeze-scripts', visibility: 'internal' },
      }),
    }));
  });
});

describe('replaceFieldMappings standard-field types', () => {
  const resource = {
    key: 'devices', label: 'Devices', targetKind: 'asset', targetConfig: {}, dependsOnResourceKeys: [],
    standardFields: [{ sourceField: 'role', label: 'Role', fieldType: 'TEXT', fieldHints: ['role'] }],
  };
  function setup(fieldType: string) {
    const prisma = {
      integration: { findUnique: jest.fn().mockResolvedValue({ id: 'i-1', driver: 'level' }) },
      integrationResource: {
        findUnique: jest.fn().mockResolvedValue({ id: 'r-1', assetLayoutId: 'l-1', _count: { fieldMappings: 0 } }),
      },
      assetField: { findMany: jest.fn().mockResolvedValue([{ id: 'f-1', fieldType }]) },
      $transaction: jest.fn(),
    };
    const drivers = { get: jest.fn().mockReturnValue({ descriptor: { ...baseDescriptor, resources: [resource] } }) };
    const service = new IntegrationsService(
      prisma as never, {} as never, {} as never, drivers as never, {} as never, {} as never, {} as never,
    );
    return { prisma, service };
  }
  const mappings = { mappings: [{ sourceField: 'role', targetFieldId: 'f-1', syncDirection: 'preserve_manual' as const, transform: null }] };

  it.each(['DROPDOWN', 'FILE', 'ASSET_REFERENCE', 'NUMBER'])('refuses to map a standard field to a %s field', async (fieldType) => {
    const { prisma, service } = setup(fieldType);
    await expect(service.replaceFieldMappings({ id: 'u' } as never, 'i-1', 'devices', mappings, { ip: '', userAgent: '' }))
      .rejects.toThrow(/cannot be mapped/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('integration deletion', () => {
  const ids = {
    actor: '00000000-0000-4000-8000-000000000001',
    integration: '00000000-0000-4000-8000-000000000002',
    company: '00000000-0000-4000-8000-000000000003',
    asset: '00000000-0000-4000-8000-000000000004',
  };

  function setup(records: Array<{ assetId: string | null; companyId: string }>) {
    const tx = {
      integrationSyncRecord: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      asset: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      integration: { delete: jest.fn().mockResolvedValue({ id: ids.integration }) },
    };
    const prisma = {
      integration: {
        findUnique: jest.fn().mockResolvedValue({
          id: ids.integration,
          driver: 'breeze',
          name: 'Breeze',
        }),
      },
      integrationSyncRecord: { findMany: jest.fn().mockResolvedValue(records) },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<void>) =>
        callback(tx)),
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const scheduler = { refreshFor: jest.fn().mockResolvedValue(undefined) };
    const service = new IntegrationsService(
      prisma as never, {} as never, audit as never, {} as never,
      {} as never, scheduler as never, {} as never,
    );
    return { service, tx, audit, scheduler };
  }

  it('releases and audits only asset targets from mixed sync records', async () => {
    const { service, tx, audit } = setup([
      { assetId: ids.asset, companyId: ids.company },
      { assetId: null, companyId: ids.company },
    ]);

    await service.delete(
      { id: ids.actor } as never,
      ids.integration,
      { ip: '127.0.0.1', userAgent: 'jest' },
    );

    expect(tx.integrationSyncRecord.deleteMany).toHaveBeenCalledWith({
      where: {
        assetId: { in: [ids.asset] },
        companyId: { in: [ids.company] },
        companyMapping: { integrationId: ids.integration },
      },
    });
    expect(tx.asset.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: [ids.asset] } }),
    }));
    expect(audit.log).toHaveBeenCalledTimes(2);
    expect(audit.log).toHaveBeenNthCalledWith(1, expect.objectContaining({
      entityType: 'Integration',
      after: { releasedAssetCount: 1 },
    }));
    expect(audit.log).toHaveBeenNthCalledWith(2, expect.objectContaining({
      entityType: 'Asset',
      entityId: ids.asset,
    }));
  });

  it('deletes a native-only integration without asset cleanup or null asset audits', async () => {
    const { service, tx, audit, scheduler } = setup([
      { assetId: null, companyId: ids.company },
    ]);

    await service.delete(
      { id: ids.actor } as never,
      ids.integration,
      { ip: '127.0.0.1', userAgent: 'jest' },
    );

    expect(tx.integrationSyncRecord.deleteMany).not.toHaveBeenCalled();
    expect(tx.integrationSyncRecord.findMany).not.toHaveBeenCalled();
    expect(tx.asset.updateMany).not.toHaveBeenCalled();
    expect(tx.integration.delete).toHaveBeenCalledWith({ where: { id: ids.integration } });
    expect(scheduler.refreshFor).toHaveBeenCalledWith(ids.integration);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      entityType: 'Integration',
      after: { releasedAssetCount: 0 },
    }));
  });
});

describe('reconstruction administration reads', () => {
  const ids = {
    integration: '00000000-0000-4000-8000-000000000001',
    mapping: '00000000-0000-4000-8000-000000000002',
    resource: '00000000-0000-4000-8000-000000000003',
    company: '00000000-0000-4000-8000-000000000004',
    summary: '00000000-0000-4000-8000-000000000005',
    gap: '00000000-0000-4000-8000-000000000006',
    target: '00000000-0000-4000-8000-000000000007',
  };
  const counts = {
    synchronizedCurrent: 1, manuallyDocumented: 2, secretBlocked: 3,
    missing: 4, stale: 5, synchronizationError: 6,
  };

  function setup() {
    const prisma = {
      integration: {
        findUnique: jest.fn().mockResolvedValue({
          id: ids.integration,
          driver: 'breeze',
          companyMappings: [{ id: ids.mapping, companyId: ids.company }],
        }),
      },
      integrationResource: {
        findFirst: jest.fn().mockResolvedValue({ id: ids.resource }),
      },
      integrationReconstructionSummary: { findMany: jest.fn().mockResolvedValue([]) },
      integrationReconstructionGap: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new IntegrationsService(
      prisma as never, {} as never, {} as never,
      { get: jest.fn(), has: jest.fn().mockReturnValue(false) } as never,
      { integrationActiveKey: Buffer.alloc(32, 7), values: { INTEGRATION_SYNC_DEFAULT_CRON: 'off' } } as never,
      {} as never, {} as never,
    );
    return { prisma, service };
  }

  function limitedOperatorTenant(): TenantContext {
    return {
      userId: '00000000-0000-4000-8000-000000000010',
      role: 'OPERATOR',
      email: 'operator@example.test',
      allowedCompanyIds: [],
      isSuperAdmin: false,
      globalAccess: 'NONE',
      requestId: 'req-cr-014',
      ip: '127.0.0.1',
      userAgent: 'jest',
    };
  }

  // Replaces the reconstruction read mocks with ones that run the real
  // tenant-scope assertion and record the allowedCompanyIds each read
  // executed under.
  function observeTenantScopedReads(prisma: ReturnType<typeof setup>['prisma']): string[][] {
    const observedScopes: string[][] = [];
    const install = (findMany: jest.Mock, model: string) => {
      findMany.mockImplementation(async (args: object) => {
        const scopedTenant = getTenantContext()!;
        observedScopes.push(scopedTenant.allowedCompanyIds);
        assertTenantScope(
          { model, action: 'findMany', args: args as Record<string, unknown> },
          scopedTenant,
        );
        return [];
      });
    };
    install(prisma.integrationReconstructionSummary.findMany, 'IntegrationReconstructionSummary');
    install(prisma.integrationReconstructionGap.findMany, 'IntegrationReconstructionGap');
    return observedScopes;
  }

  it('returns deterministic explicit completeness rows and six-category totals', async () => {
    const { prisma, service } = setup();
    prisma.integrationReconstructionSummary.findMany.mockResolvedValueOnce([{
      id: ids.summary, companyId: ids.company, integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource, counts, evaluatedAt: new Date('2026-07-14T01:00:00Z'),
      lastSuccessfulSyncAt: new Date('2026-07-14T00:59:00Z'),
      company: { name: 'Acme' },
      companyMapping: {
        companyId: ids.company, integrationId: ids.integration,
        externalOrgName: 'Raw upstream tenant', externalOrgId: 'raw-upstream-org-id',
      },
      resource: { resourceKey: 'devices', integrationId: ids.integration },
    }]);

    const response = await service.getReconstructionCompleteness(ids.integration, {
      mappingId: ids.mapping, resourceId: ids.resource,
    });
    expect(response).toMatchObject({ counts, rows: [{ resourceKey: 'devices', counts }] });
    expect(JSON.stringify(response)).not.toMatch(/Raw upstream tenant|raw-upstream-org-id/);
    expect(prisma.integrationReconstructionSummary.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyMapping: { integrationId: ids.integration },
          resource: { integrationId: ids.integration },
        }),
        orderBy: [
          { integrationCompanyMappingId: 'asc' }, { resourceId: 'asc' }, { id: 'asc' },
        ],
      }),
    );
  });

  it.each([
    ['foreign resource integration', ids.company, '00000000-0000-4000-8000-000000000099'],
    ['mapping company mismatch', '00000000-0000-4000-8000-000000000098', ids.integration],
  ])('rejects inconsistent completeness scope: %s', async (
    _label,
    mappingCompanyId,
    resourceIntegrationId,
  ) => {
    const { prisma, service } = setup();
    prisma.integrationReconstructionSummary.findMany.mockResolvedValueOnce([{
      id: ids.summary, companyId: ids.company, integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource, counts, evaluatedAt: new Date('2026-07-14T01:00:00Z'),
      lastSuccessfulSyncAt: null, company: { name: 'Acme' },
      companyMapping: { companyId: mappingCompanyId, integrationId: ids.integration },
      resource: { resourceKey: 'devices', integrationId: resourceIntegrationId },
    }]);
    await expect(service.getReconstructionCompleteness(ids.integration, {}))
      .rejects.toThrow(/inconsistent reconstruction scope/i);
  });

  it('rejects a mapping or resource outside the integration instead of returning an empty probe', async () => {
    const { prisma, service } = setup();
    prisma.integration.findUnique.mockResolvedValueOnce({
      id: ids.integration,
      driver: 'breeze',
      companyMappings: [],
    });
    await expect(service.getReconstructionCompleteness(ids.integration, { mappingId: ids.mapping }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.integrationReconstructionSummary.findMany).not.toHaveBeenCalled();
  });

  it('supplies an exact integration company scope for a limited global operator', async () => {
    const { prisma, service } = setup();
    const observedScopes = observeTenantScopedReads(prisma);

    await runWithTenantContext(limitedOperatorTenant(), async () => {
      await service.getReconstructionCompleteness(ids.integration, {});
      await service.listReconstructionGaps(ids.integration, {
        resolution: 'active',
        limit: 50,
      });
      expect(getTenantContext()?.allowedCompanyIds).toEqual([]);
    });

    expect(observedScopes).toEqual([[ids.company], [ids.company]]);
    expect(prisma.integrationReconstructionSummary.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ companyId: { in: [ids.company] } }),
      }),
    );
    expect(prisma.integrationReconstructionGap.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ companyId: { in: [ids.company] } }),
      }),
    );
  });

  it('narrows the scope to the selected mapping company when mappingId is provided', async () => {
    const { prisma, service } = setup();
    // Two mappings on the integration; the mock deliberately ignores the
    // nested mapping filter so the in-memory narrowing must hold on its own.
    prisma.integration.findUnique.mockResolvedValue({
      id: ids.integration,
      driver: 'breeze',
      companyMappings: [
        { id: ids.mapping, companyId: ids.company },
        {
          id: '00000000-0000-4000-8000-000000000012',
          companyId: '00000000-0000-4000-8000-000000000011',
        },
      ],
    });
    const observedScopes = observeTenantScopedReads(prisma);

    await runWithTenantContext(limitedOperatorTenant(), async () => {
      await service.getReconstructionCompleteness(ids.integration, { mappingId: ids.mapping });
      await service.listReconstructionGaps(ids.integration, {
        mappingId: ids.mapping,
        resolution: 'active',
        limit: 50,
      });
    });

    expect(observedScopes).toEqual([[ids.company], [ids.company]]);
    expect(prisma.integration.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          companyMappings: expect.objectContaining({ where: { id: ids.mapping } }),
        }),
      }),
    );
    expect(prisma.integrationReconstructionGap.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId: { in: [ids.company] },
          integrationCompanyMappingId: ids.mapping,
        }),
      }),
    );
  });

  it('returns bounded safe gaps and rejects a tampered or cross-filter cursor', async () => {
    const { prisma, service } = setup();
    const gapRow = {
      id: ids.gap, companyId: ids.company, integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource, kind: 'synchronization_error',
      message: 'Upstream record could not be synchronized.', details: { sourceId: 'must-not-leak' },
      firstSeenAt: new Date('2026-07-14T00:00:00Z'), lastSeenAt: new Date('2026-07-14T00:01:00Z'),
      createdAt: new Date('2026-07-14T00:00:00Z'), resolvedAt: null, company: { name: 'Acme' },
      companyMapping: {
        companyId: ids.company, integrationId: ids.integration,
        externalOrgName: 'Raw upstream tenant', externalOrgId: 'raw-upstream-org-id',
      },
      resource: { resourceKey: 'devices', integrationId: ids.integration },
      syncRecord: {
        companyId: ids.company, integrationCompanyMappingId: ids.mapping, resourceId: ids.resource,
        targetKind: 'asset', assetId: ids.target, subnetId: null, ipReservationId: null,
        articleId: null, relationId: null, asset: { name: 'HV-01', companyId: ids.company }, subnet: null,
        ipReservation: null, article: null,
      },
    };
    prisma.integrationReconstructionGap.findMany.mockResolvedValueOnce([
      gapRow,
      { ...gapRow, id: ids.summary, lastSeenAt: new Date('2026-07-13T00:01:00Z') },
    ]);
    const first = await service.listReconstructionGaps(ids.integration, {
      mappingId: ids.mapping, resourceId: ids.resource, resolution: 'active', limit: 1,
    });
    expect(JSON.stringify(first)).not.toContain('must-not-leak');
    expect(JSON.stringify(first)).not.toMatch(/Raw upstream tenant|raw-upstream-org-id/);
    expect(first.items[0]?.target).toMatchObject({ targetKind: 'asset', targetId: ids.target });
    expect(first.nextCursor).toEqual(expect.any(String));

    prisma.integrationReconstructionGap.findMany.mockResolvedValueOnce([]);
    const second = await service.listReconstructionGaps(ids.integration, {
      mappingId: ids.mapping, resourceId: ids.resource,
      resolution: 'active', limit: 1, cursor: first.nextCursor!,
    });
    expect(second.nextCursor).toBeNull();
    expect(prisma.integrationReconstructionGap.findMany.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          resource: { integrationId: ids.integration },
          OR: [
            { createdAt: { lt: new Date('2026-07-14T00:00:00.000Z') } },
            { createdAt: new Date('2026-07-14T00:00:00.000Z'), id: { gt: ids.gap } },
          ],
        }),
      }),
    );

    await expect(service.listReconstructionGaps(ids.integration, {
      mappingId: ids.mapping, resourceId: ids.resource,
      resolution: 'active', limit: 1, cursor: `${first.nextCursor}x`,
    })).rejects.toThrow(/cursor/i);
    await expect(service.listReconstructionGaps(ids.integration, {
      mappingId: ids.mapping, resourceId: ids.resource,
      kind: 'validation', resolution: 'active', limit: 1, cursor: first.nextCursor!,
    })).rejects.toThrow(/cursor/i);
  });

  it.each([
    ['foreign resource integration', ids.company, '00000000-0000-4000-8000-000000000099'],
    ['mapping company mismatch', '00000000-0000-4000-8000-000000000098', ids.integration],
  ])('rejects inconsistent gap scope: %s', async (
    _label,
    mappingCompanyId,
    resourceIntegrationId,
  ) => {
    const { prisma, service } = setup();
    prisma.integrationReconstructionGap.findMany.mockResolvedValueOnce([{
      id: ids.gap, companyId: ids.company, integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource, kind: 'validation', message: 'Review required.',
      firstSeenAt: new Date('2026-07-14T00:00:00Z'), lastSeenAt: new Date('2026-07-14T00:01:00Z'),
      createdAt: new Date('2026-07-14T00:00:00Z'), resolvedAt: null, company: { name: 'Acme' },
      companyMapping: { companyId: mappingCompanyId, integrationId: ids.integration },
      resource: { resourceKey: 'devices', integrationId: resourceIntegrationId }, syncRecord: null,
    }]);
    await expect(service.listReconstructionGaps(ids.integration, { resolution: 'active', limit: 50 }))
      .rejects.toThrow(/inconsistent reconstruction scope/i);
  });

  it('does not return native target metadata from a non-exact gap binding', async () => {
    const { prisma, service } = setup();
    prisma.integrationReconstructionGap.findMany.mockResolvedValueOnce([{
      id: ids.gap, companyId: ids.company, integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource, kind: 'validation', message: 'Review required.',
      firstSeenAt: new Date('2026-07-14T00:00:00Z'), lastSeenAt: new Date('2026-07-14T00:01:00Z'),
      createdAt: new Date('2026-07-14T00:00:00Z'), resolvedAt: null, company: { name: 'Acme' },
      companyMapping: { companyId: ids.company, integrationId: ids.integration },
      resource: { resourceKey: 'devices', integrationId: ids.integration },
      syncRecord: {
        companyId: '00000000-0000-4000-8000-000000000099',
        integrationCompanyMappingId: ids.mapping, resourceId: ids.resource,
        targetKind: 'asset', assetId: ids.target, subnetId: null, ipReservationId: null,
        articleId: null, relationId: null,
        asset: { name: 'Foreign asset', companyId: '00000000-0000-4000-8000-000000000099' }, subnet: null,
        ipReservation: null, article: null,
      },
    }]);
    await expect(service.listReconstructionGaps(ids.integration, {
      resolution: 'active', limit: 50,
    })).resolves.toMatchObject({ items: [{ target: null }] });
  });

  it('does not return a target label when the native entity belongs to another company', async () => {
    const { prisma, service } = setup();
    prisma.integrationReconstructionGap.findMany.mockResolvedValueOnce([{
      id: ids.gap, companyId: ids.company, integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource, kind: 'validation', message: 'Review required.',
      firstSeenAt: new Date('2026-07-14T00:00:00Z'), lastSeenAt: new Date('2026-07-14T00:01:00Z'),
      createdAt: new Date('2026-07-14T00:00:00Z'), resolvedAt: null, company: { name: 'Acme' },
      companyMapping: { companyId: ids.company, integrationId: ids.integration },
      resource: { resourceKey: 'devices', integrationId: ids.integration },
      syncRecord: {
        companyId: ids.company, integrationCompanyMappingId: ids.mapping, resourceId: ids.resource,
        targetKind: 'asset', assetId: ids.target, subnetId: null, ipReservationId: null,
        articleId: null, relationId: null,
        asset: { name: 'Foreign asset', companyId: '00000000-0000-4000-8000-000000000099' },
        subnet: null, ipReservation: null, article: null, relation: null,
      },
    }]);
    await expect(service.listReconstructionGaps(ids.integration, {
      resolution: 'active', limit: 50,
    })).resolves.toMatchObject({ items: [{ target: null }] });
  });

  it('traverses one immutable snapshot exactly once when lastSeenAt changes between pages', async () => {
    const { prisma, service } = setup();
    const row = (id: string, createdAt: string, lastSeenAt: string) => ({
      id, companyId: ids.company, integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource, kind: 'validation', message: 'Review required.',
      firstSeenAt: new Date('2020-01-01T00:00:00Z'), lastSeenAt: new Date(lastSeenAt),
      createdAt: new Date(createdAt), resolvedAt: null, company: { name: 'Acme' },
      companyMapping: {
        companyId: ids.company, integrationId: ids.integration,
        externalOrgName: 'Raw upstream tenant', externalOrgId: 'raw-upstream-org-id',
      },
      resource: { resourceKey: 'devices', integrationId: ids.integration }, syncRecord: null,
    });
    const rows = [
      row(ids.gap, '2020-01-03T00:00:00Z', '2020-01-03T00:00:00Z'),
      row(ids.summary, '2020-01-02T00:00:00Z', '2020-01-02T00:00:00Z'),
      row(ids.target, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
    ];
    prisma.integrationReconstructionGap.findMany.mockImplementation(async (args: any) => {
      let candidates = [...rows];
      if (args.where.createdAt?.lte) {
        candidates = candidates.filter((candidate) => candidate.createdAt <= args.where.createdAt.lte);
      }
      const boundary = args.where.OR as Array<Record<string, any>> | undefined;
      if (boundary) {
        const key = boundary[0]?.createdAt ? 'createdAt' : 'lastSeenAt';
        const value = boundary[0]?.[key]?.lt as Date;
        const equalValue = boundary[1]?.[key] as Date;
        const boundaryId = boundary[1]?.id?.gt as string;
        candidates = candidates.filter((candidate) =>
          candidate[key] < value || (candidate[key].getTime() === equalValue.getTime() && candidate.id > boundaryId),
        );
      }
      const orderKey = Object.keys(args.orderBy[0])[0] as 'createdAt' | 'lastSeenAt';
      candidates.sort((a, b) => b[orderKey].getTime() - a[orderKey].getTime() || a.id.localeCompare(b.id));
      return candidates.slice(0, args.take);
    });

    const first = await service.listReconstructionGaps(ids.integration, {
      resolution: 'active', limit: 1,
    });
    rows[1]!.lastSeenAt = new Date('2020-01-04T00:00:00Z');

    const seen = first.items.map((item) => item.id);
    const cursors = new Set<string>();
    let cursor = first.nextCursor;
    while (cursor) {
      expect(cursors.has(cursor)).toBe(false);
      cursors.add(cursor);
      const page = await service.listReconstructionGaps(ids.integration, {
        resolution: 'active', limit: 1, cursor,
      });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([ids.gap, ids.summary, ids.target]);
    expect(new Set(seen).size).toBe(3);
  });
});

describe('IntegrationsService OAuth drivers', () => {
  const id = '00000000-0000-4000-8000-0000000000aa';
  const CONN_A = '00000000-0000-4000-8000-0000000000a1';
  const CONN_B = '00000000-0000-4000-8000-0000000000b1';
  // Plaintext tagged with the AAD it was encrypted under: a wrong binding fails to decrypt.
  const crypto = {
    encrypt: (plaintext: string, aad: string) => `enc[${aad}]${plaintext}`,
    decrypt: (blob: string, aad: string) => {
      const prefix = `enc[${aad}]`;
      if (!blob.startsWith(prefix)) throw new Error('aad mismatch');
      return blob.slice(prefix.length);
    },
  };
  const grant = (tenant: string) => JSON.stringify({ refreshToken: `test-refresh-${tenant}`, grantedScopes: [], connectedAt: 'x' });
  const USER_ACTOR = { id: '00000000-0000-4000-8000-0000000000ab' } as never;
  const oauthDescriptor = {
    key: 'fake-oauth',
    label: 'Fake OAuth',
    resources: [],
    configFields: [],
    secretFields: [],
    oauth: { provider: 'google', scopes: ['s'] },
  } as unknown as DriverDescriptor;

  function setup(
    client: { clientId: string; clientSecret: string; version?: string } | null,
    opts: {
      connections?: Array<{ id: string; externalOrgId: string; secretCiphertext: string; updatedAt: Date }>;
      existingOfProvider?: boolean;
      descriptor?: DriverDescriptor;
    } = {},
  ) {
    const descriptor = opts.descriptor ?? oauthDescriptor;
    const connections = opts.connections ?? [
      { id: CONN_A, externalOrgId: 'C-a', secretCiphertext: crypto.encrypt(grant('a'), `integration:${id}:connection:${CONN_A}:secret`), updatedAt: new Date('2026-01-01T00:00:00Z') },
      { id: CONN_B, externalOrgId: 'C-b', secretCiphertext: crypto.encrypt(grant('b'), `integration:${id}:connection:${CONN_B}:secret`), updatedAt: new Date('2026-01-01T00:00:00Z') },
    ];
    const prisma = {
      integration: {
        findUnique: jest.fn(async () => ({
          id,
          driver: 'fake-oauth',
          config: {},
          secret: null,
          resources: [],
          _count: { companyMappings: 0, connections: connections.length },
          createdAt: new Date(0),
          updatedAt: new Date(0),
        })),
        findFirst: jest.fn(async () => (opts.existingOfProvider ? { name: 'Existing' } : null)),
      },
      integrationConnection: {
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
          connections.find((c) => Object.entries(where).every(([k, v]) => {
            if (k === 'integrationId') return v === id;
            const actual = (c as Record<string, unknown>)[k];
            if (v && typeof v === 'object') {
              const f = v as { equals: string; mode?: string };
              return f.mode === 'insensitive' ? String(actual).toLowerCase() === f.equals.toLowerCase() : actual === f.equals;
            }
            return actual === v;
          })) ?? null),
        findMany: jest.fn(async (args?: { take?: number }) =>
          args?.take ? connections.slice(0, args.take) : connections.map((c) => ({ externalOrgId: c.externalOrgId, displayName: `${c.externalOrgId}.example` }))),
      },
      $executeRaw: jest.fn(async () => 0),
      $transaction: jest.fn(),
    };
    // The create transaction runs on the same mock, so the lock and the re-check go through `tx`.
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma));
    const drivers = { has: () => true, describe: () => descriptor, list: () => [descriptor], kindOf: () => 'security' };
    const oauthApps = { getClient: jest.fn(async () => client) };
    const service = new IntegrationsService(
      prisma as never, crypto as never, {} as never, drivers as never,
      { values: { INTEGRATION_SYNC_DEFAULT_CRON: 'off' } } as never, {} as never, {} as never,
      oauthApps as never,
    );
    return { service, oauthApps, prisma };
  }

  it('injects the integration app and only the mapped tenant connection into the driver context', async () => {
    const client = { clientId: 'client-1', clientSecret: 'test-client-secret' };
    const { service, oauthApps } = setup(client);
    const ctx = await service.loadDriverContext(id, { externalOrgId: 'C-a' });
    expect(oauthApps.getClient).toHaveBeenCalledWith(id);
    expect(ctx.oauthClient).toEqual(client);
    expect(ctx.connectionId).toBe(CONN_A);
    expect(ctx.secret).toMatchObject({ refreshToken: 'test-refresh-a' });
  });

  it('isolates tenants: a mapping for tenant A never receives tenant B secret', async () => {
    const { service } = setup(null);
    const a = await service.loadDriverContext(id, { externalOrgId: 'C-a' });
    const b = await service.loadDriverContext(id, { externalOrgId: 'C-b' });
    expect(JSON.stringify(a.secret)).not.toContain('test-refresh-b');
    expect(JSON.stringify(b.secret)).not.toContain('test-refresh-a');
    await expect(service.loadDriverContext(id, { externalOrgId: 'C-unconnected' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a blob relocated onto another connection (AAD binds connection + integration)', async () => {
    const { service } = setup(null, {
      connections: [{ id: CONN_A, externalOrgId: 'C-a', secretCiphertext: crypto.encrypt(grant('b'), `integration:${id}:connection:${CONN_B}:secret`), updatedAt: new Date(0) }],
    });
    await expect(service.loadDriverContext(id, { externalOrgId: 'C-a' })).rejects.toThrow(/could not be decrypted/);
  });

  it('requires a connection scope for OAuth drivers', async () => {
    await expect(setup(null).service.loadDriverContext(id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('takes the only connection when asked for it, and refuses to guess between several or none', async () => {
    const single = setup(null, {
      connections: [{ id: CONN_A, externalOrgId: 'C-a', secretCiphertext: crypto.encrypt(grant('a'), `integration:${id}:connection:${CONN_A}:secret`), updatedAt: new Date(0) }],
    });
    await expect(single.service.loadDriverContext(id, { onlyConnection: true })).resolves.toMatchObject({ connectionId: CONN_A });
    await expect(setup(null).service.loadDriverContext(id, { onlyConnection: true })).rejects.toThrow(/Pick a connection/);
    await expect(setup(null, { connections: [] }).service.loadDriverContext(id, { onlyConnection: true })).rejects.toThrow(/Pick a connection/);
  });

  it('matches a Google customer id exactly', async () => {
    await expect(setup(null).service.loadDriverContext(id, { externalOrgId: 'c-A' })).rejects.toThrow(/not connected/);
  });

  it('finds a Microsoft tenant connection whatever the mapping spelling (migrated upper case, reconnected lower case)', async () => {
    const TENANT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    // Reconnect after Disconnect stores the tenant in lower case; the migrated mapping kept upper case.
    const { service } = setup(null, {
      descriptor: { ...oauthDescriptor, oauth: { provider: 'microsoft', scopes: ['s'], consentFlow: 'admin_consent' } } as unknown as DriverDescriptor,
      connections: [{ id: CONN_A, externalOrgId: TENANT, secretCiphertext: crypto.encrypt(grant('a'), `integration:${id}:connection:${CONN_A}:secret`), updatedAt: new Date(0) }],
    });
    await expect(service.loadDriverContext(id, { externalOrgId: TENANT.toUpperCase() })).resolves.toMatchObject({ connectionId: CONN_A, externalOrgId: TENANT });
  });

  it('loads by connection id within the integration only', async () => {
    const { service, prisma } = setup(null);
    await expect(service.loadDriverContext(id, { connectionId: CONN_B })).resolves.toMatchObject({ externalOrgId: 'C-b' });
    expect(prisma.integrationConnection.findFirst).toHaveBeenCalledWith({ where: { integrationId: id, id: CONN_B } });
  });

  it('stamps a non-secret credential version that changes on reconnect or app save', async () => {
    const client = { clientId: 'client-1', clientSecret: 'test-client-secret', version: 'app-1@2026-01-01T00:00:00.000Z' };
    const base = await setup(client).service.loadDriverContext(id, { externalOrgId: 'C-a' });
    expect(base.credentialVersion).toBe(`${CONN_A}@2026-01-01T00:00:00.000Z|app-1@2026-01-01T00:00:00.000Z`);
    expect(base.credentialVersion).not.toContain('test-client-secret');
    expect(base.credentialVersion).not.toContain('test-refresh');
    const reconnected = await setup(client, {
      connections: [{ id: CONN_A, externalOrgId: 'C-a', secretCiphertext: crypto.encrypt(grant('a'), `integration:${id}:connection:${CONN_A}:secret`), updatedAt: new Date('2026-01-02T00:00:00Z') }],
    }).service.loadDriverContext(id, { externalOrgId: 'C-a' });
    expect(reconnected.credentialVersion).not.toBe(base.credentialVersion);
    const appSaved = await setup({ ...client, version: 'app-1@2026-01-03T00:00:00.000Z' }).service.loadDriverContext(id, { externalOrgId: 'C-a' });
    expect(appSaved.credentialVersion).not.toBe(base.credentialVersion);
  });

  it('omits the OAuth app when none is configured', async () => {
    const ctx = await setup(null).service.loadDriverContext(id, { externalOrgId: 'C-a' });
    expect(ctx).not.toHaveProperty('oauthClient');
  });

  it('reports credentials by connections and never exposes token tails', async () => {
    const dto = await setup(null).service.get(id);
    expect(dto.hasSecret).toBe(true);
    expect(dto.secretMask).toBeNull();
    const none = await setup(null, { connections: [] }).service.get(id);
    expect(none.hasSecret).toBe(false);
  });

  it('lists the connected tenants as source organizations', async () => {
    await expect(setup(null).service.listConnectedOrgs(id)).resolves.toEqual([
      { externalId: 'C-a', name: 'C-a.example', hint: null },
      { externalId: 'C-b', name: 'C-b.example', hint: null },
    ]);
  });

  it.each([
    ['secret', { secret: { refreshToken: 'test-forged' } }],
    ['clearSecret', { clearSecret: true }],
  ])('rejects %s on update: the OAuth service is the only writer', async (_label, input) => {
    const { service } = setup(null);
    await expect(service.update(USER_ACTOR, id, input as never, { ip: null, userAgent: null } as never))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a secret on create', async () => {
    const { service } = setup(null);
    await expect(service.create(USER_ACTOR, { driver: 'fake-oauth', name: 'x', config: {}, secret: { refreshToken: 'test-forged' } } as never, { ip: null, userAgent: null } as never))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a second integration of the same OAuth provider', async () => {
    const { service, prisma } = setup(null, { existingOfProvider: true });
    await expect(service.create(USER_ACTOR, { driver: 'fake-oauth', name: 'Second', config: {} } as never, { ip: null, userAgent: null } as never))
      .rejects.toThrow(/already exists \("Existing"\).*Connections tab/);
    expect(prisma.integration.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { driver: { in: ['fake-oauth'] } } }));
  });

  it('takes a provider lock through $executeRaw inside the create transaction before the check', async () => {
    const { service, prisma } = setup(null, { existingOfProvider: true });
    await expect(service.create(USER_ACTOR, { driver: 'fake-oauth', name: 'Second', config: {} } as never, { ip: null, userAgent: null } as never))
      .rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [sql, key] = prisma.$executeRaw.mock.calls[0] as unknown as [TemplateStringsArray, string];
    expect(sql.join('?')).toContain('pg_advisory_xact_lock(hashtextextended(?, 0))');
    expect(key).toBe('oauth-provider:google');
    expect(prisma.$executeRaw.mock.invocationCallOrder[0]!).toBeLessThan(prisma.integration.findFirst.mock.invocationCallOrder[0]!);
  });
});

describe('Map layouts: recommended destinations for match-first resources', () => {
  const ids = {
    actor: '00000000-0000-4000-8000-000000000001',
    integration: '00000000-0000-4000-8000-000000000002',
    resource: '00000000-0000-4000-8000-000000000003',
    layout: '00000000-0000-4000-8000-000000000004',
  };
  const users = {
    key: 'users', label: 'Users', targetKind: 'asset', targetConfig: {}, dependsOnResourceKeys: [],
    matchSuggestions: { sourceField: 'primaryEmail', layoutHints: ['people'], fieldHints: ['email'] },
    minimalFields: ['fullName', 'primaryEmail'],
  };
  const recommendation: RecommendedDestination = {
    layout: { name: 'Workspace Users', slug: 'workspace_users', icon: 'user', color: 'iris' },
    fields: [
      { sourceField: 'fullName', name: 'Name', slug: 'name', fieldType: 'TEXT', syncDirection: 'source_wins', isPrimary: true, showInTable: true, options: {} },
      { sourceField: 'primaryEmail', name: 'Email', slug: 'email', fieldType: 'EMAIL', syncDirection: 'source_wins', isPrimary: false, showInTable: true, options: {} },
      { sourceField: 'orgUnit', name: 'Org unit', slug: 'org_unit', fieldType: 'TEXT', syncDirection: 'source_wins', isPrimary: false, showInTable: false, options: {} },
    ],
  };
  const meta = { ip: '127.0.0.1', userAgent: 'jest' };

  function setup(state: { assetLayoutId?: string | null; mappings?: number } = {}) {
    const row = {
      id: ids.resource, integrationId: ids.integration, resourceKey: 'users', enabled: false,
      targetKind: 'asset', targetConfig: {}, dependsOnResourceKeys: [],
      assetLayoutId: state.assetLayoutId ?? null, assetLayout: null, matchKeyFieldIds: [],
      _count: { fieldMappings: state.mappings ?? 0 }, createdAt: new Date(0), updatedAt: new Date(0),
    };
    const createdFields: Array<{ slug: string; fieldType: string }> = [];
    const prisma: any = {
      integration: { findUnique: jest.fn().mockResolvedValue({ id: ids.integration, driver: 'gw' }) },
      integrationResource: {
        findUnique: jest.fn().mockResolvedValue(row),
        updateMany: jest.fn(async () => { row.assetLayoutId = ids.layout; return { count: 1 }; }),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(row, data)),
        findUniqueOrThrow: jest.fn(async () => ({
          assetLayoutId: row.assetLayoutId,
          fieldMappings: row.assetLayoutId
            ? createdFields.map((f) => ({ sourceField: recommendation.fields.find((r) => r.slug === f.slug)!.sourceField, targetFieldId: `field-${f.slug}` }))
            : [],
        })),
      },
      assetLayout: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: ids.layout, slug: 'workspace_users', isActive: true }),
      },
      assetField: {
        createMany: jest.fn(async ({ data }: { data: Array<{ slug: string; fieldType: string }> }) => {
          createdFields.push(...data);
          return { count: data.length };
        }),
        findMany: jest.fn(async () => createdFields.map((f) => ({ id: `field-${f.slug}`, slug: f.slug, fieldType: f.fieldType }))),
      },
      integrationFieldMapping: {
        count: jest.fn().mockResolvedValue(state.mappings ?? 0),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    prisma.$transaction = jest.fn(async (callback: (tx: unknown) => Promise<void>) => callback(prisma));
    const drivers = {
      get: jest.fn().mockReturnValue({
        descriptor: { ...baseDescriptor, resources: [users] },
        recommendedDestinations: { users: recommendation },
      }),
    };
    const audit = { logChange: jest.fn().mockResolvedValue(undefined) };
    const service = new IntegrationsService(
      prisma as never, {} as never, audit as never, drivers as never,
      {} as never, {} as never, { has: () => true } as never,
    );
    return { prisma, service, audit, createdFields };
  }

  it('creates only the minimal fields, sets the match key and enables the resource', async () => {
    const { prisma, service, audit, createdFields } = setup();
    await service.createResourceDestination({ id: ids.actor } as never, ids.integration, 'users', meta);
    expect(createdFields.map((f) => f.slug)).toEqual(['name', 'email']);
    expect(prisma.integrationResource.update).toHaveBeenCalledWith({
      where: { id: ids.resource },
      data: { enabled: true, matchKeyFieldIds: ['field-email'] },
    });
    expect(audit.logChange).toHaveBeenCalledWith(expect.objectContaining({
      after: expect.objectContaining({ assetLayoutId: ids.layout, matchKeyFieldIds: ['field-email'] }),
    }));
  });

  it('refuses a resource that already has a layout or mappings', async () => {
    const { service, prisma } = setup({ assetLayoutId: ids.layout, mappings: 1 });
    await expect(
      service.createResourceDestination({ id: ids.actor } as never, ids.integration, 'users', meta),
    ).rejects.toThrow(/Remove the layout/);
    expect(prisma.assetLayout.create).not.toHaveBeenCalled();
  });

  it('never auto-applies a recommendation to a match-first resource on reconcile', async () => {
    const { service, prisma } = setup();
    prisma.integrationResource.upsert = jest.fn().mockResolvedValue({});
    await service.reconcileResources(ids.integration);
    expect(prisma.assetLayout.create).not.toHaveBeenCalled();
    expect(prisma.integrationResource.updateMany).not.toHaveBeenCalled();
  });
});
