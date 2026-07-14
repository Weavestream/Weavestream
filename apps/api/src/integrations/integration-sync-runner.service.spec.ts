import {
  IntegrationSyncRunnerService,
  validateDriverFetchPage,
} from './integration-sync-runner.service.js';
import type {
  ReconstructionInput,
  ReconstructionWriteContext,
  ReconstructionWriteOutcome,
} from './reconstruction/reconstruction-target.js';
import { AssetTargetWriter } from './reconstruction/asset-target.writer.js';
import { hasEligibleNativeBinding } from './reconstruction/native-binding-ownership.js';

describe('validateDriverFetchPage', () => {
  it('defaults a terminal legacy page without changing legacy records', () => {
    const record = { externalId: 'raw-1', displayName: 'Device', fields: {}, updatedAt: null };
    expect(validateDriverFetchPage({ records: [record], hasMore: false, cursor: null }, {
      traversalStartedAt: '2026-07-14T10:00:00.000Z',
      previousCursor: null,
      expectedSchemaVersion: null,
      expectedSnapshotAt: null,
    })).toMatchObject({
      records: [record], schemaVersion: 'legacy', snapshotAt: '2026-07-14T10:00:00.000Z',
      blockedInputs: [], terminal: true,
    });
  });

  it.each([
    [{ records: [], hasMore: true, cursor: null }, /cursor/i],
    [{ records: [], hasMore: false, cursor: 'next', terminal: true }, /terminal/i],
    [{ records: [], hasMore: true, cursor: 'same' }, /advanc/i],
  ])('fails closed on invalid cursor/terminal metadata', (page, message) => {
    expect(() => validateDriverFetchPage(page, {
      traversalStartedAt: '2026-07-14T10:00:00.000Z', previousCursor: 'same',
      expectedSchemaVersion: null, expectedSnapshotAt: null,
    })).toThrow(message);
  });

  it('requires schema and snapshot stability across pages', () => {
    expect(() => validateDriverFetchPage({
      records: [], hasMore: false, cursor: null, terminal: true,
      schemaVersion: 'v2', snapshotAt: '2026-07-14T11:00:00.000Z',
    }, {
      traversalStartedAt: '2026-07-14T10:00:00.000Z', previousCursor: 'page-1',
      expectedSchemaVersion: 'v1', expectedSnapshotAt: '2026-07-14T10:00:00.000Z',
    })).toThrow(/stable/i);
  });

  it('rejects a source high-water beyond the page snapshot', () => {
    expect(() => validateDriverFetchPage({
      records: [], hasMore: false, cursor: null, terminal: true,
      snapshotAt: '2026-07-14T10:00:00.000Z',
      sourceHighWater: '2026-07-14T10:00:00.001Z',
    }, {
      traversalStartedAt: '2026-07-14T10:00:00.000Z', previousCursor: null,
      expectedSchemaVersion: null, expectedSnapshotAt: null,
    })).toThrow(/sourceHighWater/i);
  });
});

describe('IntegrationSyncRunnerService writer dispatch', () => {
  const input = {
    targetKind: 'subnet' as const,
    externalId: 'org-1:subnets:lan',
    source: { externalOrgId: 'org-1', resourceKey: 'subnets', sourceId: 'lan' },
    name: 'LAN',
    cidr: '10.0.0.0/24',
  };

  function setup(options: {
    checkpointFails?: boolean;
    unauthorized?: boolean;
    completedCheckpoint?: boolean;
    resumeCursor?: string;
  } = {}) {
    const order: string[] = [];
    let pending: string[] = [];
    const tx = {
      integrationSyncRecord: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(async () => { pending.push('binding'); }),
        update: jest.fn(),
      },
      integrationSyncCheckpoint: {
        upsert: jest.fn(async () => {
          pending.push('checkpoint');
          if (options.checkpointFails) throw new Error('checkpoint failed');
        }),
      },
      integrationResource: { findUnique: jest.fn() },
    };
    const prisma = {
      integrationCompanyMapping: { findUnique: jest.fn().mockResolvedValue({
        id: 'mapping', integrationId: 'integration', companyId: 'company', externalOrgId: 'org-1',
        filter: {}, integration: { id: 'integration', driver: 'typed' },
      }) },
      integrationResource: { findFirst: jest.fn().mockResolvedValue({
        id: 'resource', integrationId: 'integration', resourceKey: 'subnets', enabled: true,
        targetKind: 'subnet', targetConfig: { normalization: 'cidr' }, dependsOnResourceKeys: [],
        assetLayoutId: null, assetLayout: null, matchKeyFieldIds: [], fieldMappings: [],
      }) },
      integrationSyncCheckpoint: { findUnique: jest.fn().mockResolvedValue(
        options.completedCheckpoint || options.resumeCursor !== undefined
          ? {
              cursor: options.resumeCursor ?? null,
              snapshotAt: new Date('2026-07-13T10:00:00.000Z'),
              highWaterAt: new Date('2026-07-13T09:00:00.000Z'),
            }
          : null,
      ) },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<void>) => {
        pending = [];
        try {
          const result = await callback(tx);
          order.push(...pending);
          return result;
        } finally {
          pending = [];
        }
      }),
    };
    const driver = { fetchRecords: jest.fn().mockResolvedValue({
      records: [{ reconstructionInput: input }], hasMore: false, cursor: null,
      terminal: true, snapshotAt: '2026-07-14T10:00:00.000Z',
      sourceHighWater: '2026-07-14T09:00:00.000Z',
    }) };
    const writer = { write: jest.fn<
      Promise<ReconstructionWriteOutcome>,
      [ReconstructionWriteContext, ReconstructionInput]
    >(async () => {
      pending.push('target+audit');
      return {
      targetKind: 'subnet', targetId: 'subnet-id', checksum: 'checksum', change: 'created',
      provenance: {
        integrationId: 'integration', externalOrgId: 'org-1', resourceKey: 'subnets',
        externalId: input.externalId, sourceRevision: null, sourceFingerprint: null,
        firstSeenAt: '2026-07-14T10:00:00.000Z', lastSeenAt: '2026-07-14T10:00:00.000Z',
        lastSyncedAt: '2026-07-14T10:00:00.000Z', ownership: 'breeze', state: 'active',
      }, gaps: [],
    }; }) };
    const audit = {
      assertIntegrationActor: options.unauthorized
        ? jest.fn().mockRejectedValue(new Error('forbidden'))
        : jest.fn().mockResolvedValue(undefined),
    };
    const writerRegistry = { get: jest.fn().mockReturnValue(writer) };
    const service = new IntegrationSyncRunnerService(
      prisma as never,
      { values: { INTEGRATION_HTTP_TIMEOUT_MS: 1, INTEGRATION_HTTP_MAX_RETRIES: 0, INTEGRATION_HTTP_BACKOFF_MS: 1 } } as never,
      audit as never,
      { loadDriverContext: jest.fn().mockResolvedValue({ config: {}, secret: {} }) } as never,
      { get: jest.fn().mockReturnValue(driver) } as never,
      {} as never,
      writerRegistry as never,
    );
    return { service, writer, writerRegistry, tx, order, driver, audit, prisma };
  }

  it('dispatches typed input and commits its binding before the page checkpoint', async () => {
    const { service, writer, tx, order } = setup();
    await expect(service.runMapping({
      syncRunId: 'run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'incremental',
    })).resolves.toMatchObject({ status: 'succeeded', totals: { created: 1 } });
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({ tx, existingTargetId: null }), input);
    expect(order).toEqual(['target+audit', 'binding', 'checkpoint']);
  });

  it('keeps dry runs free of binding and checkpoint writes', async () => {
    const { service, tx } = setup();
    await service.runMapping({
      syncRunId: 'run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: true, actorId: 'actor', mode: 'full',
    });
    expect(tx.integrationSyncRecord.upsert).not.toHaveBeenCalled();
    expect(tx.integrationSyncCheckpoint.upsert).not.toHaveBeenCalled();
  });

  it('rolls target/audit, binding, and checkpoint work back when the page checkpoint fails', async () => {
    const { service, order } = setup({ checkpointFails: true });
    await expect(service.runMapping({
      syncRunId: 'run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'incremental',
    })).resolves.toMatchObject({ status: 'failed', error: 'checkpoint failed' });
    expect(order).toEqual([]);
  });

  it('rolls the page back and does not checkpoint a retryable native failure', async () => {
    const { service, writer, tx, order } = setup();
    writer.write.mockResolvedValueOnce({
      targetKind: 'subnet', targetId: '', checksum: 'blocked', change: 'blocked',
      provenance: {
        integrationId: '00000000-0000-0000-0000-000000000001',
        externalOrgId: 'org-1', resourceKey: 'subnets', externalId: input.externalId,
        sourceRevision: null, sourceFingerprint: null,
        firstSeenAt: '2026-07-14T10:00:00.000Z', lastSeenAt: '2026-07-14T10:00:00.000Z',
        lastSyncedAt: null, ownership: 'breeze', state: 'blocked',
      },
      gaps: [{ kind: 'synchronization_error', message: 'native write failed' }],
    });
    await expect(service.runMapping({
      syncRunId: 'run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'incremental',
    })).resolves.toMatchObject({ status: 'failed' });
    expect(order).toEqual([]);
    expect(tx.integrationSyncCheckpoint.upsert).not.toHaveBeenCalled();
  });

  it('starts a fresh snapshot after a completed checkpoint while retaining terminal metadata', async () => {
    const { service, tx, driver } = setup({ completedCheckpoint: true });
    await service.runMapping({
      syncRunId: 'run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'full',
    });
    expect(driver.fetchRecords).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotAt: null }),
      null,
    );
    expect(tx.integrationSyncCheckpoint.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          cursor: null,
          snapshotAt: new Date('2026-07-14T10:00:00.000Z'),
        }),
      }),
    );
  });

  it('resumes an opaque empty-string cursor with its committed snapshot', async () => {
    const { service, driver } = setup({ resumeCursor: '' });
    await service.runMapping({
      syncRunId: 'run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'incremental',
    });
    expect(driver.fetchRecords).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotAt: '2026-07-13T10:00:00.000Z' }),
      '',
    );
  });

  it('rolls back a driver-declared retryable synchronization gap', async () => {
    const { service, driver, tx, order } = setup();
    driver.fetchRecords.mockResolvedValueOnce({
      records: [], hasMore: false, cursor: null, terminal: true,
      blockedInputs: [{
        kind: 'synchronization_error', externalId: null, message: 'retry upstream',
        details: { retryable: true },
      }],
    });
    await expect(service.runMapping({
      syncRunId: 'run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'incremental',
    })).resolves.toMatchObject({ status: 'failed', error: 'retry upstream' });
    expect(order).toEqual([]);
    expect(tx.integrationSyncCheckpoint.upsert).not.toHaveBeenCalled();
  });

  it('does not dispatch or create a targetless binding for an invalid typed record', async () => {
    const { service, writer, tx, driver } = setup();
    driver.fetchRecords.mockResolvedValueOnce({
      records: [{ reconstructionInput: { ...input, externalId: 'wrong' } }],
      hasMore: false, cursor: null, terminal: true,
    });
    await service.runMapping({
      syncRunId: 'run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'incremental',
    });
    expect(writer.write).not.toHaveBeenCalled();
    expect(tx.integrationSyncRecord.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['real', false],
    ['dry-run', true],
  ] as const)('%s migration clones a raw legacy binding with active Breeze provenance', async (_label, dryRun) => {
    const { service, writerRegistry, tx, driver, prisma } = setup();
    const integrationId = '00000000-0000-0000-0000-000000000020';
    prisma.integrationCompanyMapping.findUnique.mockResolvedValueOnce({
      id: 'mapping', integrationId, companyId: 'company', externalOrgId: 'org-1',
      filter: {}, integration: { id: integrationId, driver: 'typed' },
    });
    prisma.integrationResource.findFirst.mockResolvedValueOnce({
      id: 'resource', integrationId: 'integration', resourceKey: 'devices', enabled: true,
      targetKind: 'asset', targetConfig: {}, dependsOnResourceKeys: [],
      assetLayoutId: '00000000-0000-0000-0000-000000000021',
      assetLayout: { fields: [] }, matchKeyFieldIds: [], fieldMappings: [{
        sourceField: 'serial', syncDirection: 'source_wins', transform: null,
        targetField: {
          id: '00000000-0000-0000-0000-000000000022', slug: 'serial',
          fieldType: 'TEXT', options: {}, archivedAt: null,
        },
      }],
    });
    driver.fetchRecords.mockResolvedValueOnce({
      records: [{ externalId: 'raw-1', displayName: 'Device', fields: { serial: 'S1' }, updatedAt: null }],
      hasMore: false, cursor: null, terminal: true,
    });
    const legacy = {
      id: 'binding', externalId: 'raw-1', targetKind: 'asset', assetId: 'asset-1',
      subnetId: null, ipReservationId: null, articleId: null, relationId: null,
      state: 'active', checksum: 'old', lastSyncedFieldChecksums: {}, provenance: {},
      companyId: 'company', resourceId: 'resource', integrationCompanyMappingId: 'mapping',
      companyMapping: { integrationId, externalOrgId: 'org-1' },
      resource: { integrationId, resourceKey: 'devices' },
    };
    let transactionBinding = { ...legacy };
    tx.integrationSyncRecord.findUnique.mockImplementation(async ({ where }: {
      where: { integrationCompanyMappingId_resourceId_externalId: { externalId: string } };
    }) => where.integrationCompanyMappingId_resourceId_externalId.externalId === transactionBinding.externalId
      ? transactionBinding
      : null);
    tx.integrationSyncRecord.update.mockImplementation(async ({ data }: { data: object }) => {
      transactionBinding = { ...transactionBinding, ...data };
      return transactionBinding;
    });
    prisma.$transaction.mockImplementation(async (callback: (client: typeof tx) => Promise<void>) => {
      const before = transactionBinding;
      try {
        await callback(tx);
      } catch (error) {
        transactionBinding = before;
        throw error;
      }
    });
    const nativePort = { writeFromIntegration: jest.fn(async (nativeInput: {
      integrationCompanyMappingId: string; resourceId: string; externalId: string;
      integrationId: string; companyId: string; existingTargetId?: string | null;
    }) => {
      await expect(hasEligibleNativeBinding(tx as never, {
        integrationCompanyMappingId: nativeInput.integrationCompanyMappingId,
        resourceId: nativeInput.resourceId,
        externalId: nativeInput.externalId,
        integrationId: nativeInput.integrationId,
        companyId: nativeInput.companyId,
        targetKind: 'asset',
        targetId: nativeInput.existingTargetId!,
      })).resolves.toBe(true);
      return { targetId: nativeInput.existingTargetId!, companyId: nativeInput.companyId, change: 'updated' as const };
    }) };
    const assetWriter = new AssetTargetWriter(nativePort);
    let capturedOutcome: ReconstructionWriteOutcome | null = null;
    writerRegistry.get.mockReturnValue({
      targetKind: 'asset',
      write: async (ctx: ReconstructionWriteContext, reconstruction: ReconstructionInput) => {
        assetWriter.validate(reconstruction as never);
        capturedOutcome = await assetWriter.write(ctx, reconstruction as never);
        return capturedOutcome;
      },
    });
    const result = await service.runMapping({
      syncRunId: 'run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun, actorId: 'actor', mode: 'incremental',
    });
    if (result.status === 'failed') throw new Error(result.error ?? JSON.stringify(result.conflicts));
    expect(tx.integrationSyncRecord.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        externalId: 'org-1:devices:raw-1',
        provenance: expect.objectContaining({ ownership: 'breeze', state: 'active' }),
      }),
    }));
    expect(capturedOutcome).toMatchObject({ change: 'updated', gaps: [] });
    expect(nativePort.writeFromIntegration).toHaveBeenCalled();
    expect(transactionBinding.externalId).toBe(
      dryRun ? 'raw-1' : 'org-1:devices:raw-1',
    );
  });

  it.each([
    ['missing', null, false],
    ['unauthorized', 'actor', true],
  ])('keeps a %s audit actor from reaching a writer', async (_label, actorId, unauthorized) => {
    const { service, writer } = setup({ unauthorized });
    await service.runMapping({
      syncRunId: 'run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId, mode: 'incremental',
    });
    expect(writer.write).not.toHaveBeenCalled();
  });
});
