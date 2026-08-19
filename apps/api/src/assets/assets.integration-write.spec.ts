import { createHash } from 'node:crypto';
import { z } from 'zod';
import { transformBreezeRecord } from '../integrations/drivers/breeze/breeze.transforms.js';
import { AssetTargetWriter } from '../integrations/reconstruction/asset-target.writer.js';
import { IntegrationProvenanceService } from '../integrations/reconstruction/integration-provenance.service.js';
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

function fullProvenance(state: 'active' | 'stale' | 'blocked') {
  return {
    integrationId: ids.integration,
    externalOrgId: 'org-1',
    resourceKey: 'devices',
    externalId: 'org-1:devices:edge-01',
    sourceRevision: null,
    sourceFingerprint: null,
    firstSeenAt: '2026-07-01T00:00:00.000Z',
    lastSeenAt: '2026-07-01T00:00:00.000Z',
    lastSyncedAt: '2026-07-01T00:00:00.000Z',
    ownership: 'breeze',
    state,
  };
}

function setup(options: {
  target?: unknown;
  match?: unknown[];
  binding?: unknown;
  auditFails?: boolean;
  textarea?: boolean;
  layout?: unknown;
  strategy?: unknown;
} = {}) {
  let committed = false;
  const created = asset();
  const selectedLayout = options.layout ?? layout;
  const tx = {
    assetLayout: { findUnique: jest.fn().mockResolvedValue(selectedLayout) },
    asset: {
      create: jest.fn().mockResolvedValue(created),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue(options.target ?? null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue(options.match ?? []),
    },
    assetFieldValue: {
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    upload: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    password: { updateMany: jest.fn(), deleteMany: jest.fn() },
    relation: { updateMany: jest.fn(), deleteMany: jest.fn() },
    integrationSyncRecord: {
      findUnique: jest.fn().mockResolvedValue(options.binding ?? null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    searchIndex: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: jest.fn() },
    // Tagged-template call (strings array) = the scope watermark lock
    // probe; Prisma.sql-object call = the guarded stale transition,
    // which reports survivors via RETURNING.
    $queryRaw: jest.fn(async (query: readonly string[] | { values?: unknown[] }) => {
      if (Array.isArray(query)) return [{ id: 'watermark-row' }];
      if (!options.binding || typeof options.binding !== 'object') return [];
      const values = (query as { values?: unknown[] }).values;
      const staleSince = values?.find((value) => value instanceof Date) as Date | undefined;
      const current = options.binding as Record<string, any>;
      Object.assign(current, {
        state: 'stale',
        staleSince: staleSince ?? current.staleSince,
        provenance: { ...current.provenance, state: 'stale' },
      });
      return [{
        id: current.id ?? 'binding-row',
        targetKind: current.targetKind,
        assetId: current.assetId ?? null,
        subnetId: current.subnetId ?? null,
        ipReservationId: current.ipReservationId ?? null,
        articleId: current.articleId ?? null,
        relationId: current.relationId ?? null,
      }];
    }),
  };
  const prisma = {
    assetLayout: { findUnique: jest.fn().mockResolvedValue(selectedLayout) },
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
    get: jest.fn().mockReturnValue(
      options.strategy ??
        (options.textarea
          ? new TextareaStrategy()
          : {
              valueSchema: () => z.string(),
              normalize: (value: unknown) => value,
              toPlaintext: (value: unknown) => String(value),
            }),
    ),
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
    const valueId = '44444444-4444-4444-8444-444444444444';
    const [transformed] = transformBreezeRecord('custom-field-values', {
      id: valueId, orgId, siteId: null, sourceUpdatedAt: '2026-07-14T11:00:00.000Z',
      revision: 'a'.repeat(64), deviceId, definitionId,
      target: { type: 'device', id: deviceId }, name: 'Structured', fieldKey: 'structured',
      type: 'text', value: 'x'.repeat(12_288),
    });
    if (!transformed || !('fields' in transformed) || !transformed.fields) throw new Error('Expected custom value asset.');
    const transformedValue = transformed.fields[definitionId];
    const { service, tx } = setup({ textarea: true });
    const outcome = await new AssetTargetWriter(service).write({
      tx: tx as never, companyId: ids.company, integrationId: ids.integration,
      integrationCompanyMappingId: ids.mapping, resourceId: ids.resource,
      resourceKey: 'custom-field-values', externalOrgId: orgId, auditActorId: ids.actor,
      now: new Date('2026-07-14T12:00:00.000Z'), dryRun: false,
      resolveBinding: jest.fn().mockResolvedValue(null),
    }, {
      targetKind: 'asset', externalId: `${orgId}:custom-field-values:${valueId}`,
      source: { externalOrgId: orgId, resourceKey: 'custom-field-values', sourceId: valueId, revision: 'a'.repeat(64), fingerprint: 'a'.repeat(64) },
      name: transformed.displayName ?? 'Structured value', assetLayoutId: ids.layout,
      externalSource: 'breeze', matchKeyFieldIds: [],
      fieldValues: [{ targetFieldId: ids.field, value: transformedValue, syncDirection: 'source_wins' }],
    });
    expect(outcome).toMatchObject({ change: 'created', targetKind: 'asset' });
    expect(tx.assetFieldValue.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ value: transformedValue }),
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
    expect(tx.assetLayout.findUnique).toHaveBeenCalled();
    expect(tx.integrationSyncRecord.findUnique).toHaveBeenCalled();
    expect(tx.asset.findFirst).toHaveBeenCalled();
    expect(tx.assetFieldValue.findFirst).not.toHaveBeenCalled();
    expect(prisma.assetLayout.findUnique).not.toHaveBeenCalled();
    expect(prisma.integrationSyncRecord.findUnique).not.toHaveBeenCalled();
    expect(prisma.asset.findUnique).not.toHaveBeenCalled();
    expect(prisma.asset.findFirst).not.toHaveBeenCalled();
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
    expect(prisma.assetFieldValue.findFirst).not.toHaveBeenCalled();
  });

  it('resolves a same-page asset binding and target through the caller transaction', async () => {
    const target = asset();
    const persistedBinding = binding();
    const { service, prisma, tx } = setup({ target, binding: persistedBinding });

    await expect(service.writeFromIntegration({
      ...input,
      tx: tx as never,
    })).resolves.toMatchObject({
      targetId: ids.asset,
      change: 'unchanged',
    });

    expect(tx.integrationSyncRecord.findUnique).toHaveBeenCalled();
    expect(tx.asset.findUnique).toHaveBeenCalledWith({
      where: { id: ids.asset },
      include: { fieldValues: true },
    });
    expect(prisma.integrationSyncRecord.findUnique).not.toHaveBeenCalled();
    expect(prisma.asset.findUnique).not.toHaveBeenCalled();
  });

  it('uses same-page match candidates without escaping to root Prisma', async () => {
    const candidate = asset();
    const persistedBinding = binding();
    const { service, prisma, tx } = setup({ match: [candidate], binding: persistedBinding });
    tx.integrationSyncRecord.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(persistedBinding);

    await expect(service.writeFromIntegration({
      ...input,
      matchKeyFieldIds: [ids.field],
      tx: tx as never,
    })).resolves.toMatchObject({
      targetId: ids.asset,
      change: 'unchanged',
    });

    expect(tx.asset.findMany).toHaveBeenCalled();
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
  });

  it('detects same-page unique-field and external-identity collisions before create', async () => {
    const unique = setup();
    unique.tx.assetLayout.findUnique.mockResolvedValue({
      ...layout,
      fields: [{ ...field, isUniquePerCompany: true }],
    });
    unique.tx.assetFieldValue.findFirst.mockResolvedValue({
      asset: { id: ids.manual, name: 'Manual asset' },
    });

    await expect(unique.service.writeFromIntegration({
      ...input,
      tx: unique.tx as never,
    })).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'UniqueFieldViolation' }),
    });
    expect(unique.tx.asset.create).not.toHaveBeenCalled();
    expect(unique.prisma.assetFieldValue.findFirst).not.toHaveBeenCalled();

    const identity = setup();
    identity.tx.asset.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: ids.manual });

    await expect(identity.service.writeFromIntegration({
      ...input,
      tx: identity.tx as never,
    })).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'ExternalIdTaken' }),
    });
    expect(identity.tx.asset.create).not.toHaveBeenCalled();
    expect(identity.prisma.asset.findFirst).not.toHaveBeenCalled();
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

  it('restores the same archived asset while preserving an operator-edited field', async () => {
    const target = asset({
      archivedAt: new Date('2026-07-02T00:00:00.000Z'),
      fieldValues: [{
        id: 'fv-1', companyId: ids.company, assetId: ids.asset,
        assetFieldId: ids.field, value: 'operator-edited-hostname',
      }],
    });
    const { service, tx } = setup({
      target,
      binding: binding({
        state: 'stale',
        provenance: {
          integrationId: ids.integration, externalOrgId: 'org-1', resourceKey: 'devices',
          externalId: 'org-1:devices:edge-01', ownership: 'breeze', state: 'stale',
        },
      }),
    });

    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.asset,
      fieldValues: [{
        targetFieldId: ids.field, value: 'new-upstream-hostname', syncDirection: 'preserve_manual',
      }],
      previousFieldChecksums: { [ids.field]: 'prior-source-checksum' },
    })).resolves.toMatchObject({
      targetId: ids.asset,
      change: 'restored',
      // The preserved field keeps the integration-authored baseline.
      fieldChecksums: { [ids.field]: 'prior-source-checksum' },
    });
    expect(tx.asset.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: ids.asset,
        companyId: ids.company,
        archivedAt: new Date('2026-07-02T00:00:00.000Z'),
        updatedAt: new Date('2026-07-01T00:00:00.000Z'),
      }),
      data: expect.objectContaining({ archivedAt: null }),
    }));
    expect(tx.assetFieldValue.upsert).not.toHaveBeenCalled();
    expect(tx.upload.updateMany).not.toHaveBeenCalled();
    expect(tx.password.updateMany).not.toHaveBeenCalled();
    expect(tx.password.deleteMany).not.toHaveBeenCalled();
    expect(tx.relation.updateMany).not.toHaveBeenCalled();
    expect(tx.relation.deleteMany).not.toHaveBeenCalled();
  });

  it('updates the same native asset from an exact complete blocked Breeze binding', async () => {
    const target = asset({ name: 'Old Edge' });
    const { service, tx } = setup({
      target,
      binding: binding({
        state: 'blocked',
        provenance: fullProvenance('blocked'),
      }),
    });

    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.asset,
    })).resolves.toMatchObject({ targetId: ids.asset, change: 'updated' });
    expect(tx.asset.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: ids.asset,
        companyId: ids.company,
        archivedAt: null,
        updatedAt: new Date('2026-07-01T00:00:00.000Z'),
      }),
      data: expect.objectContaining({ name: 'Edge 01' }),
    }));
  });

  it('leaves the actor columns null on create and on update, and still audits the resolved actor', async () => {
    // `auditActorId` resolves to `run.triggeredBy ?? run.integration.createdBy`,
    // so a scheduled run resolves it to whoever created the integration.
    // Stamping that id here made every sync read as "updated by <that
    // person>" on surfaces that render an actor. The audit row still
    // carries them, so the write stays attributable.
    const onCreate = setup();
    await expect(onCreate.service.writeFromIntegration(input)).resolves.toMatchObject({
      change: 'created',
    });
    expect(onCreate.tx.asset.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ createdBy: null, updatedBy: null }),
    }));
    expect(onCreate.audit.logWithClient).toHaveBeenCalledWith(
      onCreate.tx,
      expect.objectContaining({ actorId: ids.actor }),
    );

    const onUpdate = setup({
      target: asset({ name: 'Old Edge' }),
      binding: binding({ state: 'blocked', provenance: fullProvenance('blocked') }),
    });
    await expect(onUpdate.service.writeFromIntegration({
      ...input,
      existingTargetId: ids.asset,
    })).resolves.toMatchObject({ change: 'updated' });
    expect(onUpdate.tx.asset.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ updatedBy: null }),
    }));
    expect(onUpdate.audit.logWithClient).toHaveBeenCalledWith(
      onUpdate.tx,
      expect.objectContaining({ actorId: ids.actor }),
    );
  });

  it('re-reads and re-merges when an operator edit lands between read and write', async () => {
    const checksum = (value: unknown) =>
      createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
    const first = asset();
    const reread = asset({
      updatedAt: new Date('2026-07-03T00:00:00.000Z'),
      fieldValues: [{
        id: 'fv-1', companyId: ids.company, assetId: ids.asset,
        assetFieldId: ids.field, value: 'operator-edited-hostname',
      }],
    });
    const { service, prisma, tx } = setup({ binding: binding() });
    prisma.asset.findUnique.mockResolvedValueOnce(first).mockResolvedValueOnce(reread);
    const writes: Array<{ where: Record<string, unknown> }> = [];
    tx.asset.updateMany.mockImplementation(async (args: { where: Record<string, unknown> }) => {
      // The guarded attempt loses the race; the retry re-reads and,
      // seeing the operator's newer value, preserves it instead.
      writes.push(args);
      return { count: 0 };
    });

    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.asset,
      fieldValues: [{
        targetFieldId: ids.field, value: 'new-upstream-hostname', syncDirection: 'preserve_manual',
      }],
      previousFieldChecksums: { [ids.field]: checksum('edge-01') },
    })).resolves.toMatchObject({
      targetId: ids.asset,
      change: 'unchanged',
      fieldChecksums: { [ids.field]: checksum('edge-01') },
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]!.where).toMatchObject({
      id: ids.asset,
      companyId: ids.company,
      archivedAt: null,
      updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    expect(prisma.asset.findUnique).toHaveBeenCalledTimes(2);
    expect(tx.assetFieldValue.upsert).not.toHaveBeenCalled();
  });

  it('preserves an operator edit across subsequent runs as upstream keeps changing', async () => {
    const checksum = (value: unknown) =>
      createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
    const integrationBaseline = checksum('edge-01');
    const target = asset({
      fieldValues: [{
        id: 'fv-1', companyId: ids.company, assetId: ids.asset,
        assetFieldId: ids.field, value: 'operator-edited-hostname',
      }],
    });
    const { service, tx } = setup({ target, binding: binding() });

    // Run 1: upstream changed after an operator edit. The write is
    // skipped and the integration-authored baseline is carried forward —
    // not replaced with the manual value's checksum.
    const first = await service.writeFromIntegration({
      ...input,
      existingTargetId: ids.asset,
      fieldValues: [{
        targetFieldId: ids.field, value: 'new-upstream-hostname', syncDirection: 'preserve_manual',
      }],
      previousFieldChecksums: { [ids.field]: integrationBaseline },
    });
    expect(first).toMatchObject({
      targetId: ids.asset,
      change: 'unchanged',
      fieldChecksums: { [ids.field]: integrationBaseline },
    });

    // Run 2: the runner persisted run 1's checksums verbatim into
    // lastSyncedFieldChecksums and feeds them back while upstream
    // changes again. Adopting the manual checksum as the baseline in
    // run 1 would make this run treat the field as unedited and
    // overwrite the operator's value.
    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.asset,
      fieldValues: [{
        targetFieldId: ids.field, value: 'changed-again-hostname', syncDirection: 'preserve_manual',
      }],
      previousFieldChecksums: first.fieldChecksums ?? {},
    })).resolves.toMatchObject({
      targetId: ids.asset,
      change: 'unchanged',
      fieldChecksums: { [ids.field]: integrationBaseline },
    });
    expect(tx.assetFieldValue.upsert).not.toHaveBeenCalled();
    expect(tx.asset.updateMany).not.toHaveBeenCalled();
  });

  it('does not run side-effecting field resolution before a guarded write succeeds', async () => {
    const checksum = (value: unknown) =>
      createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
    const tagField = { ...field, name: 'Tags', slug: 'tags', fieldType: 'TAGS' };
    const tagLayout = { ...layout, fields: [tagField] };
    const first = asset({
      fieldValues: [{
        id: 'fv-1', companyId: ids.company, assetId: ids.asset,
        assetFieldId: ids.field, value: ['old-tag-id'],
      }],
    });
    const reread = asset({
      updatedAt: new Date('2026-07-03T00:00:00.000Z'),
      fieldValues: [{
        id: 'fv-1', companyId: ids.company, assetId: ids.asset,
        assetFieldId: ids.field, value: ['operator-tag-id'],
      }],
    });
    const preResolve = jest.fn().mockResolvedValue(['created-tag-id']);
    const strategy = {
      valueSchema: () =>
        z.array(z.union([z.string(), z.object({ name: z.string() })])),
      preResolve,
      normalize: (value: unknown) => value,
      toPlaintext: () => '',
    };
    const { service, prisma, tx } = setup({
      binding: binding(),
      layout: tagLayout,
      strategy,
    });
    prisma.asset.findUnique.mockResolvedValueOnce(first).mockResolvedValueOnce(reread);
    tx.asset.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.asset,
      fieldValues: [{
        targetFieldId: ids.field,
        value: [{ name: 'Upstream' }],
        syncDirection: 'preserve_manual',
      }],
      previousFieldChecksums: { [ids.field]: checksum(['old-tag-id']) },
    })).resolves.toMatchObject({
      targetId: ids.asset,
      change: 'unchanged',
      fieldChecksums: { [ids.field]: checksum(['old-tag-id']) },
    });

    expect(tx.asset.updateMany).toHaveBeenCalledTimes(1);
    expect(preResolve).not.toHaveBeenCalled();
    expect(tx.assetFieldValue.upsert).not.toHaveBeenCalled();
  });

  it('reports a synchronization gap when the guarded update keeps conflicting', async () => {
    const { service, prisma, audit, tx } = setup({ target: asset({ name: 'Old Edge' }), binding: binding() });
    tx.asset.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.asset,
    })).resolves.toMatchObject({
      targetId: ids.asset,
      change: 'blocked',
      gap: {
        kind: 'synchronization_error',
        details: { reasonCode: 'target_revision_conflict' },
      },
    });

    expect(tx.asset.updateMany).toHaveBeenCalledTimes(3);
    expect(prisma.asset.findUnique).toHaveBeenCalledTimes(3);
    expect(tx.assetFieldValue.upsert).not.toHaveBeenCalled();
    expect(audit.logWithClient).not.toHaveBeenCalled();
  });

  it('preserves manual fields and dependent children across a real stale sweep and native restore', async () => {
    const target = asset({
      fieldValues: [{
        id: 'fv-1', companyId: ids.company, assetId: ids.asset,
        assetFieldId: ids.field, value: 'operator-edited-hostname',
      }],
    });
    const persistedBinding = binding({
      id: 'binding-shared-asset',
      staleSince: null,
      lastSeenAt: new Date('2026-07-01T00:00:00.000Z'),
      provenance: fullProvenance('active'),
    });
    const manualUploads = [{ id: 'upload-manual' }];
    const manualPasswords = [{ id: 'password-manual' }];
    const manualRelations = [{ id: 'relation-manual' }];
    const { service, prisma, audit, tx } = setup({ target, binding: persistedBinding });
    tx.integrationSyncRecord.findMany
      .mockResolvedValueOnce([persistedBinding])
      .mockResolvedValueOnce([]);
    tx.integrationSyncRecord.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(persistedBinding, data);
      return persistedBinding;
    });
    tx.asset.updateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(target, data);
      return { count: 1 };
    });
    tx.assetFieldValue.upsert.mockImplementation(async () => {
      target.fieldValues.splice(0);
      return {};
    });
    tx.assetFieldValue.deleteMany.mockImplementation(async () => {
      const count = target.fieldValues.length;
      target.fieldValues.splice(0);
      return { count };
    });
    tx.upload.updateMany.mockImplementation(async () => {
      const count = manualUploads.length;
      manualUploads.splice(0);
      return { count };
    });
    tx.password.updateMany.mockImplementation(async () => {
      const count = manualPasswords.length;
      manualPasswords.splice(0);
      return { count };
    });
    tx.password.deleteMany.mockImplementation(async () => {
      const count = manualPasswords.length;
      manualPasswords.splice(0);
      return { count };
    });
    tx.relation.updateMany.mockImplementation(async () => {
      const count = manualRelations.length;
      manualRelations.splice(0);
      return { count };
    });
    tx.relation.deleteMany.mockImplementation(async () => {
      const count = manualRelations.length;
      manualRelations.splice(0);
      return { count };
    });

    const staleAt = new Date('2026-07-14T12:00:00.000Z');
    await expect(new IntegrationProvenanceService(prisma as never, audit as never).staleUnseen(
      tx as never,
      {
        companyId: ids.company,
        integrationId: ids.integration,
        integrationCompanyMappingId: ids.mapping,
        resourceId: ids.resource,
        targetKind: 'asset',
        snapshotAt: staleAt,
        auditActorId: ids.actor,
      },
    )).resolves.toEqual({ stale: 1, archived: 1 });
    expect(target.archivedAt).toEqual(staleAt);
    expect(persistedBinding.state).toBe('stale');

    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.asset,
      fieldValues: [{
        targetFieldId: ids.field,
        value: 'new-upstream-hostname',
        syncDirection: 'preserve_manual',
      }],
      previousFieldChecksums: { [ids.field]: 'prior-source-checksum' },
    })).resolves.toMatchObject({
      targetId: ids.asset,
      change: 'restored',
      // The preserved field keeps the integration-authored baseline.
      fieldChecksums: { [ids.field]: 'prior-source-checksum' },
    });

    expect(target.id).toBe(ids.asset);
    expect(target.archivedAt).toBeNull();
    expect(target.fieldValues).toEqual([
      expect.objectContaining({ value: 'operator-edited-hostname' }),
    ]);
    expect(manualUploads).toEqual([{ id: 'upload-manual' }]);
    expect(manualPasswords).toEqual([{ id: 'password-manual' }]);
    expect(manualRelations).toEqual([{ id: 'relation-manual' }]);
    expect(tx.assetFieldValue.upsert).not.toHaveBeenCalled();
    expect(tx.assetFieldValue.deleteMany).not.toHaveBeenCalled();
    expect(tx.upload.updateMany).not.toHaveBeenCalled();
    expect(tx.password.deleteMany).not.toHaveBeenCalled();
    expect(tx.relation.deleteMany).not.toHaveBeenCalled();
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

  it('reports a terminal identity conflict when a caller-transaction create loses the unique race', async () => {
    const { service, prisma, audit, tx } = setup();
    tx.asset.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );

    await expect(service.writeFromIntegration({ ...input, tx: tx as never })).resolves.toMatchObject({
      change: 'blocked',
      gap: {
        kind: 'synchronization_error',
        details: { reasonCode: 'external_identity_conflict' },
      },
    });

    // The caller transaction is aborted by the unique violation, so the
    // loser must stop after the failed statement: exactly one attempt,
    // no field writes, no audit row, no nested transaction.
    expect(tx.asset.create).toHaveBeenCalledTimes(1);
    expect(tx.assetFieldValue.upsert).not.toHaveBeenCalled();
    expect(audit.logWithClient).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('retries a standalone create that loses the unique race and lands on the winner', async () => {
    const winner = asset({ name: 'Old Edge' });
    const { service, prisma, tx } = setup();
    tx.asset.create.mockRejectedValueOnce(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );
    // Attempt 1 sees neither a binding nor an identity row; the winner's
    // page commits between the failed create and the retry's fresh read.
    prisma.integrationSyncRecord.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue(binding());
    prisma.asset.findUnique.mockResolvedValue(winner);
    tx.integrationSyncRecord.findUnique.mockResolvedValue(binding());

    await expect(service.writeFromIntegration(input)).resolves.toMatchObject({
      targetId: ids.asset,
      change: 'updated',
    });

    expect(tx.asset.create).toHaveBeenCalledTimes(1);
    expect(tx.asset.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('reports a terminal identity conflict when adopting identity onto a bound manual asset loses the race', async () => {
    const target = asset({ externalId: null, externalSource: null, name: 'Old Edge' });
    const { service, audit, tx } = setup({ target, binding: binding() });
    tx.asset.updateMany.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );

    await expect(service.writeFromIntegration({
      ...input,
      tx: tx as never,
      existingTargetId: ids.asset,
    })).resolves.toMatchObject({
      change: 'blocked',
      gap: {
        kind: 'synchronization_error',
        details: { reasonCode: 'external_identity_conflict' },
      },
    });

    // Terminal on the first attempt — no guarded-update retry budget is
    // spent against an aborted transaction.
    expect(tx.asset.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.assetFieldValue.upsert).not.toHaveBeenCalled();
    expect(audit.logWithClient).not.toHaveBeenCalled();
  });
});

describe('AssetsService interactive identity writes', () => {
  const actor = { id: ids.actor, role: 'SUPER_ADMIN' } as never;
  const meta = { ip: '127.0.0.1', userAgent: 'jest' };

  it('maps a lost create race on the identity indexes to the ExternalIdTaken 409', async () => {
    const { service, prisma, tx } = setup();
    tx.asset.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );

    await expect(
      service.create(
        actor,
        ids.company,
        {
          assetLayoutId: ids.layout,
          name: 'Edge 01',
          externalId: 'org-1:devices:edge-01',
          externalSource: 'breeze',
          fieldValues: { hostname: 'edge-01' },
        } as never,
        meta,
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ error: 'ExternalIdTaken' }),
    });

    // The pre-check ran and passed — the 409 came from the index backstop.
    expect(prisma.asset.findFirst).toHaveBeenCalled();
  });
});
