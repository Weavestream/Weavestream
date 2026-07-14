import type { DriverDescriptor } from '@weavestream/shared';
import { IntegrationsService, ensureResourceDestination, validateResourceRegistry, validateResourceTargetConfig, assertResourcePatchCompatible } from './integrations.service.js';
import { NotFoundException } from '@nestjs/common';
import type { RecommendedDestination } from './drivers/integration-driver.js';
import { BREEZE_RECOMMENDED_DESTINATIONS } from './drivers/breeze/breeze.driver.js';

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
  it('validates mutable configuration against the immutable descriptor target kind', () => {
    const article = {
      key: 'scripts', label: 'Scripts', targetKind: 'article',
      targetConfig: { sourceEndpoint: '/scripts', folderSlug: 'scripts', visibility: 'internal' },
      dependsOnResourceKeys: [],
    } as const;
    expect(validateResourceTargetConfig(article as never, {
      sourceEndpoint: '/scripts', folderSlug: 'procedures', visibility: 'company', template: '# {{title}}',
    })).toMatchObject({ folderSlug: 'procedures', visibility: 'company' });
    expect(() => validateResourceTargetConfig(article as never, { normalization: 'cidr' }))
      .toThrow(/target configuration/i);
    expect(() => validateResourceTargetConfig(article as never, {
      sourceEndpoint: '/attacker-controlled-route', folderSlug: 'scripts', visibility: 'internal',
    })).toThrow(/descriptor-owned/i);
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

describe('ensureResourceDestination', () => {
  const recommendation: RecommendedDestination = {
    layout: { name: 'Breeze Devices', slug: 'breeze-devices', icon: 'monitor', color: 'iris' },
    fields: [
      {
        sourceField: 'breezeId',
        name: 'Breeze ID',
        slug: 'breeze-id',
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
    const layout = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slug: 'breeze-devices' };
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
        data: expect.objectContaining({ slug: 'breeze-devices' }),
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
      expect.arrayContaining(['name', 'network-equipment', 'network-segments']),
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
        { id: '00000001-0000-4000-8000-000000000000', slug: 'breeze-id', fieldType: 'TEXT' },
      ],
    },
    {
      name: 'incompatible',
      fields: [
        { id: '00000001-0000-4000-8000-000000000000', slug: 'breeze-id', fieldType: 'NUMBER' },
        { id: '00000002-0000-4000-8000-000000000000', slug: 'hostname', fieldType: 'TEXT' },
      ],
    },
  ])('leaves an administrator-owned $name recommended layout untouched', async ({ fields }) => {
    const prisma = fakePrisma();
    prisma.assetLayout.findFirst.mockResolvedValue({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      slug: 'breeze-devices',
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
    const winner = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slug: 'breeze-devices' };
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
      slug: 'breeze-devices',
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
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slug: 'breeze-devices',
          };
          return state.layout;
        }),
      },
      assetField: {
        findMany: jest.fn(async () => state.fields),
        createMany: jest.fn(async () => {
          state.fields = [{ slug: 'breeze-id' }];
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
      integration: { findUnique: jest.fn().mockResolvedValue({ id: ids.integration, driver: 'breeze' }) },
      integrationCompanyMapping: {
        findFirst: jest.fn().mockResolvedValue({ id: ids.mapping }),
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

  it('returns deterministic explicit completeness rows and six-category totals', async () => {
    const { prisma, service } = setup();
    prisma.integrationReconstructionSummary.findMany.mockResolvedValueOnce([{
      id: ids.summary, companyId: ids.company, integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource, counts, evaluatedAt: new Date('2026-07-14T01:00:00Z'),
      lastSuccessfulSyncAt: new Date('2026-07-14T00:59:00Z'),
      company: { name: 'Acme' }, companyMapping: { externalOrgName: 'Acme upstream', externalOrgId: 'org-a' },
      resource: { resourceKey: 'devices' },
    }]);

    await expect(service.getReconstructionCompleteness(ids.integration, {
      mappingId: ids.mapping, resourceId: ids.resource,
    })).resolves.toMatchObject({ counts, rows: [{ resourceKey: 'devices', counts }] });
    expect(prisma.integrationReconstructionSummary.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [
        { integrationCompanyMappingId: 'asc' }, { resourceId: 'asc' }, { id: 'asc' },
      ] }),
    );
  });

  it('rejects a mapping or resource outside the integration instead of returning an empty probe', async () => {
    const { prisma, service } = setup();
    prisma.integrationCompanyMapping.findFirst.mockResolvedValueOnce(null);
    await expect(service.getReconstructionCompleteness(ids.integration, { mappingId: ids.mapping }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.integrationReconstructionSummary.findMany).not.toHaveBeenCalled();
  });

  it('returns bounded safe gaps and rejects a tampered or cross-filter cursor', async () => {
    const { prisma, service } = setup();
    const gapRow = {
      id: ids.gap, companyId: ids.company, integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource, kind: 'synchronization_error',
      message: 'Upstream record could not be synchronized.', details: { sourceId: 'must-not-leak' },
      firstSeenAt: new Date('2026-07-14T00:00:00Z'), lastSeenAt: new Date('2026-07-14T00:01:00Z'),
      resolvedAt: null, company: { name: 'Acme' },
      companyMapping: { externalOrgName: 'Acme upstream', externalOrgId: 'org-a' },
      resource: { resourceKey: 'devices' },
      syncRecord: {
        companyId: ids.company, integrationCompanyMappingId: ids.mapping, resourceId: ids.resource,
        targetKind: 'asset', assetId: ids.target, subnetId: null, ipReservationId: null,
        articleId: null, relationId: null, asset: { name: 'HV-01' }, subnet: null,
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
        where: expect.objectContaining({ OR: [
          { lastSeenAt: { lt: new Date('2026-07-14T00:01:00.000Z') } },
          { lastSeenAt: new Date('2026-07-14T00:01:00.000Z'), id: { gt: ids.gap } },
        ] }),
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

  it('does not return native target metadata from a non-exact gap binding', async () => {
    const { prisma, service } = setup();
    prisma.integrationReconstructionGap.findMany.mockResolvedValueOnce([{
      id: ids.gap, companyId: ids.company, integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource, kind: 'validation', message: 'Review required.',
      firstSeenAt: new Date('2026-07-14T00:00:00Z'), lastSeenAt: new Date('2026-07-14T00:01:00Z'),
      resolvedAt: null, company: { name: 'Acme' },
      companyMapping: { externalOrgName: 'Acme upstream', externalOrgId: 'org-a' },
      resource: { resourceKey: 'devices' },
      syncRecord: {
        companyId: '00000000-0000-4000-8000-000000000099',
        integrationCompanyMappingId: ids.mapping, resourceId: ids.resource,
        targetKind: 'asset', assetId: ids.target, subnetId: null, ipReservationId: null,
        articleId: null, relationId: null, asset: { name: 'Foreign asset' }, subnet: null,
        ipReservation: null, article: null,
      },
    }]);
    await expect(service.listReconstructionGaps(ids.integration, {
      resolution: 'active', limit: 50,
    })).resolves.toMatchObject({ items: [{ target: null }] });
  });
});
