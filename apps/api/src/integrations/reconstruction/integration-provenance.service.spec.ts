import { IntegrationProvenanceService, readTargetProvenance } from './integration-provenance.service.js';

const ids = {
  integration: '00000000-0000-0000-0000-000000000001',
  mapping: '00000000-0000-0000-0000-000000000002',
  resource: '00000000-0000-0000-0000-000000000003',
  company: '00000000-0000-0000-0000-000000000004',
};

describe('IntegrationProvenanceService', () => {
  it('reads only exact company/target provenance through the safe shared DTO', async () => {
    const findMany = jest.fn().mockResolvedValue([{
      integrationCompanyMappingId: ids.mapping, resourceId: ids.resource,
      targetKind: 'asset', assetId: '00000000-0000-4000-8000-000000000010',
      subnetId: null, ipReservationId: null, articleId: null, relationId: null,
      state: 'stale', staleSince: new Date('2026-07-14T00:02:00Z'),
      provenance: {
        integrationId: ids.integration, externalOrgId: 'org-a', resourceKey: 'devices',
        externalId: 'raw-upstream-id', sourceRevision: 'secret-derived-revision', sourceFingerprint: null,
        firstSeenAt: '2026-07-13T00:00:00.000Z', lastSeenAt: '2026-07-14T00:00:00.000Z',
        lastSyncedAt: '2026-07-14T00:01:00.000Z', ownership: 'breeze', state: 'stale',
      },
      asset: { name: 'HV-01', companyId: ids.company }, subnet: null,
      ipReservation: null, article: null, relation: null,
      companyMapping: {
        companyId: ids.company,
        integration: { id: ids.integration, name: 'Breeze', driver: 'breeze' },
      },
      resource: { resourceKey: 'devices', integrationId: ids.integration },
    }]);
    const output = await readTargetProvenance({ integrationSyncRecord: { findMany } } as never, {
      companyId: ids.company, targetKind: 'asset', targetId: '00000000-0000-4000-8000-000000000010',
    });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: ids.company, targetKind: 'asset', assetId: '00000000-0000-4000-8000-000000000010' },
    }));
    expect(output).toEqual([expect.objectContaining({ sourceLabel: 'Breeze', sourceResource: 'devices', state: 'stale' })]);
    expect(JSON.stringify(output)).not.toContain('raw-upstream-id');
    expect(JSON.stringify(output)).not.toContain('secret-derived-revision');

    findMany.mockResolvedValueOnce([]);
    await expect(readTargetProvenance({ integrationSyncRecord: { findMany } } as never, {
      companyId: '00000000-0000-4000-8000-000000000099', targetKind: 'asset',
      targetId: '00000000-0000-4000-8000-000000000010',
    })).resolves.toEqual([]);
  });

  it.each([
    ['mapping company mismatch', {
      mappingCompanyId: '00000000-0000-4000-8000-000000000091',
    }],
    ['resource integration mismatch', {
      resourceIntegrationId: '00000000-0000-4000-8000-000000000092',
    }],
    ['provenance integration mismatch', {
      provenanceIntegrationId: '00000000-0000-4000-8000-000000000093',
    }],
    ['native target company mismatch', {
      targetCompanyId: '00000000-0000-4000-8000-000000000094',
    }],
  ])('omits provenance with inconsistent relational scope: %s', async (_label, mismatch) => {
    const values = mismatch as Partial<{
      mappingCompanyId: string;
      resourceIntegrationId: string;
      provenanceIntegrationId: string;
      targetCompanyId: string;
    }>;
    const targetId = '00000000-0000-4000-8000-000000000010';
    const findMany = jest.fn().mockResolvedValue([{
      integrationCompanyMappingId: ids.mapping, resourceId: ids.resource,
      targetKind: 'asset', assetId: targetId,
      subnetId: null, ipReservationId: null, articleId: null, relationId: null,
      state: 'active', staleSince: null,
      provenance: {
        integrationId: values.provenanceIntegrationId ?? ids.integration,
        externalOrgId: 'org-a', resourceKey: 'devices', externalId: 'raw-upstream-id',
        sourceRevision: null, sourceFingerprint: null,
        firstSeenAt: '2026-07-13T00:00:00.000Z', lastSeenAt: '2026-07-14T00:00:00.000Z',
        lastSyncedAt: '2026-07-14T00:01:00.000Z', ownership: 'breeze', state: 'active',
      },
      asset: { name: 'HV-01', companyId: values.targetCompanyId ?? ids.company },
      subnet: null, ipReservation: null, article: null, relation: null,
      companyMapping: {
        companyId: values.mappingCompanyId ?? ids.company,
        integration: { id: ids.integration, name: 'Breeze', driver: 'breeze' },
      },
      resource: {
        resourceKey: 'devices',
        integrationId: values.resourceIntegrationId ?? ids.integration,
      },
    }]);
    await expect(readTargetProvenance({ integrationSyncRecord: { findMany } } as never, {
      companyId: ids.company, targetKind: 'asset', targetId,
    })).resolves.toEqual([]);
  });
  it('preserves first seen while advancing safe active provenance', () => {
    const service = new IntegrationProvenanceService({} as never, {} as never);
    const previous = {
      integrationId: ids.integration,
      externalOrgId: 'org-a',
      resourceKey: 'devices',
      externalId: 'org-a:devices:device-1',
      sourceRevision: 'rev-1',
      sourceFingerprint: 'fingerprint-1',
      firstSeenAt: '2026-07-13T00:00:00.000Z',
      lastSeenAt: '2026-07-13T00:00:00.000Z',
      lastSyncedAt: '2026-07-13T00:00:00.000Z',
      ownership: 'breeze' as const,
      state: 'active' as const,
    };

    expect(service.buildProvenance({
      integrationId: ids.integration,
      externalOrgId: 'org-a',
      resourceKey: 'devices',
      externalId: 'org-a:devices:device-1',
      sourceRevision: 'rev-2',
      sourceFingerprint: 'fingerprint-2',
      observedAt: new Date('2026-07-14T00:00:00.000Z'),
      syncedAt: new Date('2026-07-14T00:01:00.000Z'),
      state: 'active',
      previous,
    })).toEqual(expect.objectContaining({
      firstSeenAt: '2026-07-13T00:00:00.000Z',
      lastSeenAt: '2026-07-14T00:00:00.000Z',
      lastSyncedAt: '2026-07-14T00:01:00.000Z',
      sourceRevision: 'rev-2',
      sourceFingerprint: 'fingerprint-2',
      state: 'active',
    }));
  });

  it('deduplicates safe gaps without hashing the message or rejected value and resolves only older scope gaps', async () => {
    const upsert = jest.fn();
    const updateMany = jest.fn();
    const tx = { integrationReconstructionGap: { upsert, updateMany } };
    const service = new IntegrationProvenanceService({} as never, {} as never);
    const scope = {
      companyId: ids.company,
      integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource,
      observedAt: new Date('2026-07-14T12:00:00.000Z'),
    };

    await service.persistGaps(tx as never, scope, [{
      externalId: 'org-a:scripts:script-1',
      syncRecordId: null,
      kind: 'secret_blocked',
      message: 'Definition requires manual remediation.',
      details: { reasonCode: 'inline_secret' },
    }]);
    const firstKey = upsert.mock.calls[0][0].where.integrationCompanyMappingId_resourceId_dedupeKey.dedupeKey;

    upsert.mockClear();
    await service.persistGaps(tx as never, scope, [{
      externalId: 'org-a:scripts:script-1',
      syncRecordId: null,
      kind: 'secret_blocked',
      message: 'Different safe operator wording.',
      details: { reasonCode: 'inline_secret' },
    }]);
    expect(upsert.mock.calls[0][0].where.integrationCompanyMappingId_resourceId_dedupeKey.dedupeKey)
      .toBe(firstKey);

    await service.resolveAbsentGaps(tx as never, scope);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        companyId: ids.company,
        integrationCompanyMappingId: ids.mapping,
        resourceId: ids.resource,
        resolvedAt: null,
        lastSeenAt: { lt: scope.observedAt },
        NOT: { dedupeKey: { startsWith: 'completeness:' } },
      },
      data: { resolvedAt: scope.observedAt },
    });
    expect(JSON.stringify(upsert.mock.calls)).not.toContain('rejected-secret-value');
  });

  it('drops a credential-like external identity before persistence and dedupe', async () => {
    const upsert = jest.fn();
    const tx = { integrationReconstructionGap: { upsert, updateMany: jest.fn() } };
    const service = new IntegrationProvenanceService({} as never, {} as never);
    const credentialIdentity = 'password=super-secret-value-that-must-not-persist';
    await service.persistGaps(tx as never, {
      companyId: ids.company,
      integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource,
      observedAt: new Date('2026-07-14T12:00:00.000Z'),
    }, [{
      externalId: credentialIdentity,
      syncRecordId: null,
      kind: 'validation',
      message: 'Input requires operator review.',
      details: { reasonCode: 'unsafe_identity' },
    }]);
    expect(JSON.stringify(upsert.mock.calls)).not.toContain(credentialIdentity);
  });

  it('detects the same source UUID under another mapping without reading or mutating a target', async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: 'old-binding', companyId: 'old-company' }]);
    const tx = { integrationSyncRecord: { findMany } };
    const service = new IntegrationProvenanceService({} as never, {} as never);
    await expect(service.findMoveConflict(tx as never, {
      integrationId: ids.integration,
      integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource,
      companyId: ids.company,
      resourceKey: 'devices',
      sourceId: '00000000-0000-4000-8000-000000000099',
    })).resolves.toEqual({ count: 1 });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        resourceId: ids.resource,
        integrationCompanyMappingId: { not: ids.mapping },
        externalId: { endsWith: ':devices:00000000-0000-4000-8000-000000000099' },
        companyMapping: { integrationId: ids.integration },
      },
      select: { id: true, companyId: true },
      orderBy: { id: 'asc' },
      take: 2,
    });
  });

  it.each([
    ['asset', 'asset', 'asset-1', 'asset'],
    ['article', 'article', 'article-1', 'article'],
    ['subnet', 'subnet', 'subnet-1', 'subnet'],
    ['IP reservation', 'ip_reservation', 'reservation-1', null],
    ['relation', 'relation', 'relation-1', null],
  ] as const)('stales an unseen exact-scope %s binding with its target-aware policy', async (
    _label,
    targetKind,
    targetId,
    archiveDelegate,
  ) => {
    const staleAt = new Date('2026-07-14T12:00:00.000Z');
    const rows = [binding(`${targetKind}-binding`, targetKind, targetId)];
    const findMany = jest.fn()
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([])
      .mockResolvedValue([]);
    const update = jest.fn();
    const tx = {
      integrationSyncRecord: { findMany, update },
      asset: { updateMany: jest.fn() },
      article: { updateMany: jest.fn() },
      subnet: { updateMany: jest.fn() },
      ipReservation: { deleteMany: jest.fn(), updateMany: jest.fn() },
      relation: { deleteMany: jest.fn(), updateMany: jest.fn() },
      upload: { updateMany: jest.fn(), deleteMany: jest.fn() },
      password: { updateMany: jest.fn(), deleteMany: jest.fn() },
      searchIndex: { updateMany: jest.fn() },
    };
    const service = new IntegrationProvenanceService({} as never, { logWithClient: jest.fn() } as never);

    await expect(service.staleUnseen(tx as never, {
      integrationId: ids.integration,
      companyId: ids.company,
      integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource,
      targetKind,
      snapshotAt: staleAt,
      auditActorId: '00000000-0000-0000-0000-000000000005',
    })).resolves.toEqual({ stale: 1, archived: archiveDelegate ? 1 : 0 });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        companyId: ids.company,
        integrationCompanyMappingId: ids.mapping,
        resourceId: ids.resource,
        targetKind,
        state: { in: ['active', 'blocked'] },
        lastSeenAt: { lt: staleAt },
      }),
      take: 201,
    }));
    if (archiveDelegate) {
      expect(tx[archiveDelegate].updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: { in: [targetId] }, companyId: ids.company, archivedAt: null },
      }));
    }
    if (targetKind === 'asset') {
      expect(tx.searchIndex.updateMany).toHaveBeenCalledWith({
        where: {
          entityType: 'Asset', entityId: { in: [targetId] },
          companyId: ids.company, archivedAt: null,
        },
        data: { archivedAt: staleAt },
      });
    }
    expect(tx.ipReservation.deleteMany).not.toHaveBeenCalled();
    expect(tx.ipReservation.updateMany).not.toHaveBeenCalled();
    expect(tx.relation.deleteMany).not.toHaveBeenCalled();
    expect(tx.relation.updateMany).not.toHaveBeenCalled();
    expect(tx.upload.updateMany).not.toHaveBeenCalled();
    expect(tx.upload.deleteMany).not.toHaveBeenCalled();
    expect(tx.password.updateMany).not.toHaveBeenCalled();
    expect(tx.password.deleteMany).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toEqual(expect.objectContaining({
      data: expect.objectContaining({ state: 'stale', staleSince: staleAt }),
    }));
  });

  it.each(['asset', 'article', 'subnet'] as const)(
    'stales only the disappearing binding without archiving a shared %s target',
    async (targetKind) => {
      const targetId = `${targetKind}-shared`;
      const disappearing = binding('disappearing', targetKind, targetId);
      const stillActive = binding('still-active', targetKind, targetId);
      stillActive.provenance = { ...stillActive.provenance, ownership: 'weavestream' };
      const findMany = jest.fn()
        .mockResolvedValueOnce([disappearing])
        .mockResolvedValueOnce([stillActive]);
      const tx = {
        integrationSyncRecord: { findMany, update: jest.fn() },
        asset: { updateMany: jest.fn() }, article: { updateMany: jest.fn() },
        subnet: { updateMany: jest.fn() }, searchIndex: { updateMany: jest.fn() },
      };
      const service = new IntegrationProvenanceService({} as never, {} as never);
      await expect(service.staleUnseen(tx as never, {
        integrationId: ids.integration,
        companyId: ids.company,
        integrationCompanyMappingId: ids.mapping,
        resourceId: ids.resource,
        targetKind,
        snapshotAt: new Date('2026-07-14T12:00:00.000Z'),
        auditActorId: '00000000-0000-0000-0000-000000000005',
      })).resolves.toEqual({ stale: 1, archived: 0 });
      expect(tx[targetKind].updateMany).not.toHaveBeenCalled();
      expect(tx.integrationSyncRecord.update).toHaveBeenCalledTimes(1);
      expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({
        where: expect.not.objectContaining({ provenance: expect.anything() }),
        distinct: [targetKind === 'asset' ? 'assetId' : targetKind === 'article' ? 'articleId' : 'subnetId'],
      }));
    },
  );

  it('includes an unseen blocked Breeze binding in an authoritative stale transition', async () => {
    const blocked = binding('blocked-binding', 'article', 'article-blocked');
    blocked.state = 'blocked';
    blocked.provenance = { ...blocked.provenance, state: 'blocked' };
    const tx = {
      integrationSyncRecord: {
        findMany: jest.fn().mockResolvedValueOnce([blocked]).mockResolvedValueOnce([]),
        update: jest.fn(),
      },
      asset: { updateMany: jest.fn() }, article: { updateMany: jest.fn() },
      subnet: { updateMany: jest.fn() }, searchIndex: { updateMany: jest.fn() },
    };
    const service = new IntegrationProvenanceService({} as never, {} as never);

    await expect(service.staleUnseen(tx as never, {
      integrationId: ids.integration, companyId: ids.company,
      integrationCompanyMappingId: ids.mapping, resourceId: ids.resource,
      targetKind: 'article', snapshotAt: new Date('2026-07-14T12:00:00.000Z'),
      auditActorId: '00000000-0000-0000-0000-000000000005',
    })).resolves.toEqual({ stale: 1, archived: 1 });
    expect(tx.integrationSyncRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ state: { in: ['active', 'blocked'] } }),
    }));
    expect(tx.integrationSyncRecord.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'blocked-binding' }, data: expect.objectContaining({ state: 'stale' }),
    }));
  });

  it('does not overwrite the asset search archive timestamp when the native row was already archived', async () => {
    const row = binding('asset-binding', 'asset', 'asset-1');
    const tx = {
      integrationSyncRecord: {
        findMany: jest.fn().mockResolvedValueOnce([row]).mockResolvedValueOnce([]),
        update: jest.fn(),
      },
      asset: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      article: { updateMany: jest.fn() }, subnet: { updateMany: jest.fn() },
      searchIndex: { updateMany: jest.fn() },
    };
    const service = new IntegrationProvenanceService({} as never, {} as never);
    await expect(service.staleUnseen(tx as never, {
      integrationId: ids.integration, companyId: ids.company,
      integrationCompanyMappingId: ids.mapping, resourceId: ids.resource,
      targetKind: 'asset', snapshotAt: new Date('2026-07-14T12:00:00.000Z'),
      auditActorId: '00000000-0000-0000-0000-000000000005',
    })).resolves.toEqual({ stale: 1, archived: 0 });
    expect(tx.searchIndex.updateMany).not.toHaveBeenCalled();
  });

  it('does not mutate a manually owned or invalid-provenance binding', async () => {
    const tx = {
      integrationSyncRecord: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
      asset: { updateMany: jest.fn() }, article: { updateMany: jest.fn() },
      subnet: { updateMany: jest.fn() }, searchIndex: { updateMany: jest.fn() },
    };
    const service = new IntegrationProvenanceService({} as never, {} as never);
    await service.staleUnseen(tx as never, {
      integrationId: ids.integration, companyId: ids.company,
      integrationCompanyMappingId: ids.mapping, resourceId: ids.resource,
      targetKind: 'asset', snapshotAt: new Date('2026-07-14T12:00:00.000Z'),
      auditActorId: '00000000-0000-0000-0000-000000000005',
    });
    expect(tx.integrationSyncRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        provenance: { path: ['ownership'], equals: 'breeze' },
      }),
    }));
    expect(tx.integrationSyncRecord.update).not.toHaveBeenCalled();
  });

  it('never processes a binding whose target kind is outside the resource scope', async () => {
    const tx = {
      integrationSyncRecord: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
      asset: { updateMany: jest.fn() }, article: { updateMany: jest.fn() }, subnet: { updateMany: jest.fn() },
    };
    const service = new IntegrationProvenanceService({} as never, {} as never);
    await service.staleUnseen(tx as never, {
      integrationId: ids.integration,
      companyId: ids.company,
      integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource,
      targetKind: 'article',
      snapshotAt: new Date('2026-07-14T12:00:00.000Z'),
      auditActorId: '00000000-0000-0000-0000-000000000005',
    });
    expect(tx.integrationSyncRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ targetKind: 'article' }),
    }));
    expect(tx.asset.updateMany).not.toHaveBeenCalled();
    expect(tx.integrationSyncRecord.update).not.toHaveBeenCalled();
  });

  it('fails closed before terminal completion when a full sweep exceeds its cap', async () => {
    const rows = Array.from({ length: 201 }, (_, index) =>
      binding(`binding-${index}`, 'asset', `asset-${index}`));
    const tx = {
      integrationSyncRecord: { findMany: jest.fn().mockResolvedValue(rows), update: jest.fn() },
      asset: { updateMany: jest.fn() }, article: { updateMany: jest.fn() }, subnet: { updateMany: jest.fn() },
    };
    const service = new IntegrationProvenanceService({} as never, {} as never);
    await expect(service.staleUnseen(tx as never, {
      integrationId: ids.integration,
      companyId: ids.company,
      integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource,
      targetKind: 'asset',
      snapshotAt: new Date('2026-07-14T12:00:00.000Z'),
      auditActorId: '00000000-0000-0000-0000-000000000005',
      maxRecords: 200,
    })).rejects.toThrow(/bounded/i);
    expect(tx.integrationSyncRecord.update).not.toHaveBeenCalled();
  });
});

function binding(
  id: string,
  targetKind: 'asset' | 'article' | 'subnet' | 'ip_reservation' | 'relation',
  targetId: string,
) {
  return {
    id,
    companyId: ids.company,
    integrationCompanyMappingId: ids.mapping,
    resourceId: ids.resource,
    targetKind,
    assetId: targetKind === 'asset' ? targetId : null,
    articleId: targetKind === 'article' ? targetId : null,
    subnetId: targetKind === 'subnet' ? targetId : null,
    ipReservationId: targetKind === 'ip_reservation' ? targetId : null,
    relationId: targetKind === 'relation' ? targetId : null,
    state: 'active' as 'active' | 'blocked' | 'stale',
    staleSince: null,
    provenance: {
      integrationId: ids.integration,
      externalOrgId: 'org-a',
      resourceKey: 'devices',
      externalId: `org-a:devices:${id}`,
      sourceRevision: 'rev',
      sourceFingerprint: 'fingerprint',
      firstSeenAt: '2026-07-13T00:00:00.000Z',
      lastSeenAt: '2026-07-13T00:00:00.000Z',
      lastSyncedAt: '2026-07-13T00:00:00.000Z',
      ownership: 'breeze',
      state: 'active',
    },
  };
}
