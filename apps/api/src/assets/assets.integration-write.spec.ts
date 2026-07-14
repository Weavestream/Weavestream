import { z } from 'zod';
import { transformBreezeRecord } from '../integrations/drivers/breeze/breeze.transforms.js';
import { AssetTargetWriter } from '../integrations/reconstruction/asset-target.writer.js';
import { TextareaStrategy } from '../field-types/strategies/text.strategy.js';

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
  dependencyResource: '54000000-0000-0000-0000-000000000010',
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

function setup(options: { target?: unknown; match?: unknown[]; binding?: unknown; auditFails?: boolean; textarea?: boolean } = {}) {
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
    get: jest.fn().mockReturnValue(options.textarea ? new TextareaStrategy() : {
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
  it('writes a maximum safe custom-field value through the real Textarea strategy, writer, and service', async () => {
    const orgId = '11111111-1111-4111-8111-111111111111';
    const definitionId = '22222222-2222-4222-8222-222222222222';
    const deviceId = '33333333-3333-4333-8333-333333333333';
    const [transformed] = transformBreezeRecord('custom-field-values', {
      id: definitionId, orgId, siteId: null, sourceUpdatedAt: '2026-07-14T11:00:00.000Z',
      revision: 'a'.repeat(64), sourceScope: 'organization', name: 'Structured', fieldKey: 'structured',
      type: 'text', options: null, required: false, defaultValue: null, deviceTypes: null,
      values: [{ deviceId, value: Array.from({ length: 4 }, (_, index) => `${index}:${'x'.repeat(12_000)}`) }],
      valueCollection: { total: 1, included: 1, complete: true, reason: null },
    });
    if (!transformed || !('fields' in transformed) || !transformed.fields) throw new Error('Expected custom value asset.');
    const { service, tx } = setup({ textarea: true });
    const outcome = await new AssetTargetWriter(service).write({
      tx: tx as never, companyId: ids.company, integrationId: ids.integration,
      integrationCompanyMappingId: ids.mapping, resourceId: ids.resource,
      resourceKey: 'custom-field-values', externalOrgId: orgId, auditActorId: ids.actor,
      now: new Date('2026-07-14T12:00:00.000Z'), dryRun: false,
      resolveBinding: jest.fn().mockResolvedValue(null),
    }, {
      targetKind: 'asset', externalId: `${orgId}:custom-field-values:${definitionId}:${deviceId}`,
      source: { externalOrgId: orgId, resourceKey: 'custom-field-values', sourceId: `${definitionId}:${deviceId}`, revision: 'a'.repeat(64), fingerprint: 'a'.repeat(64) },
      name: transformed.displayName ?? 'Structured value', assetLayoutId: ids.layout,
      externalSource: 'breeze', matchKeyFieldIds: [],
      fieldValues: [{ targetFieldId: ids.field, value: transformed.fields.value, syncDirection: 'source_wins' }],
    });
    expect(outcome).toMatchObject({ change: 'created', targetKind: 'asset' });
    expect(tx.assetFieldValue.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ value: transformed.fields.value }),
    }));
  });

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

  it('accepts an exact eligible dependency binding as a grouped-resource first-write anchor', async () => {
    const dependencyExternalId = 'org-1:devices:edge-01';
    const { service, tx } = setup({
      target: asset(),
      binding: binding({
        resourceId: ids.dependencyResource,
        externalId: dependencyExternalId,
        resource: { integrationId: ids.integration, resourceKey: 'devices' },
        provenance: {
          integrationId: ids.integration,
          externalOrgId: 'org-1',
          resourceKey: 'devices',
          externalId: dependencyExternalId,
          ownership: 'breeze',
          state: 'active',
        },
      }),
    });

    await expect(
      service.writeFromIntegration({
        ...input,
        externalId: 'org-1:device-inventory:edge-01',
        existingTargetId: ids.asset,
        ownershipBinding: {
          resourceId: ids.dependencyResource,
          externalId: dependencyExternalId,
        },
      } as never),
    ).resolves.toMatchObject({ targetId: ids.asset, change: 'unchanged' });
    expect(tx.asset.updateMany).not.toHaveBeenCalled();
  });

  it.each(['device', 'site'] as const)(
    'writes first adjacent Breeze %s inventory fields through the real writer and service',
    async (subject) => {
      const orgId = '11111111-1111-4111-8111-111111111111';
      const siteId = '22222222-2222-4222-8222-222222222222';
      const deviceId = '33333333-3333-4333-8333-333333333333';
      const revision = 'a'.repeat(64);
      const sourceUpdatedAt = '2026-07-14T11:00:00.000Z';
      const complete = { total: 0, included: 0, complete: true, reason: null } as const;
      const raw = subject === 'device'
        ? {
            id: deviceId,
            orgId,
            siteId,
            sourceUpdatedAt,
            revision,
            subjectType: 'device' as const,
            deviceId,
            hardware: {
              processor: { model: null, cores: 4, threads: 8 },
              memory: { totalMb: 8_192 },
              graphics: { model: null },
              motherboard: { manufacturer: null, product: null, version: null },
              firmware: { biosVersion: null },
            },
            disks: [],
            interfaces: [],
            addresses: [],
            warranty: null,
            virtualMachines: [],
            collections: {
              disks: complete,
              interfaces: complete,
              addresses: complete,
              virtualMachines: complete,
            },
          }
        : {
            id: siteId,
            orgId,
            siteId,
            sourceUpdatedAt,
            revision,
            subjectType: 'site' as const,
            siteSubjectId: siteId,
            networkEquipment: [],
            networkSegments: [],
            collections: { networkEquipment: complete, networkSegments: complete },
          };
      const resourceKey = subject === 'device' ? 'device-inventory' : 'site-inventory';
      const dependencyResourceKey = subject === 'device' ? 'devices' : 'sites';
      const sourceId = subject === 'device' ? deviceId : siteId;
      const dependencyExternalId = `${orgId}:${dependencyResourceKey}:${sourceId}`;
      const dependencyBinding = binding({
        resourceId: ids.dependencyResource,
        externalId: dependencyExternalId,
        resource: { integrationId: ids.integration, resourceKey: dependencyResourceKey },
        companyMapping: { integrationId: ids.integration, externalOrgId: orgId },
        provenance: {
          integrationId: ids.integration,
          externalOrgId: orgId,
          resourceKey: dependencyResourceKey,
          externalId: dependencyExternalId,
          ownership: 'breeze',
          state: 'active',
        },
      });
      const { service, tx } = setup({ target: asset(), binding: dependencyBinding });
      const [transformed] = transformBreezeRecord(resourceKey, raw);
      if (!transformed || !('fields' in transformed) || !transformed.fields) {
        throw new Error('Expected grouped asset fields.');
      }
      const writer = new AssetTargetWriter(service);

      const outcome = await writer.write(
        {
          tx: tx as never,
          companyId: ids.company,
          integrationId: ids.integration,
          integrationCompanyMappingId: ids.mapping,
          resourceId: ids.resource,
          resourceKey,
          externalOrgId: orgId,
          auditActorId: ids.actor,
          now: new Date(sourceUpdatedAt),
          dryRun: false,
          existingTargetId: null,
          previousProvenance: null,
          resolveBinding: jest.fn().mockResolvedValue({
            targetKind: 'asset',
            targetId: ids.asset,
            companyId: ids.company,
            resourceId: ids.dependencyResource,
            externalId: dependencyExternalId,
          }),
        },
        {
          targetKind: 'asset',
          externalId: `${orgId}:${resourceKey}:${sourceId}`,
          source: {
            externalOrgId: orgId,
            resourceKey,
            sourceId,
            revision,
            fingerprint: revision,
            updatedAt: sourceUpdatedAt,
          },
          name: transformed.displayName ?? `${subject} inventory`,
          assetLayoutId: ids.layout,
          externalSource: 'breeze',
          matchKeyFieldIds: [],
          fieldValues: [
            {
              targetFieldId: ids.field,
              value: String(transformed.fields.inventoryCompleteness ?? ''),
              syncDirection: 'source_wins',
            },
          ],
          bindingResourceKey: dependencyResourceKey,
        },
      );

      expect(outcome).toMatchObject({ targetId: ids.asset, change: 'updated' });
      expect(tx.integrationSyncRecord.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            integrationCompanyMappingId_resourceId_externalId: {
              integrationCompanyMappingId: ids.mapping,
              resourceId: ids.dependencyResource,
              externalId: dependencyExternalId,
            },
          },
        }),
      );
      expect(tx.asset.updateMany).toHaveBeenCalled();
    },
  );

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
