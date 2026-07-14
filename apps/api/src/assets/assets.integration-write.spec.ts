import { z } from 'zod';

jest.mock('../uploads/uploads.service.js', () => ({
  UploadsService: class UploadsService {},
}));

let AssetsService: typeof import('./assets.service.js').AssetsService;

beforeAll(async () => {
  ({ AssetsService } = await import('./assets.service.js'));
});

const ids = {
  company: '54000000-0000-0000-0000-000000000001',
  actor: '54000000-0000-0000-0000-000000000002',
  integration: '54000000-0000-0000-0000-000000000003',
  mapping: '54000000-0000-0000-0000-000000000004',
  resource: '54000000-0000-0000-0000-000000000005',
  layout: '54000000-0000-0000-0000-000000000006',
  field: '54000000-0000-0000-0000-000000000007',
  asset: '54000000-0000-0000-0000-000000000008',
  manual: '54000000-0000-0000-0000-000000000009',
};

const field = {
  id: ids.field,
  assetLayoutId: ids.layout,
  name: 'Hostname',
  slug: 'hostname',
  fieldType: 'TEXT',
  position: 0,
  isRequired: false,
  isPrimary: true,
  isUniquePerCompany: false,
  visibleToClients: true,
  options: {},
  archivedAt: null,
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  updatedAt: new Date('2026-07-01T00:00:00.000Z'),
};

const layout = {
  id: ids.layout,
  name: 'Devices',
  slug: 'devices',
  icon: 'server',
  color: '#000000',
  description: null,
  archivedAt: null,
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  fields: [field],
};

function asset(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.asset,
    companyId: ids.company,
    assetLayoutId: ids.layout,
    name: 'Edge 01',
    externalId: 'org-1:devices:edge-01',
    externalSource: 'breeze',
    archivedAt: null,
    createdBy: ids.actor,
    updatedBy: ids.actor,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    fieldValues: [{ id: 'fv-1', companyId: ids.company, assetId: ids.asset, assetFieldId: ids.field, value: 'edge-01' }],
    ...overrides,
  };
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
    integrationCompanyMappingId: ids.mapping,
    resourceId: ids.resource,
    externalId: 'org-1:devices:edge-01',
    companyId: ids.company,
    targetKind: 'asset',
    assetId: ids.asset,
    subnetId: null,
    ipReservationId: null,
    articleId: null,
    relationId: null,
    state: 'active',
    companyMapping: { integrationId: ids.integration, externalOrgId: 'org-1' },
    resource: { integrationId: ids.integration, resourceKey: 'devices' },
    provenance: {
      integrationId: ids.integration, externalOrgId: 'org-1', resourceKey: 'devices',
      externalId: 'org-1:devices:edge-01', ownership: 'breeze', state: 'active',
    },
    ...overrides,
  };
}

function setup(options: { target?: unknown; match?: unknown[]; binding?: unknown; auditFails?: boolean } = {}) {
  let committed = false;
  const created = asset();
  const tx = {
    asset: {
      create: jest.fn().mockResolvedValue(created),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    assetFieldValue: {
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    upload: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    integrationSyncRecord: { findUnique: jest.fn().mockResolvedValue(options.binding ?? null) },
    auditLog: { create: jest.fn() },
  };
  const prisma = {
    assetLayout: { findUnique: jest.fn().mockResolvedValue(layout) },
    integrationSyncRecord: { findUnique: jest.fn().mockResolvedValue(options.binding ?? null) },
    asset: {
      findUnique: jest.fn().mockResolvedValue(options.target ?? null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue(options.match ?? []),
    },
    assetFieldValue: { findFirst: jest.fn().mockResolvedValue(null) },
    tag: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(async (callback: (client: unknown) => Promise<unknown>) => {
      const result = await callback(tx);
      committed = true;
      return result;
    }),
  };
  const audit = {
    assertIntegrationActor: jest.fn().mockResolvedValue(undefined),
    logWithClient: options.auditFails
      ? jest.fn().mockRejectedValue(new Error('audit failed'))
      : jest.fn().mockResolvedValue(undefined),
  };
  const registry = {
    get: jest.fn().mockReturnValue({
      valueSchema: () => z.string(),
      normalize: (value: unknown) => value,
      toPlaintext: (value: unknown) => String(value),
    }),
  };
  const searchIndex = { upsertAsset: jest.fn().mockResolvedValue(undefined) };
  const service = new AssetsService(
    prisma as never,
    audit as never,
    registry as never,
    {} as never,
    {} as never,
    searchIndex as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, prisma, audit, tx, wasCommitted: () => committed };
}

const input = {
  companyId: ids.company,
  integrationId: ids.integration,
  integrationCompanyMappingId: ids.mapping,
  resourceId: ids.resource,
  auditActorId: ids.actor,
  dryRun: false,
  externalId: 'org-1:devices:edge-01',
  externalSource: 'breeze',
  name: 'Edge 01',
  assetLayoutId: ids.layout,
  matchKeyFieldIds: [],
  fieldValues: [{ targetFieldId: ids.field, value: 'edge-01', syncDirection: 'source_wins' as const }],
  previousFieldChecksums: {},
};

describe('AssetsService integration system writes', () => {
  it('creates the exact source asset and audit row in one transaction', async () => {
    const { service, audit, tx } = setup();
    await expect(service.writeFromIntegration(input)).resolves.toMatchObject({
      targetId: ids.asset,
      companyId: ids.company,
      change: 'created',
    });
    expect(audit.assertIntegrationActor).toHaveBeenCalledWith(ids.actor, ids.company);
    expect(audit.logWithClient).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ entityId: ids.asset, after: { integrationId: ids.integration, change: 'created' } }),
    );
  });

  it('joins a caller page transaction instead of nesting a transaction', async () => {
    const { service, prisma, tx, audit } = setup();
    await expect(service.writeFromIntegration({ ...input, tx: tx as never })).resolves.toMatchObject({
      targetId: ids.asset,
      change: 'created',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.logWithClient).toHaveBeenCalledWith(tx, expect.any(Object));
  });

  it.each([
    ['unchanged', asset(), 'Edge 01'],
    ['updated', asset(), 'Edge 02'],
    ['restored', asset({ archivedAt: new Date('2026-07-02T00:00:00.000Z') }), 'Edge 01'],
  ] as const)('returns %s for a verified existing source asset', async (change, target, name) => {
    const bindingState = change === 'restored' ? 'stale' : 'active';
    const { service, tx } = setup({
      target,
      binding: binding({
        state: bindingState,
        provenance: { integrationId: ids.integration, externalOrgId: 'org-1', resourceKey: 'devices', externalId: 'org-1:devices:edge-01', ownership: 'breeze', state: bindingState },
      }),
    });
    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.asset,
      name,
    })).resolves.toMatchObject({ targetId: ids.asset, change });
    expect(tx.integrationSyncRecord.findUnique).toHaveBeenCalled();
  });

  it('rejects an arbitrary manual existing asset before mutation', async () => {
    const { service, tx } = setup({ target: asset({ externalSource: null, externalId: null }) });
    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.asset,
    })).resolves.toMatchObject({ change: 'blocked', gap: { details: { reasonCode: 'manual_ownership' } } });
    expect(tx.asset.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['wrong mapping', binding({ integrationCompanyMappingId: 'wrong-mapping' })],
    ['wrong resource', binding({ resourceId: 'wrong-resource' })],
    ['wrong external id', binding({ externalId: 'wrong-external' })],
    ['wrong target kind', binding({ targetKind: 'article' })],
    ['wrong target id', binding({ assetId: ids.manual })],
    ['wrong company', binding({ companyId: 'other-company' })],
    ['blocked state', binding({ state: 'blocked', provenance: { integrationId: ids.integration, ownership: 'breeze', state: 'blocked' } })],
    ['manual provenance', binding({ provenance: { integrationId: ids.integration, ownership: 'weavestream', state: 'active' } })],
  ])('rejects a %s persisted binding even when a caller forges the legacy flag', async (_label, persistedBinding) => {
    const { service, tx } = setup({ target: asset(), binding: persistedBinding });
    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.asset,
      ownershipVerified: true,
    } as never)).resolves.toMatchObject({
      change: 'blocked',
      gap: { details: { reasonCode: 'manual_ownership' } },
    });
    expect(tx.asset.updateMany).not.toHaveBeenCalled();
  });

  it('does not claim an unbound manual match-key candidate', async () => {
    const manual = asset({ id: ids.manual, externalSource: null, externalId: null });
    const { service } = setup({ match: [manual] });
    await expect(service.writeFromIntegration({
      ...input,
      matchKeyFieldIds: [ids.field],
    })).resolves.toMatchObject({ targetId: ids.asset, change: 'created' });
  });

  it('blocks multiple unbound natural-key candidates as ambiguous', async () => {
    const first = asset({ id: ids.manual, externalSource: null, externalId: null });
    const second = asset({ id: '00000000-0000-0000-0000-000000000099', externalSource: null, externalId: null });
    const { service, tx } = setup({ match: [first, second] });
    await expect(service.writeFromIntegration({
      ...input,
      matchKeyFieldIds: [ids.field],
    })).resolves.toMatchObject({
      change: 'blocked',
      gap: { kind: 'ambiguous', details: { reasonCode: 'ambiguous_match' } },
    });
    expect(tx.asset.create).not.toHaveBeenCalled();
  });

  it('blocks a source-compatible match-key candidate without its exact persisted binding', async () => {
    const candidate = asset();
    const { service, tx } = setup({ match: [candidate] });
    await expect(service.writeFromIntegration({ ...input, matchKeyFieldIds: [ids.field] }))
      .resolves.toMatchObject({ change: 'blocked', gap: { details: { reasonCode: 'manual_ownership' } } });
    expect(tx.asset.updateMany).not.toHaveBeenCalled();
  });

  it('does not commit the asset when transactional audit fails', async () => {
    const { service, wasCommitted } = setup({ auditFails: true });
    await expect(service.writeFromIntegration(input)).rejects.toThrow('audit failed');
    expect(wasCommitted()).toBe(false);
  });

  it('keeps asset dry-run side-effect free while validating attribution', async () => {
    const { service, prisma, audit, tx } = setup();
    await expect(service.writeFromIntegration({ ...input, dryRun: true })).resolves.toMatchObject({ change: 'created' });
    expect(audit.assertIntegrationActor).toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.asset.create).not.toHaveBeenCalled();
  });

  it('blocks a verified target from another company and native external-id collision', async () => {
    const wrong = setup({ target: asset({ companyId: 'other-company' }) }).service;
    await expect(wrong.writeFromIntegration({
      ...input, existingTargetId: ids.asset,
    })).resolves.toMatchObject({ companyId: 'other-company', change: 'blocked' });

    const collisionSetup = setup();
    collisionSetup.prisma.asset.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: ids.manual });
    await expect(collisionSetup.service.writeFromIntegration(input)).rejects.toThrow();
  });
});
