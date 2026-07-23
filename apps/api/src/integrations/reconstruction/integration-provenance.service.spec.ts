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
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const $executeRaw = jest.fn().mockResolvedValue(1);
    const $queryRaw = jest.fn().mockResolvedValue([{ id: 'watermark-row' }]);
    const tx = { integrationReconstructionGap: { updateMany }, $executeRaw, $queryRaw };
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
    // The guarded update always leads with the dedupe key in its where.
    const firstKey = updateMany.mock.calls[0][0].where.dedupeKey;
    expect(typeof firstKey).toBe('string');

    await service.persistGaps(tx as never, scope, [{
      externalId: 'org-a:scripts:script-1',
      syncRecordId: null,
      kind: 'secret_blocked',
      message: 'Different safe operator wording.',
      details: { reasonCode: 'inline_secret' },
    }]);
    expect(updateMany.mock.calls[1][0].where.dedupeKey).toBe(firstKey);

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
    expect(JSON.stringify($executeRaw.mock.calls)).not.toContain('rejected-secret-value');
    expect(JSON.stringify(updateMany.mock.calls)).not.toContain('rejected-secret-value');
  });

  it('drops a credential-like external identity before persistence and dedupe', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const $executeRaw = jest.fn().mockResolvedValue(1);
    const $queryRaw = jest.fn().mockResolvedValue([{ id: 'watermark-row' }]);
    const tx = { integrationReconstructionGap: { updateMany }, $executeRaw, $queryRaw };
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
    expect(JSON.stringify($executeRaw.mock.calls)).not.toContain(credentialIdentity);
    expect(JSON.stringify(updateMany.mock.calls)).not.toContain(credentialIdentity);
  });

  it('guards every gap write by recency and stops after one retry when a newer run owns the row', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const $executeRaw = jest.fn().mockResolvedValue(0);
    const $queryRaw = jest.fn().mockResolvedValue([{ id: 'watermark-row' }]);
    const tx = { integrationReconstructionGap: { updateMany }, $executeRaw, $queryRaw };
    const service = new IntegrationProvenanceService({} as never, {} as never);
    const observedAt = new Date('2026-07-14T12:00:00.000Z');

    await service.persistGaps(tx as never, {
      companyId: ids.company,
      integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource,
      observedAt,
    }, [{
      externalId: 'org-a:scripts:script-1',
      syncRecordId: 'binding-1',
      kind: 'secret_blocked',
      message: 'Definition requires manual remediation.',
      details: { reasonCode: 'inline_secret' },
    }]);

    // initial guarded write plus exactly one post-insert-race retry
    expect(updateMany).toHaveBeenCalledTimes(2);
    for (const [arg] of updateMany.mock.calls) {
      expect(typeof arg.where.dedupeKey).toBe('string');
      expect(arg.where.OR).toEqual([
        { resolvedAt: null, lastSeenAt: { lte: observedAt } },
        { resolvedAt: { lte: observedAt } },
      ]);
      expect(arg.data).toMatchObject({ resolvedAt: null, lastSeenAt: observedAt });
    }
    // the insert is a single statement carrying both the conflict skip
    // and the scope-watermark predicate
    expect($executeRaw).toHaveBeenCalledTimes(1);
    const [strings] = $executeRaw.mock.calls[0];
    const sql = (strings as readonly string[]).join('?');
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('WHERE NOT EXISTS');
    expect(sql).toContain('"evaluated_at" >');
    // the scope watermark lock is taken before any gap row is touched,
    // preserving the summary-first lock order shared with the
    // completeness paths
    expect($queryRaw).toHaveBeenCalledTimes(1);
    const [lockStrings] = $queryRaw.mock.calls[0];
    const lockSql = (lockStrings as readonly string[]).join('?');
    expect(lockSql).toContain('FOR UPDATE');
    expect(lockSql).toContain('"company_id"');
    expect($queryRaw.mock.invocationCallOrder[0]!)
      .toBeLessThan(updateMany.mock.invocationCallOrder[0]!);
    // the watermark subquery of the insert is tenant-scoped as well
    const gapInsertSql = ($executeRaw.mock.calls[0][0] as readonly string[]).join('?');
    expect(gapInsertSql).toContain('summary."company_id"');
  });

  it('seeds a cleared watermark tombstone before any gap work on a never-evaluated scope', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const $executeRaw = jest.fn().mockResolvedValue(1);
    const $queryRaw = jest.fn().mockResolvedValue([]);
    const tx = { integrationReconstructionGap: { updateMany }, $executeRaw, $queryRaw };
    const service = new IntegrationProvenanceService({} as never, {} as never);

    await service.persistGaps(tx as never, {
      companyId: ids.company,
      integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource,
      observedAt: new Date('2026-07-14T12:00:00.000Z'),
    }, [{
      externalId: 'org-a:scripts:script-cold',
      syncRecordId: null,
      kind: 'secret_blocked',
      message: 'Definition requires manual remediation.',
      details: { reasonCode: 'inline_secret' },
    }]);

    // FOR UPDATE found nothing, so the row is seeded as a cleared
    // tombstone before any gap statement runs — first evaluations get a
    // serialization point too.
    const [seedStrings, ...seedValues] = $executeRaw.mock.calls[0];
    const seedSql = (seedStrings as readonly string[]).join('?');
    expect(seedSql).toContain('integration_reconstruction_summaries');
    expect(seedSql).toContain('ON CONFLICT');
    expect(seedSql).toContain('"cleared_at"');
    // the seed is gated on the mapping belonging to the caller's
    // company, so inconsistent scope input cannot create a cross-scope
    // row
    expect(seedSql).toContain('integration_company_mappings');
    // The seed's evaluatedAt is the NEUTRAL epoch, never the page's
    // snapshot time: this helper runs on non-terminal pages, and a seed
    // carrying the snapshot time would survive a failed run and reject
    // legitimate older-snapshot terminal evaluations. Only terminal
    // writes may advance the clock.
    expect(seedValues.filter((value: unknown) =>
      value instanceof Date && value.getTime() === 0)).toHaveLength(1);
    expect($executeRaw.mock.invocationCallOrder[0]!)
      .toBeLessThan(updateMany.mock.invocationCallOrder[0]!);
    // the winning seed already holds the new row's lock: one probe, no re-lock
    expect($queryRaw).toHaveBeenCalledTimes(1);
    // the gap insert still follows as the second raw statement
    expect($executeRaw).toHaveBeenCalledTimes(2);
  });

  it('re-acquires the watermark lock after losing a concurrent seed race', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const $executeRaw = jest.fn()
      .mockResolvedValueOnce(0)
      .mockResolvedValue(1);
    const $queryRaw = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: 'watermark-row' }]);
    const tx = { integrationReconstructionGap: { updateMany }, $executeRaw, $queryRaw };
    const service = new IntegrationProvenanceService({} as never, {} as never);

    await service.persistGaps(tx as never, {
      companyId: ids.company,
      integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource,
      observedAt: new Date('2026-07-14T12:00:00.000Z'),
    }, [{
      externalId: 'org-a:scripts:script-cold-race',
      syncRecordId: null,
      kind: 'secret_blocked',
      message: 'Definition requires manual remediation.',
      details: { reasonCode: 'inline_secret' },
    }]);

    // probe (empty) → seed lost to a concurrent transaction → the
    // second FOR UPDATE queues on the committed winner before gap work
    expect($queryRaw).toHaveBeenCalledTimes(2);
    expect($queryRaw.mock.invocationCallOrder[1]!)
      .toBeLessThan(updateMany.mock.invocationCallOrder[0]!);
  });

  it('fails closed instead of proceeding unserialized when the scope pairing is inconsistent', async () => {
    const updateMany = jest.fn();
    // probe empty, seed blocked (mapping-binding guard or foreign-row
    // conflict), re-lock still finds nothing in the caller's scope
    const $executeRaw = jest.fn().mockResolvedValue(0);
    const $queryRaw = jest.fn().mockResolvedValue([]);
    const tx = { integrationReconstructionGap: { updateMany }, $executeRaw, $queryRaw };
    const service = new IntegrationProvenanceService({} as never, {} as never);

    await expect(service.persistGaps(tx as never, {
      companyId: ids.company,
      integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource,
      observedAt: new Date('2026-07-14T12:00:00.000Z'),
    }, [{
      externalId: 'org-a:scripts:script-mismatch',
      syncRecordId: null,
      kind: 'validation',
      message: 'Input requires operator review.',
      details: { reasonCode: 'unsafe_identity' },
    }])).rejects.toThrow('Reconstruction watermark scope mismatch.');
    // no gap statement may run without the scoped lock
    expect(updateMany).not.toHaveBeenCalled();
    expect($executeRaw).toHaveBeenCalledTimes(1);
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
    const tx = {
      integrationSyncRecord: { findMany, update: jest.fn() },
      asset: { updateMany: jest.fn() },
      article: { updateMany: jest.fn() },
      subnet: { updateMany: jest.fn() },
      ipReservation: { deleteMany: jest.fn(), updateMany: jest.fn() },
      relation: { deleteMany: jest.fn(), updateMany: jest.fn() },
      upload: { updateMany: jest.fn(), deleteMany: jest.fn() },
      password: { updateMany: jest.fn(), deleteMany: jest.fn() },
      searchIndex: { updateMany: jest.fn() },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const audit = { logManyWithClient: jest.fn() };
    const service = new IntegrationProvenanceService({} as never, audit as never);

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
    expect(tx.integrationSyncRecord.update).not.toHaveBeenCalled();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(audit.logManyWithClient).toHaveBeenCalledWith(tx, [{
      actorId: '00000000-0000-0000-0000-000000000005',
      action: 'integration.target.stale',
      entityType: 'IntegrationTarget',
      entityId: targetId,
      companyId: ids.company,
      ip: '0.0.0.0',
      userAgent: 'weavestream-worker/integration-reconstruction',
      after: {
        integrationId: ids.integration,
        integrationCompanyMappingId: ids.mapping,
        resourceId: ids.resource,
        targetId,
        targetKind,
        state: 'stale',
        counts: { records: 1, gaps: 0 },
      },
    }]);
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
        $executeRaw: jest.fn().mockResolvedValue(1),
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
      expect(tx.integrationSyncRecord.update).not.toHaveBeenCalled();
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({
        where: expect.not.objectContaining({ provenance: expect.anything() }),
        distinct: [targetKind === 'asset' ? 'assetId' : targetKind === 'article' ? 'articleId' : 'subnetId'],
      }));
    },
  );

  it('batches 501 binding provenance transitions and target-level audits', async () => {
    const staleAt = new Date('2026-07-14T12:00:00.000Z');
    const rows = Array.from({ length: 501 }, (_, index) => binding(
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      'asset',
      `00000000-0000-4000-9000-${String(index + 1).padStart(12, '0')}`,
    ));
    const findMany = jest.fn(async (args: { cursor?: { id: string }; distinct?: string[] }) => {
      if (args.distinct) return [];
      return args.cursor ? rows.slice(500) : rows;
    });
    const tx = {
      integrationSyncRecord: { findMany, update: jest.fn() },
      asset: { updateMany: jest.fn(async (args: { where: { id: { in: string[] } } }) => ({
        count: args.where.id.in.length,
      })) },
      article: { updateMany: jest.fn() }, subnet: { updateMany: jest.fn() },
      searchIndex: { updateMany: jest.fn() },
      $executeRaw: jest.fn().mockResolvedValue(500),
    };
    const audit = { logManyWithClient: jest.fn().mockResolvedValue(undefined) };
    const service = new IntegrationProvenanceService({} as never, audit as never);

    await expect(service.staleUnseen(tx as never, {
      integrationId: ids.integration, companyId: ids.company,
      integrationCompanyMappingId: ids.mapping, resourceId: ids.resource,
      targetKind: 'asset', snapshotAt: staleAt,
      auditActorId: '00000000-0000-0000-0000-000000000005', batchSize: 500,
    })).resolves.toEqual({ stale: 501, archived: 501 });

    expect(tx.integrationSyncRecord.update).not.toHaveBeenCalled();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(audit.logManyWithClient).toHaveBeenCalledTimes(1);
    const entries = audit.logManyWithClient.mock.calls[0]![1];
    expect(entries).toHaveLength(501);
    expect(entries[0]).toEqual(expect.objectContaining({
      action: 'integration.target.stale', entityId: rows[0]!.assetId,
      after: expect.objectContaining({ targetId: rows[0]!.assetId, state: 'stale' }),
    }));
    expect(entries[500]).toEqual(expect.objectContaining({
      action: 'integration.target.stale', entityId: rows[500]!.assetId,
      after: expect.objectContaining({ targetId: rows[500]!.assetId, state: 'stale' }),
    }));
  });

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
      $executeRaw: jest.fn().mockResolvedValue(1),
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
    expect(tx.integrationSyncRecord.update).not.toHaveBeenCalled();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
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
      $executeRaw: jest.fn().mockResolvedValue(1),
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
