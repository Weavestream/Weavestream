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
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    searchIndex: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: jest.fn() },
    // Tagged-template call (strings array) = the scope watermark lock
    // probe; Prisma.sql-object call = the guarded stale transition,
    // which reports survivors via RETURNING.
    // Like real Prisma: a void-returning statement (an advisory lock) cannot go
    // through $queryRaw, which fails to deserialize the void column.
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn(async (query: readonly string[] | { values?: unknown[] }) => {
      if (Array.isArray(query) && String(query[0]).includes('pg_advisory_xact_lock')) {
        throw new Error("Failed to deserialize column of type 'void'.");
      }
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
    integrationSyncRecord: {
      findUnique: jest.fn().mockResolvedValue(options.binding ?? null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
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

  it('keeps the baseline of a field the source left out this run', async () => {
    const { service } = setup({ target: asset(), binding: binding() });
    // The source omitted the field (no mapping entry this run): its last
    // integration-written checksum must survive for the next run.
    await expect(service.writeFromIntegration({
      ...input,
      existingTargetId: ids.asset,
      fieldValues: [],
      previousFieldChecksums: { [ids.field]: 'integration-baseline', 'not-in-layout': 'x' },
    })).resolves.toMatchObject({ fieldChecksums: { [ids.field]: 'integration-baseline' } });
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

  describe('match-first (claimUnboundMatch)', () => {
    it('adopts a single unbound manual candidate instead of creating a duplicate', async () => {
      const manual = asset({ id: ids.manual, name: 'Manual edge', externalSource: null, externalId: null });
      const { service, tx } = setup({ match: [manual] });
      await expect(service.writeFromIntegration({
        ...input,
        matchKeyFieldIds: [ids.field],
        claimUnboundMatch: true,
      })).resolves.toMatchObject({ targetId: ids.manual, change: 'updated' });
      expect(tx.asset.create).not.toHaveBeenCalled();
      expect(tx.asset.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: ids.manual }),
        data: expect.objectContaining({ externalId: input.externalId, externalSource: 'breeze' }),
      }));
    });

    it('lets only one of two racing mappings adopt the same unbound asset', async () => {
      const manual = asset({ id: ids.manual, name: 'Manual edge', externalSource: null, externalId: null });
      const { service, tx } = setup({ match: [manual] });
      // One shared row. Both writers resolved it while it was still unbound
      // (the match query keeps returning that snapshot); updatedAt is left
      // untouched to model two writes landing in the same millisecond, so
      // only the identity condition can stop the second adoption.
      const row = { ...manual };
      tx.asset.updateMany.mockImplementation(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const matches = Object.entries(where).every(([key, value]) => {
          const current = (row as Record<string, unknown>)[key];
          return value instanceof Date && current instanceof Date ? value.getTime() === current.getTime() : current === value;
        });
        if (!matches) return { count: 0 };
        Object.assign(row, { externalId: data.externalId ?? row.externalId, externalSource: data.externalSource ?? row.externalSource });
        return { count: 1 };
      });
      tx.asset.findUnique.mockImplementation(async () => ({ ...row }));
      const first = await service.writeFromIntegration({
        ...input,
        matchKeyFieldIds: [ids.field],
        claimUnboundMatch: true,
      });
      const second = await service.writeFromIntegration({
        ...input,
        integrationCompanyMappingId: '54000000-0000-0000-0000-000000000011',
        externalId: 'org-2:devices:edge-01',
        externalSource: 'ninjaone',
        matchKeyFieldIds: [ids.field],
        claimUnboundMatch: true,
      });
      expect(first).toMatchObject({ targetId: ids.manual, change: 'updated', adopted: true });
      expect(second).toMatchObject({
        targetId: ids.manual,
        change: 'blocked',
        gap: { kind: 'ambiguous', details: { reasonCode: 'match_first_claim_lost' } },
      });
      // The winner's identity stands; the loser wrote no field values.
      expect(row).toMatchObject({ externalId: input.externalId, externalSource: 'breeze' });
      expect(tx.asset.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: ids.manual, externalSource: null, externalId: null }),
      }));
      expect(tx.assetFieldValue.upsert).toHaveBeenCalledTimes(1);
      expect(tx.asset.create).not.toHaveBeenCalled();
    });

    it('never adopts a candidate that carries another source identity', async () => {
      const owned = asset({ id: ids.manual, externalSource: 'ninjaone', externalId: 'other-1' });
      const { service, tx } = setup({ match: [owned] });
      await expect(service.writeFromIntegration({
        ...input,
        matchKeyFieldIds: [ids.field],
        claimUnboundMatch: true,
      })).resolves.toMatchObject({ targetId: ids.asset, change: 'created' });
      expect(tx.asset.updateMany).not.toHaveBeenCalled();
    });

    it('still reports two unbound candidates as ambiguous and binds nothing', async () => {
      const first = asset({ id: ids.manual, externalSource: null, externalId: null });
      const second = asset({ id: '00000000-0000-0000-0000-000000000099', externalSource: null, externalId: null });
      const { service, tx } = setup({ match: [first, second] });
      await expect(service.writeFromIntegration({
        ...input,
        matchKeyFieldIds: [ids.field],
        claimUnboundMatch: true,
      })).resolves.toMatchObject({
        change: 'blocked',
        gap: { kind: 'ambiguous', details: { reasonCode: 'ambiguous_match' } },
      });
      expect(tx.asset.create).not.toHaveBeenCalled();
      expect(tx.asset.updateMany).not.toHaveBeenCalled();
    });

    it('matches emails case-insensitively and trimmed through the EMAIL strategy', async () => {
      const emailField = { ...field, fieldType: 'EMAIL', slug: 'email' };
      const manual = asset({
        id: ids.manual, externalSource: null, externalId: null,
        fieldValues: [{ id: 'fv-1', companyId: ids.company, assetId: ids.manual, assetFieldId: ids.field, value: 'alice@example.com' }],
      });
      const { EmailStrategy } = await import('../field-types/strategies/contact.strategy.js');
      const { service, prisma } = setup({
        match: [manual],
        layout: { ...layout, fields: [emailField] },
        strategy: new EmailStrategy(),
      });
      await expect(service.writeFromIntegration({
        ...input,
        matchKeyFieldIds: [ids.field],
        claimUnboundMatch: true,
        // The runner projects raw driver values through the strategy first.
        fieldValues: [{ targetFieldId: ids.field, value: new EmailStrategy().normalize('  Alice@Example.COM '), syncDirection: 'source_wins' }],
      })).resolves.toMatchObject({ targetId: ids.manual });
      const where = prisma.asset.findMany.mock.calls[0][0].where;
      const variants = where.AND[0].fieldValues.some.OR.map((clause: { value: { equals: unknown } }) => clause.value.equals);
      expect(variants).toContain('alice@example.com');
    });

    it('matches a mixed-case email stored in a TEXT field case-insensitively', async () => {
      const textField = { ...field, fieldType: 'TEXT', slug: 'email' };
      const manual = asset({
        id: ids.manual, name: 'Alice (manual)', externalSource: null, externalId: null,
        fieldValues: [{ id: 'fv-1', companyId: ids.company, assetId: ids.manual, assetFieldId: ids.field, value: 'Alice@Example.COM' }],
      });
      const { service, prisma, tx } = setup({ layout: { ...layout, fields: [textField] } });
      // Exact-variant query misses; the in-memory fallback scan finds it.
      for (const client of [prisma, tx]) {
        client.asset.findMany.mockReset();
        client.asset.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([manual]).mockResolvedValue([]);
        client.asset.findUnique.mockResolvedValue(manual);
      }
      await expect(service.writeFromIntegration({
        ...input,
        name: 'alice@example.com',
        matchKeyFieldIds: [ids.field],
        claimUnboundMatch: true,
        fieldValues: [{ targetFieldId: ids.field, value: 'alice@example.com', syncDirection: 'source_wins' }],
      })).resolves.toMatchObject({ targetId: ids.manual });
      expect(tx.asset.create).not.toHaveBeenCalled();
      const scan = prisma.asset.findMany.mock.calls[1][0].where;
      expect(scan).toMatchObject({ externalSource: null, externalId: null, assetLayoutId: ids.layout });
    });

    it('reports a truncated fallback scan as ambiguous instead of adopting or creating', async () => {
      const textField = { ...field, fieldType: 'TEXT', slug: 'email' };
      const many = Array.from({ length: 5_001 }, (_, i) => asset({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, externalSource: null, externalId: null }));
      const { service, prisma, tx } = setup({ layout: { ...layout, fields: [textField] } });
      for (const client of [prisma, tx]) {
        client.asset.findMany.mockReset();
        client.asset.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce(many).mockResolvedValue([]);
      }
      await expect(service.writeFromIntegration({
        ...input,
        matchKeyFieldIds: [ids.field],
        claimUnboundMatch: true,
        fieldValues: [{ targetFieldId: ids.field, value: 'alice@example.com', syncDirection: 'source_wins' }],
      })).resolves.toMatchObject({ change: 'blocked', gap: { kind: 'ambiguous', details: { reasonCode: 'match_first_index_overflow' } } });
      expect(tx.asset.create).not.toHaveBeenCalled();
    });

    it('does not fall back to the scan without claimUnboundMatch', async () => {
      const { service, prisma } = setup({ match: [] });
      await service.writeFromIntegration({ ...input, matchKeyFieldIds: [ids.field] });
      expect(prisma.asset.findMany).toHaveBeenCalledTimes(1);
    });

    it('keeps the operator name when adopting and on later syncs', async () => {
      const manual = asset({ id: ids.manual, name: 'Operator name', externalSource: null, externalId: null });
      const { service, tx } = setup({ match: [manual] });
      await service.writeFromIntegration({
        ...input,
        name: 'Google display name',
        matchKeyFieldIds: [ids.field],
        claimUnboundMatch: true,
      });
      const data = tx.asset.updateMany.mock.calls[0][0].data;
      expect(data.name).toBe('Operator name');
      expect(data.externalId).toBe(input.externalId);
    });

    describe('co-binding an asset another integration owns', () => {
      const coBind = { claimUnboundMatch: true, coBindSources: ['google-workspace', 'level'] };
      const owned = (overrides: Record<string, unknown> = {}) =>
        asset({ id: ids.manual, name: 'Owner name', externalSource: 'google-workspace', externalId: 'g-user-1', ...overrides });

      it('binds this record to the single matching asset without taking its identity or name', async () => {
        const { service, tx } = setup({ match: [owned()] });
        await expect(service.writeFromIntegration({
          ...input, ...coBind, tx: tx as never, externalSource: 'level', externalId: 'l-user-1', name: 'Other name',
          matchKeyFieldIds: [ids.field],
          fieldValues: [{ targetFieldId: ids.field, value: 'edge-02', syncDirection: 'source_wins' }],
        })).resolves.toMatchObject({ targetId: ids.manual, adopted: true, change: 'updated' });
        expect(tx.asset.create).not.toHaveBeenCalled();
        const call = tx.asset.updateMany.mock.calls[0][0];
        // The owner's identity is pinned, never replaced, and the name is untouched.
        expect(call.where).toMatchObject({ id: ids.manual, externalSource: 'google-workspace', externalId: 'g-user-1' });
        expect(call.data).not.toHaveProperty('externalSource');
        expect(call.data).not.toHaveProperty('name');
      });

      it('serializes the co-bind check per integration and asset inside the page transaction', async () => {
        const { service, tx } = setup({ match: [owned()] });
        await expect(service.writeFromIntegration({
          ...input, ...coBind, tx: tx as never, externalSource: 'level', externalId: 'l-user-1', matchKeyFieldIds: [ids.field],
        })).resolves.toMatchObject({ targetId: ids.manual, adopted: true });
        const isLock = (call: unknown[]) => Array.isArray(call[0]) && String(call[0][0]).includes('pg_advisory_xact_lock');
        // The lock returns void, which only $executeRaw accepts through Prisma.
        expect(tx.$queryRaw.mock.calls.some(isLock)).toBe(false);
        const lock = tx.$executeRaw.mock.calls.find(isLock);
        expect(lock).toBeDefined();
        expect(lock!.slice(1)).toEqual([`cobind:${ids.integration}:${ids.manual}`]);
        expect(tx.integrationSyncRecord.findFirst).toHaveBeenCalled();
      });

      it('refuses to co-bind without a caller transaction to serialize the check', async () => {
        const { service, tx } = setup({ match: [owned()] });
        await expect(service.writeFromIntegration({
          ...input, ...coBind, externalSource: 'level', externalId: 'l-user-1', matchKeyFieldIds: [ids.field],
        })).resolves.toMatchObject({ targetId: ids.asset, change: 'created' });
        expect(tx.asset.updateMany).not.toHaveBeenCalled();
        const locked = [...tx.$queryRaw.mock.calls, ...tx.$executeRaw.mock.calls]
          .some((call) => Array.isArray(call[0]) && String(call[0][0]).includes('pg_advisory_xact_lock'));
        expect(locked).toBe(false);
      });

      it('co-binds a device by serial owned by an RMM', async () => {
        const rmm = owned({ externalSource: 'level', externalId: 'lvl-1' });
        const { service, tx } = setup({ match: [rmm] });
        await expect(service.writeFromIntegration({
          ...input, ...coBind, tx: tx as never, externalSource: 'google-workspace', externalId: 'g-device-1', matchKeyFieldIds: [ids.field],
        })).resolves.toMatchObject({ targetId: ids.manual, adopted: true });
        expect(tx.asset.create).not.toHaveBeenCalled();
      });

      it('never co-binds an asset this integration already holds under another external id', async () => {
        const { service, tx } = setup({ match: [owned()] });
        tx.integrationSyncRecord.findFirst.mockResolvedValue({ id: 'own-binding' });
        await expect(service.writeFromIntegration({
          ...input, ...coBind, tx: tx as never, externalSource: 'level', externalId: 'l-user-2', matchKeyFieldIds: [ids.field],
        })).resolves.toMatchObject({ targetId: ids.asset, change: 'created' });
        expect(tx.asset.updateMany).not.toHaveBeenCalled();
        expect(tx.integrationSyncRecord.findFirst).toHaveBeenCalledWith(expect.objectContaining({
          where: expect.objectContaining({ assetId: ids.manual, companyMapping: { integrationId: ids.integration } }),
        }));
      });

      it('never co-binds an asset owned by a driver without standard fields', async () => {
        const legacy = owned({ externalSource: 'action1', externalId: 'a1-1' });
        const { service, tx } = setup({ match: [legacy] });
        await expect(service.writeFromIntegration({
          ...input, ...coBind, externalSource: 'level', externalId: 'l-user-1', matchKeyFieldIds: [ids.field],
        })).resolves.toMatchObject({ change: 'created' });
        expect(tx.asset.updateMany).not.toHaveBeenCalled();
      });

      it('reports two matching owned assets as ambiguous and creates nothing', async () => {
        const second = owned({ id: '00000000-0000-0000-0000-000000000099', externalId: 'g-user-2' });
        const { service, tx } = setup({ match: [owned(), second] });
        await expect(service.writeFromIntegration({
          ...input, ...coBind, externalSource: 'level', externalId: 'l-user-1', matchKeyFieldIds: [ids.field],
        })).resolves.toMatchObject({ change: 'blocked', gap: { kind: 'ambiguous', details: { reasonCode: 'ambiguous_match' } } });
        expect(tx.asset.create).not.toHaveBeenCalled();
      });

      it('co-binds a mixed-case email case-insensitively after no manual asset matched', async () => {
        const textField = { ...field, fieldType: 'TEXT', slug: 'email' };
        const google = owned({
          fieldValues: [{ id: 'fv-1', companyId: ids.company, assetId: ids.manual, assetFieldId: ids.field, value: 'Alice@Example.COM' }],
        });
        const { service, prisma, tx } = setup({ layout: { ...layout, fields: [textField] } });
        for (const client of [prisma, tx]) {
          client.asset.findMany.mockReset();
          // exact query, manual index, co-bind index
          client.asset.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([google]).mockResolvedValue([]);
          client.asset.findUnique.mockResolvedValue(google);
        }
        await expect(service.writeFromIntegration({
          ...input, ...coBind, tx: tx as never, externalSource: 'level', externalId: 'l-user-1', name: 'alice@example.com',
          matchKeyFieldIds: [ids.field],
          fieldValues: [{ targetFieldId: ids.field, value: 'alice@example.com', syncDirection: 'preserve_manual' }],
        })).resolves.toMatchObject({ targetId: ids.manual, adopted: true });
        expect(tx.asset.create).not.toHaveBeenCalled();
        expect(tx.asset.findMany.mock.calls[2][0].where).toMatchObject({
          externalSource: { in: ['google-workspace', 'level'] },
          integrationSyncRecords: { none: { companyMapping: { integrationId: ids.integration } } },
        });
      });
    });

    it('reports adoption so the runner can mark the binding', async () => {
      const manual = asset({ id: ids.manual, externalSource: null, externalId: null });
      const { service } = setup({ match: [manual] });
      await expect(service.writeFromIntegration({
        ...input, matchKeyFieldIds: [ids.field], claimUnboundMatch: true,
      })).resolves.toMatchObject({ targetId: ids.manual, adopted: true });
    });

    it('keeps the operator name on later syncs of an adopted binding', async () => {
      const { service, tx } = setup({ target: asset({ name: 'Operator name' }), binding: binding() });
      await service.writeFromIntegration({
        ...input, existingTargetId: ids.asset, name: 'Google display name',
        claimUnboundMatch: true, keepTargetName: true,
        fieldValues: [{ targetFieldId: ids.field, value: 'edge-02', syncDirection: 'source_wins' }],
      });
      expect(tx.asset.updateMany.mock.calls[0][0].data.name).toBe('Operator name');
    });

    it('renames an asset the integration created itself on later syncs, even with match-first', async () => {
      const { service, tx } = setup({ target: asset({ name: 'Old Google name' }), binding: binding() });
      const result = await service.writeFromIntegration({
        ...input, existingTargetId: ids.asset, name: 'New Google name', claimUnboundMatch: true,
      });
      expect(tx.asset.updateMany.mock.calls[0][0].data.name).toBe('New Google name');
      expect(result).not.toHaveProperty('adopted');
    });

    it('builds the case-insensitive index once per run and reuses it for every record', async () => {
      const textField = { ...field, fieldType: 'TEXT', slug: 'email' };
      const people = ['Alice@Example.COM', 'Bob@Example.COM', 'Carol@Example.COM'].map((value, i) => asset({
        id: `00000000-0000-4000-8000-00000000000${i}`, name: value, externalSource: null, externalId: null,
        fieldValues: [{ id: `fv-${i}`, companyId: ids.company, assetId: `a-${i}`, assetFieldId: ids.field, value }],
      }));
      const { service, prisma, tx } = setup({ layout: { ...layout, fields: [textField] } });
      for (const client of [prisma, tx]) {
        client.asset.findMany.mockReset();
        // Exact-variant lookups miss; any call with `select` is the index build.
        client.asset.findMany.mockImplementation(async (args: { select?: unknown }) => (args.select ? people : []));
        client.asset.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => people.find((p) => p.id === where.id) ?? null);
      }
      const matchFirstIndexes = new Map();
      for (const [i, email] of ['alice@example.com', 'bob@example.com', 'carol@example.com', 'dave@example.com'].entries()) {
        const result = await service.writeFromIntegration({
          ...input, externalId: `user-${i}`, name: email, matchKeyFieldIds: [ids.field],
          claimUnboundMatch: true, matchFirstIndexes,
          fieldValues: [{ targetFieldId: ids.field, value: email, syncDirection: 'source_wins' }],
        });
        expect(result.targetId).toBe(i < 3 ? people[i]!.id : ids.asset);
      }
      const builds = [...prisma.asset.findMany.mock.calls, ...tx.asset.findMany.mock.calls]
        .filter(([args]) => (args as { select?: unknown }).select !== undefined);
      expect(builds).toHaveLength(1);
      expect(matchFirstIndexes.size).toBe(1);
    });

    it('reports two assets sharing a lowercased key as ambiguous from the index', async () => {
      const textField = { ...field, fieldType: 'TEXT', slug: 'email' };
      const twins = ['Alice@Example.com', 'ALICE@example.com'].map((value, i) => asset({
        id: `00000000-0000-4000-8000-00000000001${i}`, externalSource: null, externalId: null,
        fieldValues: [{ id: `fv-${i}`, companyId: ids.company, assetId: `a-${i}`, assetFieldId: ids.field, value }],
      }));
      const { service, prisma, tx } = setup({ layout: { ...layout, fields: [textField] } });
      for (const client of [prisma, tx]) {
        client.asset.findMany.mockReset();
        client.asset.findMany.mockImplementation(async (args: { select?: unknown }) => (args.select ? twins : []));
      }
      await expect(service.writeFromIntegration({
        ...input, matchKeyFieldIds: [ids.field], claimUnboundMatch: true,
        fieldValues: [{ targetFieldId: ids.field, value: 'alice@example.com', syncDirection: 'source_wins' }],
      })).resolves.toMatchObject({ change: 'blocked', gap: { kind: 'ambiguous', details: { reasonCode: 'ambiguous_match' } } });
      expect(tx.asset.create).not.toHaveBeenCalled();
      expect(tx.asset.updateMany).not.toHaveBeenCalled();
    });

    it('does not adopt an indexed asset that an earlier record of the run already adopted', async () => {
      const textField = { ...field, fieldType: 'TEXT', slug: 'email' };
      const stored = asset({
        id: ids.manual, externalSource: null, externalId: null,
        fieldValues: [{ id: 'fv-1', companyId: ids.company, assetId: ids.manual, assetFieldId: ids.field, value: 'Alice@Example.COM' }],
      });
      const { service, prisma, tx } = setup({ layout: { ...layout, fields: [textField] } });
      for (const client of [prisma, tx]) {
        client.asset.findMany.mockReset();
        client.asset.findMany.mockImplementation(async (args: { select?: unknown }) => (args.select ? [stored] : []));
        client.asset.findUnique.mockResolvedValue({ ...stored, externalSource: 'breeze', externalId: 'user-0' });
      }
      await expect(service.writeFromIntegration({
        ...input, externalId: 'user-1', matchKeyFieldIds: [ids.field], claimUnboundMatch: true,
        fieldValues: [{ targetFieldId: ids.field, value: 'alice@example.com', syncDirection: 'source_wins' }],
      })).resolves.toMatchObject({ change: 'created' });
    });

    it('still renames on update for resources without match-first', async () => {
      const { service, tx } = setup({ target: asset({ name: 'Old name' }), binding: binding() });
      await service.writeFromIntegration({ ...input, existingTargetId: ids.asset, name: 'New name' });
      expect(tx.asset.updateMany.mock.calls[0][0].data.name).toBe('New name');
    });
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

describe('AssetsService standard-field write policy (recordFieldDiffs)', () => {
  const checksum = (value: unknown) =>
    createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
  const withValue = (value: unknown) => asset({
    fieldValues: value === undefined
      ? []
      : [{ id: 'fv-1', companyId: ids.company, assetId: ids.asset, assetFieldId: ids.field, value }],
  });
  const standard = (value: string, previous: Record<string, string>) => ({
    ...input,
    existingTargetId: ids.asset,
    recordFieldDiffs: true,
    fieldValues: [{ targetFieldId: ids.field, value, syncDirection: 'preserve_manual' as const }],
    previousFieldChecksums: previous,
  });

  describe('several integrations on one asset', () => {
    const other = (driver: string, value: string) => ({
      lastSyncedFieldChecksums: { [ids.field]: checksum(value) },
      companyMapping: { integration: { driver } },
    });
    const shared = (value: string, order: string[], previous: Record<string, string> = {}) => ({
      ...standard(value, previous),
      priority: { driver: 'ninjaone', order },
    });
    const LOWER = ['google-workspace', 'ninjaone'];
    const OWNER = ['ninjaone', 'google-workspace'];

    it('a lower-priority source records a difference instead of overwriting the owner', async () => {
      const { service, prisma, tx } = setup({ target: withValue('Engineer'), binding: binding() });
      prisma.integrationSyncRecord.findMany.mockResolvedValue([other('google-workspace', 'Engineer')]);
      await expect(service.writeFromIntegration(shared('Senior Engineer', LOWER)))
        .resolves.toMatchObject({ fieldDiffs: { [ids.field]: { sourceValue: 'Senior Engineer', localFingerprint: checksum('Engineer') } } });
      expect(tx.assetFieldValue.upsert).not.toHaveBeenCalled();
      expect(prisma.integrationSyncRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ assetId: ids.asset, companyMapping: { integrationId: { not: ids.integration } } }),
      }));
    });

    it('a lower-priority source fills the field while it is empty', async () => {
      const { service, prisma, tx } = setup({ target: withValue(undefined), binding: binding() });
      prisma.integrationSyncRecord.findMany.mockResolvedValue([other('google-workspace', 'Engineer')]);
      await expect(service.writeFromIntegration(shared('Senior Engineer', LOWER)))
        .resolves.toMatchObject({ fieldDiffs: {}, fieldChecksums: { [ids.field]: checksum('Senior Engineer') } });
      expect(tx.assetFieldValue.upsert).toHaveBeenCalled();
    });

    it('a lower-priority source equal to the current value is no difference', async () => {
      const { service, prisma } = setup({ target: withValue('Engineer'), binding: binding() });
      prisma.integrationSyncRecord.findMany.mockResolvedValue([other('google-workspace', 'Engineer')]);
      await expect(service.writeFromIntegration(shared('Engineer', LOWER)))
        .resolves.toMatchObject({ fieldDiffs: {}, fieldChecksums: { [ids.field]: checksum('Engineer') } });
    });

    it('the owner replaces a value another integration wrote, and the order change applies on the next write', async () => {
      const { service, prisma, tx } = setup({ target: withValue('Engineer'), binding: binding() });
      prisma.integrationSyncRecord.findMany.mockResolvedValue([other('google-workspace', 'Engineer')]);
      await expect(service.writeFromIntegration(shared('Senior Engineer', OWNER)))
        .resolves.toMatchObject({ fieldDiffs: {}, fieldChecksums: { [ids.field]: checksum('Senior Engineer') } });
      expect(tx.assetFieldValue.upsert).toHaveBeenCalled();
    });

    it('the owner keeps a person edit and records the difference on its own binding', async () => {
      const { service, prisma, tx } = setup({ target: withValue('Typed by hand'), binding: binding() });
      prisma.integrationSyncRecord.findMany.mockResolvedValue([other('google-workspace', 'Engineer')]);
      await expect(service.writeFromIntegration(shared('Senior Engineer', OWNER, { [ids.field]: checksum('Senior Engineer') })))
        .resolves.toMatchObject({ fieldDiffs: { [ids.field]: { sourceValue: 'Senior Engineer' } } });
      expect(tx.assetFieldValue.upsert).not.toHaveBeenCalled();
    });

    it('loads every live binding on the asset so the highest-priority provider is never dropped', async () => {
      const { service, prisma, tx } = setup({ target: withValue('Engineer'), binding: binding() });
      // 60 lower-priority bindings, then the owner last: a 50-row cap would omit it.
      const many = Array.from({ length: 60 }, () => other('level', 'Engineer'));
      prisma.integrationSyncRecord.findMany.mockResolvedValue([...many, other('google-workspace', 'Engineer')]);
      await expect(service.writeFromIntegration(shared('Senior Engineer', ['google-workspace', 'ninjaone', 'level'])))
        .resolves.toMatchObject({ fieldDiffs: { [ids.field]: { sourceValue: 'Senior Engineer' } } });
      expect(tx.assetFieldValue.upsert).not.toHaveBeenCalled();
      expect(prisma.integrationSyncRecord.findMany.mock.calls[0][0]).not.toHaveProperty('take');
    });

    it('an empty source value never clears what another integration provides', async () => {
      const { service, prisma, tx } = setup({ target: withValue('Engineer'), binding: binding() });
      prisma.integrationSyncRecord.findMany.mockResolvedValue([other('google-workspace', 'Engineer')]);
      await expect(service.writeFromIntegration(shared('', OWNER)))
        .resolves.toMatchObject({ fieldDiffs: {} });
      expect(tx.assetFieldValue.upsert).not.toHaveBeenCalled();
      expect(tx.assetFieldValue.deleteMany).not.toHaveBeenCalled();
    });
  });

  it('first sync of a new asset writes every mapped field and records no difference', async () => {
    const { service, tx } = setup();
    await expect(service.writeFromIntegration({
      ...standard('host-a', {}),
      existingTargetId: null,
    })).resolves.toMatchObject({ change: 'created', fieldDiffs: {}, fieldChecksums: { [ids.field]: checksum('host-a') } });
    expect(tx.assetFieldValue.upsert).toHaveBeenCalled();
  });

  it('an existing binding with no field baseline yet keeps the person value', async () => {
    const { service, tx } = setup({ target: withValue('typed-by-hand'), binding: binding() });
    await expect(service.writeFromIntegration(standard('host-a', {})))
      .resolves.toMatchObject({ fieldDiffs: { [ids.field]: { sourceValue: 'host-a' } } });
    expect(tx.assetFieldValue.upsert).not.toHaveBeenCalled();
  });

  it('a field newly mapped onto an established binding keeps the person value and records a difference', async () => {
    const other = '54000000-0000-0000-0000-0000000000aa';
    const { service, tx } = setup({ target: withValue('typed-by-hand'), binding: binding() });
    const result = await service.writeFromIntegration(standard('host-a', { [other]: checksum('SN-1') }));
    expect(result).toMatchObject({
      fieldDiffs: { [ids.field]: { sourceValue: 'host-a', localFingerprint: checksum('typed-by-hand') } },
    });
    // No baseline is invented for the person value: it stays a difference until resolved.
    expect(result.fieldChecksums?.[ids.field]).toBeUndefined();
    expect(tx.assetFieldValue.upsert).not.toHaveBeenCalled();
  });

  it('a field newly mapped onto an established binding is still filled when empty', async () => {
    const other = '54000000-0000-0000-0000-0000000000aa';
    const { service, tx } = setup({ target: withValue(undefined), binding: binding() });
    await expect(service.writeFromIntegration(standard('host-a', { [other]: checksum('SN-1') })))
      .resolves.toMatchObject({ fieldDiffs: {}, fieldChecksums: { [ids.field]: checksum('host-a') } });
    expect(tx.assetFieldValue.upsert).toHaveBeenCalled();
  });

  it('fills an empty field even after a baseline exists', async () => {
    const { service, tx } = setup({ target: withValue(undefined), binding: binding() });
    await expect(service.writeFromIntegration(standard('host-b', { [ids.field]: checksum('host-a') })))
      .resolves.toMatchObject({ change: 'updated', fieldDiffs: {} });
    expect(tx.assetFieldValue.upsert).toHaveBeenCalled();
  });

  it('follows the source while the field still holds the last integration value', async () => {
    const { service, tx } = setup({ target: withValue('host-a'), binding: binding() });
    await expect(service.writeFromIntegration(standard('host-b', { [ids.field]: checksum('host-a') })))
      .resolves.toMatchObject({ change: 'updated', fieldDiffs: {}, fieldChecksums: { [ids.field]: checksum('host-b') } });
    expect(tx.assetFieldValue.upsert).toHaveBeenCalled();
  });

  it('records a difference instead of overwriting a field a person changed', async () => {
    const { service, tx } = setup({ target: withValue('typed-by-hand'), binding: binding() });
    await expect(service.writeFromIntegration(standard('host-b', { [ids.field]: checksum('host-a') })))
      .resolves.toMatchObject({
        change: 'unchanged',
        fieldChecksums: { [ids.field]: checksum('host-a') },
        fieldDiffs: {
          [ids.field]: {
            sourceValue: 'host-b',
            sourceFingerprint: checksum('host-b'),
            localFingerprint: checksum('typed-by-hand'),
          },
        },
      });
    expect(tx.assetFieldValue.upsert).not.toHaveBeenCalled();
  });

  it('a person value equal to the source is no difference and follows the source again', async () => {
    const { service } = setup({ target: withValue('host-b'), binding: binding() });
    await expect(service.writeFromIntegration(standard('host-b', { [ids.field]: checksum('host-a') })))
      .resolves.toMatchObject({ fieldDiffs: {}, fieldChecksums: { [ids.field]: checksum('host-b') } });
  });

  it('leaves other drivers unchanged: no fieldDiffs without the flag', async () => {
    const { service } = setup({ target: withValue('typed-by-hand'), binding: binding() });
    const result = await service.writeFromIntegration({
      ...standard('host-b', { [ids.field]: checksum('host-a') }),
      recordFieldDiffs: undefined,
    });
    expect(result.fieldDiffs).toBeUndefined();
  });
});

describe('AssetsService.update in a caller transaction', () => {
  it('writes its asset.update audit row with the caller client, so a rollback takes it too', async () => {
    const { service, prisma, audit, tx } = setup();
    const internals = service as unknown as Record<string, unknown>;
    prisma.asset.findFirst.mockResolvedValueOnce({
      id: ids.asset, companyId: ids.company, name: 'Edge', externalId: null, externalSource: null, archivedAt: null,
      assetLayout: { fields: [] }, fieldValues: [],
    });
    internals.validateValues = () => ({ hostname: 'edge-02' });
    internals.assertUniqueValues = async () => undefined;
    internals.persistFieldValues = async () => undefined;
    internals.linkFileFieldUploadsToAsset = async () => undefined;
    internals.get = async () => ({});
    (audit as Record<string, unknown>).log = jest.fn();
    await service.update(
      { id: ids.actor, role: 'SUPER_ADMIN' } as never, ids.company, ids.asset,
      { fieldValues: { hostname: 'edge-02' } }, { ip: null, userAgent: null } as never, tx as never,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.logWithClient).toHaveBeenCalledWith(tx, expect.objectContaining({ action: 'asset.update', entityId: ids.asset }));
    expect((audit as unknown as { log: jest.Mock }).log).not.toHaveBeenCalled();
  });
});
