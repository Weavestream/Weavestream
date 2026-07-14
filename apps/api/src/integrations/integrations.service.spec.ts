import type { DriverDescriptor } from '@weavestream/shared';
import { ensureResourceDestination, validateResourceRegistry } from './integrations.service.js';
import type { RecommendedDestination } from './drivers/integration-driver.js';

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
    return {
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
        findMany: jest.fn().mockResolvedValueOnce([]).mockResolvedValue(fields),
        createMany: jest.fn().mockResolvedValue({ count: fields.length }),
      },
      integrationFieldMapping: {
        count: jest.fn().mockResolvedValue(0),
        createMany: jest.fn().mockResolvedValue({ count: fields.length }),
      },
      ...overrides,
    } as any;
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
    expect(prisma.integrationResource.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.integrationFieldMapping.createMany).toHaveBeenCalledTimes(1);
  });
});
