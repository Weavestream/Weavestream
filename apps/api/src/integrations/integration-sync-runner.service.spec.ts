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
import { BreezeDriver } from './drivers/breeze/breeze.driver.js';
import { buildResourceExecutionStages } from './integration-sync.service.js';
import type { AssetReconstructionInput } from './reconstruction/reconstruction-target.js';
import { z } from 'zod';
import { integrationAssetExternalSource } from './integration-asset-source.js';

jest.mock('../uploads/uploads.service.js', () => ({
  UploadsService: class UploadsService {},
}));

let AssetsService: typeof import('../assets/assets.service.js').AssetsService;

beforeAll(async () => {
  ({ AssetsService } = await import('../assets/assets.service.js'));
});

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

  it('rejects an A-B-A cursor cycle before committing or fetching A again', async () => {
    const { service, driver, tx } = setup({ resumeCursor: 'A' });
    driver.fetchRecords
      .mockResolvedValueOnce({
        records: [], hasMore: true, cursor: 'B', terminal: false,
        schemaVersion: '1', snapshotAt: '2026-07-13T10:00:00.000Z',
        sourceHighWater: '2026-07-13T09:30:00.000Z',
      })
      .mockResolvedValueOnce({
        records: [{ reconstructionInput: input }], hasMore: true, cursor: 'A', terminal: false,
        schemaVersion: '1', snapshotAt: '2026-07-13T10:00:00.000Z',
        sourceHighWater: '2026-07-13T09:45:00.000Z',
      });
    await expect(service.runMapping({
      syncRunId: 'run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'incremental',
    })).resolves.toMatchObject({ status: 'failed', error: expect.stringMatching(/cursor.*cycle/i) });
    expect(driver.fetchRecords).toHaveBeenCalledTimes(2);
    expect(tx.integrationSyncCheckpoint.upsert).toHaveBeenCalledTimes(1);
    expect(tx.integrationSyncCheckpoint.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          cursor: 'B',
          highWaterAt: new Date('2026-07-13T09:00:00.000Z'),
        }),
        update: expect.objectContaining({
          cursor: 'B',
        }),
      }),
    );
    const checkpointCalls = tx.integrationSyncCheckpoint.upsert.mock.calls as unknown as Array<
      [{ update: Record<string, unknown> }]
    >;
    expect(checkpointCalls[0]![0].update).not.toHaveProperty('highWaterAt');
    expect(tx.integrationSyncRecord.upsert).not.toHaveBeenCalled();
  });

  it('rejects regressing page high-water before committing that page', async () => {
    const { service, driver, tx } = setup();
    driver.fetchRecords
      .mockResolvedValueOnce({
        records: [], hasMore: true, cursor: 'A', terminal: false,
        schemaVersion: '1', snapshotAt: '2026-07-14T10:00:00.000Z',
        sourceHighWater: '2026-07-14T09:30:00.000Z',
      })
      .mockResolvedValueOnce({
        records: [{ reconstructionInput: input }], hasMore: false, cursor: null, terminal: true,
        schemaVersion: '1', snapshotAt: '2026-07-14T10:00:00.000Z',
        sourceHighWater: '2026-07-14T09:15:00.000Z',
      });
    await expect(service.runMapping({
      syncRunId: 'run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'incremental',
    })).resolves.toMatchObject({
      status: 'failed', error: expect.stringMatching(/high-water.*regress/i),
    });
    expect(tx.integrationSyncCheckpoint.upsert).toHaveBeenCalledTimes(1);
    expect(tx.integrationSyncRecord.upsert).not.toHaveBeenCalled();
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
      records: [{
        externalId: 'raw-1', displayName: 'Device', fields: { serial: 'S1' }, updatedAt: null,
        sourceRevision: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64),
      }],
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
    expect(capturedOutcome).toMatchObject({
      provenance: {
        sourceRevision: 'a'.repeat(64),
        sourceFingerprint: 'b'.repeat(64),
      },
    });
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

describe('Breeze foundational asset composition', () => {
  const integrationA = '00000000-0000-4000-8000-000000000101';
  const integrationB = '00000000-0000-4000-8000-000000000102';
  const mapping = '00000000-0000-4000-8000-000000000103';
  const company = '00000000-0000-4000-8000-000000000104';
  const org = '00000000-0000-4000-8000-000000000105';
  const layout = '00000000-0000-4000-8000-000000000106';
  const sourceField = '00000000-0000-4000-8000-000000000107';
  const manualField = '00000000-0000-4000-8000-000000000108';
  const manualOnlyField = '00000000-0000-4000-8000-000000000109';

  it('namespaces Breeze identities without changing established driver sources', () => {
    expect(integrationAssetExternalSource('breeze', integrationA)).toBe(
      `breeze:${integrationA}`,
    );
    for (const driver of ['action1', 'ninjaone', 'unifi']) {
      expect(integrationAssetExternalSource(driver, integrationA)).toBe(driver);
    }
  });

  it('orders the real Breeze sites resource before devices', () => {
    const resources = new BreezeDriver().descriptor.resources.filter(({ key }) =>
      key === 'sites' || key === 'devices');
    expect(buildResourceExecutionStages(resources.map((resource) => ({
      id: resource.key,
      resourceKey: resource.key,
      dependsOnResourceKeys: resource.dependsOnResourceKeys,
    })))).toEqual([
      [expect.objectContaining({ resourceKey: 'sites' })],
      [expect.objectContaining({ resourceKey: 'devices' })],
    ]);
  });

  it('runs real Breeze site/device fetch transforms through the runner and AssetTargetWriter', async () => {
    const siteId = '00000000-0000-4000-8000-000000000111';
    const deviceId = '00000000-0000-4000-8000-000000000112';
    const siteResourceId = '00000000-0000-4000-8000-000000000113';
    const deviceResourceId = '00000000-0000-4000-8000-000000000114';
    const revision = 'a'.repeat(64);
    const updatedAt = '2026-07-14T11:00:00.000Z';
    const site = {
      id: siteId, orgId: org, siteId, sourceUpdatedAt: updatedAt, revision,
      name: 'HQ', timezone: 'America/Denver', address: null, contact: null,
    };
    const device = {
      id: deviceId, orgId: org, siteId, sourceUpdatedAt: updatedAt, revision,
      hostname: 'ws-01', displayName: 'Workstation 01',
      type: { os: 'windows', role: 'workstation', virtual: false, virtualizationPlatform: null },
      operatingSystem: { edition: 'Windows 11 Pro', build: '26100', architecture: 'x64' },
      installation: { enrolledAt: '2025-01-01T00:00:00.000Z' },
      hardwareIdentity: { serialNumber: 'SER-1', manufacturer: 'Dell', model: 'Latitude' },
      stableIdentifiers: { assetTag: null, inventoryId: null, externalId: null },
      tags: ['managed'], groupIds: [],
      groupMembership: { total: 0, included: 0, complete: true, reason: null },
      linkGroupId: null, linkGroupRole: null,
    };
    const client = {
      testConnection: jest.fn(),
      listOrganizations: jest.fn(),
      fetchPage: jest.fn(async (_ctx: unknown, input: { resource: string }) => ({
        schemaVersion: '1' as const, snapshotAt: '2026-07-14T12:00:00.000Z',
        data: input.resource === 'sites' ? [site] : [device],
        nextCursor: null, hasMore: false as const, blocked: [],
      })),
    };
    const breeze = new BreezeDriver(client);
    const resources = new Map([
      [siteResourceId, {
        id: siteResourceId, integrationId: integrationA, resourceKey: 'sites', enabled: true,
        targetKind: 'asset', targetConfig: {}, dependsOnResourceKeys: [], assetLayoutId: layout,
        assetLayout: { fields: [] }, matchKeyFieldIds: [],
        fieldMappings: [{ sourceField: 'name', syncDirection: 'source_wins', transform: null,
          targetField: { id: sourceField, slug: 'name', fieldType: 'TEXT', options: {}, archivedAt: null } }],
      }],
      [deviceResourceId, {
        id: deviceResourceId, integrationId: integrationA, resourceKey: 'devices', enabled: true,
        targetKind: 'asset', targetConfig: {}, dependsOnResourceKeys: ['sites'], assetLayoutId: layout,
        assetLayout: { fields: [] }, matchKeyFieldIds: [],
        fieldMappings: [{ sourceField: 'hostname', syncDirection: 'preserve_manual', transform: null,
          targetField: { id: manualField, slug: 'hostname', fieldType: 'TEXT', options: {}, archivedAt: null } }],
      }],
    ]);
    const bindings = new Map<string, Record<string, unknown>>();
    const tx = {
      integrationSyncRecord: {
        findUnique: jest.fn(async ({ where }: { where: { integrationCompanyMappingId_resourceId_externalId: { resourceId: string; externalId: string } } }) =>
          bindings.get(`${where.integrationCompanyMappingId_resourceId_externalId.resourceId}:${where.integrationCompanyMappingId_resourceId_externalId.externalId}`) ?? null),
        upsert: jest.fn(async ({ create }: { create: Record<string, unknown> }) => {
          const stored = { id: `binding-${bindings.size + 1}`, ...create };
          bindings.set(`${String(create.resourceId)}:${String(create.externalId)}`, stored);
          return stored;
        }),
        update: jest.fn(),
      },
      integrationSyncCheckpoint: { upsert: jest.fn() },
      integrationResource: { findUnique: jest.fn() },
    };
    const prisma = {
      integrationCompanyMapping: { findUnique: jest.fn().mockResolvedValue({
        id: mapping, integrationId: integrationA, companyId: company, externalOrgId: org,
        filter: {}, integration: { id: integrationA, driver: 'breeze' },
      }) },
      integrationResource: { findFirst: jest.fn(async ({ where }: { where: { id: string } }) => resources.get(where.id)) },
      integrationSyncCheckpoint: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    };
    const writeFromIntegration = jest.fn(async (input: { resourceId: string }) => ({
      targetId: input.resourceId === siteResourceId
        ? '00000000-0000-4000-8000-000000000115'
        : '00000000-0000-4000-8000-000000000116',
      companyId: company,
      change: 'created' as const,
    }));
    const assetWriter = new AssetTargetWriter({ writeFromIntegration });
    const runner = new IntegrationSyncRunnerService(
      prisma as never,
      { values: { INTEGRATION_HTTP_TIMEOUT_MS: 100, INTEGRATION_HTTP_MAX_RETRIES: 0, INTEGRATION_HTTP_BACKOFF_MS: 100 } } as never,
      { assertIntegrationActor: jest.fn().mockResolvedValue(undefined) } as never,
      { loadDriverContext: jest.fn().mockResolvedValue({ config: { baseUrl: 'https://breeze.example' }, secret: { apiKey: 'key' } }) } as never,
      { get: jest.fn().mockReturnValue(breeze) } as never,
      { execute: jest.fn() } as never,
      { get: jest.fn().mockReturnValue(assetWriter) } as never,
    );

    await expect(runner.runMapping({ syncRunId: 'run-site', integrationCompanyMappingId: mapping, resourceId: siteResourceId, dryRun: false, actorId: 'actor' }))
      .resolves.toMatchObject({ status: 'succeeded', resourceKey: 'sites', totals: { created: 1 } });
    await expect(runner.runMapping({ syncRunId: 'run-device', integrationCompanyMappingId: mapping, resourceId: deviceResourceId, dryRun: false, actorId: 'actor' }))
      .resolves.toMatchObject({ status: 'succeeded', resourceKey: 'devices', totals: { created: 1 } });

    expect(client.fetchPage).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({ resource: 'sites', externalOrgId: org }));
    expect(client.fetchPage).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ resource: 'devices', externalOrgId: org }));
    expect(writeFromIntegration).toHaveBeenNthCalledWith(1, expect.objectContaining({
      externalId: `${org}:sites:${siteId}`, name: 'HQ', externalSource: `breeze:${integrationA}`,
      fieldValues: [{ targetFieldId: sourceField, value: 'HQ', syncDirection: 'source_wins' }],
    }));
    expect(writeFromIntegration).toHaveBeenNthCalledWith(2, expect.objectContaining({
      externalId: `${org}:devices:${deviceId}`, name: 'Workstation 01', externalSource: `breeze:${integrationA}`,
      fieldValues: [{ targetFieldId: manualField, value: 'ws-01', syncDirection: 'preserve_manual' }],
    }));
  });

  it('persists idempotent isolated Breeze assets through the real AssetsService and safely migrates legacy identity', async () => {
    type StoredAsset = {
      id: string; companyId: string; assetLayoutId: string; name: string;
      externalId: string | null; externalSource: string | null; archivedAt: Date | null;
      createdBy: string; updatedBy: string; createdAt: Date; updatedAt: Date;
      fieldValues: Array<{ id: string; companyId: string; assetId: string; assetFieldId: string; value: unknown }>;
    };
    const now = new Date('2026-07-14T00:00:00.000Z');
    const makeField = (id: string, slug: string) => ({
      id, assetLayoutId: layout, name: slug, slug, fieldType: 'TEXT', position: 0,
      isRequired: false, isPrimary: false, isUniquePerCompany: false,
      visibleToClients: true, options: {}, archivedAt: null, createdAt: now, updatedAt: now,
    });
    const assetLayout = {
      id: layout, name: 'Breeze assets', slug: 'breeze-assets', icon: 'server', color: '#000000',
      description: null, archivedAt: null, createdAt: now, updatedAt: now,
      fields: [makeField(sourceField, 'source'), makeField(manualField, 'preserved'), makeField(manualOnlyField, 'manual-only')],
    };
    const assets = new Map<string, StoredAsset>();
    const bindings = new Map<string, Record<string, unknown>>();
    const targets = new Map<string, string>();
    const provenance = new Map<string, ReconstructionWriteOutcome['provenance']>();
    const checksums = new Map<string, Record<string, string>>();
    let nextAsset = 1;
    const bindingLookup = async (args: { where?: { integrationCompanyMappingId_resourceId_externalId?: { integrationCompanyMappingId: string; resourceId: string; externalId: string } } }) => {
      const identity = args.where?.integrationCompanyMappingId_resourceId_externalId;
      return identity ? bindings.get(`${identity.integrationCompanyMappingId}:${identity.resourceId}:${identity.externalId}`) ?? null : null;
    };
    const tx = {
      asset: {
        create: jest.fn(async ({ data }: { data: Omit<StoredAsset, 'id' | 'fieldValues' | 'createdAt' | 'updatedAt'> }) => {
          const row: StoredAsset = {
            ...data,
            id: `00000000-0000-4000-8000-${String(nextAsset++).padStart(12, '0')}`,
            createdAt: now, updatedAt: now, fieldValues: [],
          };
          assets.set(row.id, row);
          return row;
        }),
        updateMany: jest.fn(async ({ where, data }: { where: { id: string; companyId: string }; data: Partial<StoredAsset> }) => {
          const row = assets.get(where.id);
          if (!row || row.companyId !== where.companyId) return { count: 0 };
          Object.assign(row, data, { updatedAt: now });
          return { count: 1 };
        }),
      },
      assetFieldValue: {
        upsert: jest.fn(async ({ where, create, update }: { where: { assetId_assetFieldId: { assetId: string; assetFieldId: string } }; create: { companyId: string; assetId: string; assetFieldId: string; value: unknown }; update: { value: unknown } }) => {
          const row = assets.get(where.assetId_assetFieldId.assetId)!;
          const existing = row.fieldValues.find((value) => value.assetFieldId === where.assetId_assetFieldId.assetFieldId);
          if (existing) existing.value = update.value;
          else row.fieldValues.push({ id: `fv-${row.fieldValues.length + 1}`, ...create });
          return existing ?? row.fieldValues.at(-1);
        }),
        deleteMany: jest.fn(async ({ where }: { where: { assetId: string; assetFieldId: string } }) => {
          const row = assets.get(where.assetId)!;
          row.fieldValues = row.fieldValues.filter((value) => value.assetFieldId !== where.assetFieldId);
          return { count: 1 };
        }),
      },
      upload: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      integrationSyncRecord: { findUnique: jest.fn(bindingLookup) },
      auditLog: { create: jest.fn() },
    };
    const prisma = {
      assetLayout: { findUnique: jest.fn().mockResolvedValue(assetLayout) },
      integrationSyncRecord: { findUnique: jest.fn(bindingLookup) },
      asset: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => assets.get(where.id) ?? null),
        findFirst: jest.fn(async ({ where }: { where: { companyId: string; externalId: string; externalSource: string | null; NOT?: { id: string } } }) =>
          [...assets.values()].find((row) => row.companyId === where.companyId && row.externalId === where.externalId && row.externalSource === where.externalSource && row.id !== where.NOT?.id) ?? null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      assetFieldValue: { findFirst: jest.fn().mockResolvedValue(null) },
      tag: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const registry = {
      get: jest.fn().mockReturnValue({
        valueSchema: () => z.string(), normalize: (value: unknown) => value,
        toPlaintext: (value: unknown) => String(value),
      }),
    };
    const assetService = new AssetsService(
      prisma as never,
      { assertIntegrationActor: jest.fn().mockResolvedValue(undefined), logWithClient: jest.fn().mockResolvedValue(undefined) } as never,
      registry as never, {} as never, {} as never,
      { upsertAsset: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never, {} as never, {} as never,
    );
    const writer = new AssetTargetWriter(assetService);
    const write = async (integrationId: string, resourceKey: 'sites' | 'devices', sourceId: string, name: string, sourceValue: string, manualValue: string) => {
      const mappingId = integrationId === integrationA
        ? mapping
        : '00000000-0000-4000-8000-000000000119';
      const resourceId = integrationId === integrationA
        ? resourceKey === 'sites'
          ? '00000000-0000-4000-8000-000000000117'
          : '00000000-0000-4000-8000-000000000118'
        : '00000000-0000-4000-8000-000000000120';
      const input: AssetReconstructionInput = {
        targetKind: 'asset',
        externalId: `${org}:${resourceKey}:${sourceId}`,
        source: { externalOrgId: org, resourceKey, sourceId, revision: 'a'.repeat(64), fingerprint: 'b'.repeat(64), updatedAt: null },
        name,
        assetLayoutId: layout,
        externalSource: `breeze:${integrationId}`,
        matchKeyFieldIds: [],
        fieldValues: [
          { targetFieldId: sourceField, value: sourceValue, syncDirection: 'source_wins' },
          { targetFieldId: manualField, value: manualValue, syncDirection: 'preserve_manual' },
          { targetFieldId: manualOnlyField, value: 'upstream-must-not-write', syncDirection: 'manual_only' },
        ],
      };
      const key = `${integrationId}:${input.externalId}`;
      const outcome = await writer.write({
        tx: tx as never, companyId: company, integrationId,
        integrationCompanyMappingId: mappingId, resourceId, resourceKey,
        externalOrgId: org, auditActorId: 'actor', now,
        dryRun: false, existingTargetId: targets.get(key) ?? null,
        previousFieldChecksums: checksums.get(key) ?? {},
        previousProvenance: provenance.get(key) ?? null,
        resolveBinding: jest.fn().mockResolvedValue(null),
      }, input);
      if (outcome.change !== 'blocked') {
        targets.set(key, outcome.targetId);
        provenance.set(key, outcome.provenance);
        checksums.set(key, outcome.fieldChecksums ?? {});
        bindings.set(`${mappingId}:${resourceId}:${input.externalId}`, {
          id: `binding-${bindings.size + 1}`, integrationCompanyMappingId: mappingId, resourceId,
          externalId: input.externalId, companyId: company, targetKind: 'asset', assetId: outcome.targetId,
          subnetId: null, ipReservationId: null, articleId: null, relationId: null,
          state: 'active', checksum: outcome.checksum,
          lastSyncedFieldChecksums: outcome.fieldChecksums ?? {}, provenance: outcome.provenance,
          companyMapping: { integrationId, externalOrgId: org },
          resource: { integrationId, resourceKey },
        });
      }
      return outcome;
    };

    await expect(write(integrationA, 'sites', 'site-uuid', 'HQ', 'Denver', 'operator site')).resolves.toMatchObject({ change: 'created' });
    await expect(write(integrationA, 'devices', 'device-uuid', 'Laptop', 'serial-1', 'operator device')).resolves.toMatchObject({ change: 'created' });
    await expect(write(integrationA, 'sites', 'site-uuid', 'HQ', 'Denver', 'operator site')).resolves.toMatchObject({ change: 'unchanged' });
    const deviceAId = targets.get(`${integrationA}:${org}:devices:device-uuid`)!;
    const deviceA = assets.get(deviceAId)!;
    deviceA.fieldValues.find((value) => value.assetFieldId === manualField)!.value = 'operator override';
    deviceA.fieldValues.push({ id: 'manual-value', companyId: company, assetId: deviceA.id, assetFieldId: manualOnlyField, value: 'keep manual only' });
    await expect(write(integrationA, 'devices', 'device-uuid', 'Renamed laptop', 'serial-2', 'replace attempt')).resolves.toMatchObject({ change: 'updated' });
    await expect(write(integrationB, 'devices', 'device-uuid', 'Renamed laptop', 'serial-other', 'other partner')).resolves.toMatchObject({ change: 'created' });

    expect(assets.size).toBe(3);
    const deviceB = assets.get(targets.get(`${integrationB}:${org}:devices:device-uuid`)!)!;
    expect(deviceA.name).toBe('Renamed laptop');
    expect(Object.fromEntries(deviceA.fieldValues.map((value) => [value.assetFieldId, value.value]))).toMatchObject({
      [sourceField]: 'serial-2', [manualField]: 'operator override', [manualOnlyField]: 'keep manual only',
    });
    expect(deviceB.id).not.toBe(deviceA.id);
    expect(deviceA.externalId).toBe(deviceB.externalId);
    expect(deviceA.externalSource).toBe(`breeze:${integrationA}`);
    expect(deviceB.externalSource).toBe(`breeze:${integrationB}`);

    const siteA = assets.get(targets.get(`${integrationA}:${org}:sites:site-uuid`)!)!;
    siteA.externalSource = 'breeze';
    const countBeforeMigration = assets.size;
    const siteBindingKey = `${mapping}:00000000-0000-4000-8000-000000000117:${org}:sites:site-uuid`;
    const exactBinding = bindings.get(siteBindingKey)!;
    bindings.delete(siteBindingKey);
    await expect(write(integrationA, 'sites', 'site-uuid', 'must not apply', 'must not apply', 'must not apply'))
      .resolves.toMatchObject({ targetId: siteA.id, change: 'blocked' });
    expect(siteA).toMatchObject({ externalSource: 'breeze', name: 'HQ' });
    expect(assets.size).toBe(countBeforeMigration);

    bindings.set(siteBindingKey, exactBinding);
    await expect(write(integrationA, 'sites', 'site-uuid', 'HQ renamed', 'Boulder', 'replace attempt')).resolves.toMatchObject({
      targetId: siteA.id, change: 'updated',
    });
    expect(assets.size).toBe(countBeforeMigration);
    expect(siteA).toMatchObject({ externalId: `${org}:sites:site-uuid`, externalSource: `breeze:${integrationA}`, name: 'HQ renamed' });
  });
});
