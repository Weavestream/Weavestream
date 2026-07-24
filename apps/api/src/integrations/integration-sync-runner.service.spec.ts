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
import { integrationReconstructionGapInputSchema } from '@weavestream/shared';
import { integrationAssetExternalSource } from './integration-asset-source.js';
import { FieldTypesRegistry } from '../field-types/field-types.registry.js';
import { assetReconstructionInputSchema } from './reconstruction/reconstruction-target.js';

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
    resumeSchemaVersion?: string;
    cancelled?: boolean;
    staleBinding?: boolean;
    completenessParticipant?: boolean;
  } = {}) {
    const order: string[] = [];
    let pending: string[] = [];
    const tx = {
      integrationSyncRun: {
        updateMany: jest.fn().mockResolvedValue({ count: options.cancelled ? 0 : 1 }),
      },
      integrationSyncRecord: {
        findUnique: jest.fn().mockResolvedValue(options.staleBinding ? {
          id: 'binding-id', targetKind: 'subnet', assetId: null,
          subnetId: 'subnet-id', ipReservationId: null, articleId: null, relationId: null,
          state: 'stale', checksum: 'a'.repeat(64), staleSince: new Date('2026-07-13T10:00:00.000Z'),
          lastSyncedFieldChecksums: { 'native-field': 'preserved-checksum' },
          provenance: {
            integrationId: '00000000-0000-4000-8000-000000000001', externalOrgId: 'org-1', resourceKey: 'subnets',
            externalId: input.externalId, sourceRevision: null, sourceFingerprint: null,
            firstSeenAt: '2026-07-12T10:00:00.000Z', lastSeenAt: '2026-07-13T10:00:00.000Z',
            lastSyncedAt: '2026-07-13T10:00:00.000Z', ownership: 'breeze', state: 'stale',
          },
        } : null),
        upsert: jest.fn(async () => {
          pending.push('binding');
          return { id: 'binding-id' };
        }),
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
              schemaVersion: options.resumeSchemaVersion ?? null,
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
    const driver = {
      descriptor: { capabilities: { reconstructionCompleteness: options.completenessParticipant ?? true } },
      fetchRecords: jest.fn().mockResolvedValue({
        records: [{ reconstructionInput: input }], hasMore: false, cursor: null,
        terminal: true, snapshotAt: '2026-07-14T10:00:00.000Z',
        sourceHighWater: '2026-07-14T09:00:00.000Z',
      }),
    };
    const writer = { write: jest.fn<
      Promise<ReconstructionWriteOutcome>,
      [ReconstructionWriteContext, ReconstructionInput]
    >(async () => {
      pending.push('target+audit');
      return {
      targetKind: 'subnet', targetId: 'subnet-id', checksum: 'checksum', change: 'created',
      provenance: {
        integrationId: '00000000-0000-4000-8000-000000000001', externalOrgId: 'org-1', resourceKey: 'subnets',
        externalId: input.externalId, sourceRevision: null, sourceFingerprint: null,
        firstSeenAt: '2026-07-14T10:00:00.000Z', lastSeenAt: '2026-07-14T10:00:00.000Z',
        lastSyncedAt: '2026-07-14T10:00:00.000Z', ownership: 'breeze', state: 'active',
      }, gaps: [],
    }; }) };
    const audit = {
      assertIntegrationActor: options.unauthorized
        ? jest.fn().mockRejectedValue(new Error('forbidden'))
        : jest.fn().mockResolvedValue(undefined),
      logWithClient: jest.fn().mockResolvedValue(undefined),
      logManyWithClient: jest.fn().mockResolvedValue(undefined),
    };
    const writerRegistry = { get: jest.fn().mockReturnValue(writer) };
    const provenance = {
      buildProvenance: jest.fn((value: { previous?: Record<string, unknown>; state?: string; observedAt?: Date; syncedAt?: Date }) => value.previous ? {
        ...value.previous,
        state: value.state,
        lastSeenAt: value.observedAt?.toISOString(),
        lastSyncedAt: value.syncedAt?.toISOString(),
      } : {
        integrationId: 'integration', externalOrgId: 'org-1', resourceKey: 'subnets',
        externalId: input.externalId, sourceRevision: null, sourceFingerprint: null,
        firstSeenAt: '2026-07-14T10:00:00.000Z', lastSeenAt: '2026-07-14T10:00:00.000Z',
        lastSyncedAt: '2026-07-14T10:00:00.000Z', ownership: 'breeze', state: 'active',
      }),
      lockScope: jest.fn(async () => { pending.push('lock-scope'); }),
      persistGaps: jest.fn(async () => { pending.push('gaps'); }),
      resolveAbsentGaps: jest.fn(async () => { pending.push('resolve-gaps'); }),
      staleUnseen: jest.fn(async () => { pending.push('stale-sweep'); return { stale: 2, archived: 1 }; }),
      findMoveConflict: jest.fn().mockResolvedValue(null),
    };
    const completeness = {
      recalculate: jest.fn(async () => { pending.push('completeness'); }),
      clearNonParticipant: jest.fn(async () => { pending.push('completeness-clear'); }),
    };
    const service = new IntegrationSyncRunnerService(
      prisma as never,
      { values: { INTEGRATION_HTTP_TIMEOUT_MS: 1, INTEGRATION_HTTP_MAX_RETRIES: 0, INTEGRATION_HTTP_BACKOFF_MS: 1 } } as never,
      audit as never,
      { loadDriverContext: jest.fn().mockResolvedValue({ config: {}, secret: {} }) } as never,
      { get: jest.fn().mockReturnValue(driver) } as never,
      {} as never,
      writerRegistry as never,
      provenance as never,
      completeness as never,
      new FieldTypesRegistry(),
    );
    return { service, writer, writerRegistry, tx, order, driver, audit, prisma, provenance, completeness };
  }

  it('maps one scalar definition to only its configured target field and skips unmapped rows', () => {
    const { service } = setup();
    const definitionA = '00000000-0000-4000-8000-000000000201';
    const definitionB = '00000000-0000-4000-8000-000000000202';
    const targetA = '00000000-0000-4000-8000-000000000301';
    const targetB = '00000000-0000-4000-8000-000000000302';
    const toReconstructionInput = service as unknown as {
      toReconstructionInput(
        record: Record<string, unknown>,
        resource: Record<string, unknown>,
        mapping: Record<string, unknown>,
      ): AssetReconstructionInput | null;
    };
    const converted = toReconstructionInput.toReconstructionInput(
      {
        externalId: 'value-uuid',
        displayName: 'Rack on device-uuid',
        fields: { [definitionA]: 'DC1-R07' },
        updatedAt: '2026-07-14T09:00:00.000Z',
        mappingSourceField: definitionA,
        bindingRef: {
          resourceKey: 'devices',
          externalId: 'org-1:devices:device-uuid',
        },
      },
      {
        id: 'resource',
        resourceKey: 'custom-field-values',
        targetKind: 'asset',
        targetConfig: { bindingResourceKey: 'devices' },
        assetLayoutId: '00000000-0000-4000-8000-000000000007',
        matchKeyFieldIds: [],
        fieldMappings: [
          {
            sourceField: definitionA,
            targetField: { id: targetA, slug: 'rack', fieldType: 'TEXT', options: {}, archivedAt: null },
            transform: null,
            syncDirection: 'preserve_manual',
          },
          {
            sourceField: definitionB,
            targetField: { id: targetB, slug: 'shelf', fieldType: 'TEXT', options: {}, archivedAt: null },
            transform: null,
            syncDirection: 'manual_only',
          },
        ],
      },
      {
        externalOrgId: 'org-1',
        integrationId: '00000000-0000-4000-8000-000000000001',
        integration: { driver: 'breeze' },
      },
    );

    expect(converted).toMatchObject({
      externalId: 'org-1:custom-field-values:value-uuid',
      source: { sourceId: 'value-uuid' },
      bindingRef: {
        resourceKey: 'devices',
        externalId: 'org-1:devices:device-uuid',
      },
      fieldValues: [{
        targetFieldId: targetA,
        value: 'DC1-R07',
        syncDirection: 'preserve_manual',
      }],
    });
    expect(converted).not.toHaveProperty('bindingResourceKey');

    expect(toReconstructionInput.toReconstructionInput(
      {
        externalId: 'unmapped-value-uuid',
        displayName: 'Unmapped on device-uuid',
        fields: { unmappedDefinition: 'ignore-me' },
        updatedAt: '2026-07-14T09:00:00.000Z',
        mappingSourceField: 'unmappedDefinition',
        bindingRef: {
          resourceKey: 'devices',
          externalId: 'org-1:devices:device-uuid',
        },
      },
      {
        id: 'resource',
        resourceKey: 'custom-field-values',
        targetKind: 'asset',
        targetConfig: { bindingResourceKey: 'devices' },
        assetLayoutId: '00000000-0000-4000-8000-000000000007',
        matchKeyFieldIds: [],
        fieldMappings: [{
          sourceField: definitionA,
          targetField: { id: targetA, slug: 'rack', fieldType: 'TEXT', options: {}, archivedAt: null },
          transform: null,
          syncDirection: 'source_wins',
        }],
      },
      {
        externalOrgId: 'org-1',
        integrationId: '00000000-0000-4000-8000-000000000001',
        integration: { driver: 'breeze' },
      },
    )).toBeNull();
  });

  it('rejects custom-field mappings that reuse one target field for different definitions', () => {
    const { service } = setup();
    const toReconstructionInput = service as unknown as {
      toReconstructionInput(
        record: Record<string, unknown>,
        resource: Record<string, unknown>,
        mapping: Record<string, unknown>,
      ): AssetReconstructionInput | null;
    };
    const targetFieldId = '00000000-0000-4000-8000-000000000301';
    const fieldMapping = (sourceField: string) => ({
      sourceField,
      targetField: { id: targetFieldId, slug: 'rack', fieldType: 'TEXT', options: {}, archivedAt: null },
      transform: null,
      syncDirection: 'source_wins',
    });
    expect(() => toReconstructionInput.toReconstructionInput(
      {
        externalId: 'value-uuid',
        displayName: 'Rack',
        fields: { definitionA: 'DC1-R07' },
        updatedAt: null,
        mappingSourceField: 'definitionA',
      },
      {
        id: 'resource',
        resourceKey: 'custom-field-values',
        targetKind: 'asset',
        targetConfig: {},
        assetLayoutId: '00000000-0000-4000-8000-000000000007',
        matchKeyFieldIds: [],
        fieldMappings: [fieldMapping('definitionA'), fieldMapping('definitionB')],
      },
      {
        externalOrgId: 'org-1',
        integrationId: '00000000-0000-4000-8000-000000000001',
        integration: { driver: 'breeze' },
      },
    )).toThrow(/distinct|target field|custom-field/i);
  });

  it('projects legacy driver values with pre-reconstruction tolerance', () => {
    const { service } = setup();
    const textField = '00000000-0000-4000-8000-000000000401';
    const datetimeField = '00000000-0000-4000-8000-000000000402';
    const booleanField = '00000000-0000-4000-8000-000000000403';
    const absentField = '00000000-0000-4000-8000-000000000404';
    const clearedField = '00000000-0000-4000-8000-000000000405';
    const convert = service as unknown as {
      toReconstructionInput(
        record: Record<string, unknown>,
        resource: Record<string, unknown>,
        mapping: Record<string, unknown>,
        onFieldDrop?: (drop: { sourceField: string; targetSlug: string }) => void,
      ): AssetReconstructionInput | null;
    };
    const mapField = (sourceField: string, id: string, fieldType: string) => ({
      sourceField,
      targetField: { id, slug: sourceField, fieldType, options: {}, archivedAt: null },
      transform: null,
      syncDirection: 'source_wins',
    });
    const drops: Array<{ sourceField: string; targetSlug: string }> = [];
    const converted = convert.toReconstructionInput(
      {
        externalId: 'device-1',
        displayName: 'Device 1',
        fields: {
          // Raw RMM shapes: numbers for TEXT, epoch seconds for DATETIME,
          // stringly booleans, '' clears — exactly what NinjaOne/Action1 emit.
          memoryCapacity: 17179869184,
          osLastBootTime: 1752570000,
          rebootRequired: 'true',
          assignedUser: '',
        },
        updatedAt: null,
      },
      {
        id: 'resource',
        resourceKey: 'records',
        targetKind: 'asset',
        targetConfig: {},
        assetLayoutId: '00000000-0000-4000-8000-000000000007',
        matchKeyFieldIds: [],
        fieldMappings: [
          mapField('memoryCapacity', textField, 'TEXT'),
          mapField('osLastBootTime', datetimeField, 'DATETIME'),
          mapField('rebootRequired', booleanField, 'BOOLEAN'),
          mapField('systemSerialNumber', absentField, 'TEXT'),
          mapField('assignedUser', clearedField, 'TEXT'),
        ],
      },
      {
        externalOrgId: 'org-1',
        integrationId: '00000000-0000-4000-8000-000000000001',
        integration: { driver: 'ninjaone' },
      },
      (drop) => drops.push(drop),
    );

    expect(converted?.fieldValues).toEqual([
      // Coerced through the field-type strategy so strict native
      // validation downstream accepts what the RMM actually sends.
      { targetFieldId: textField, value: '17179869184', syncDirection: 'source_wins' },
      // rebootRequired: 'true' → real boolean.
      { targetFieldId: booleanField, value: true, syncDirection: 'source_wins' },
      // '' propagates an intentional upstream clear.
      { targetFieldId: clearedField, value: null, syncDirection: 'source_wins' },
      // osLastBootTime (epoch seconds → not ISO) is dropped WITHOUT
      // blocking the record; systemSerialNumber (absent key) is skipped
      // so the stored value survives.
    ]);
    // The projected record must round-trip the strict writer schema —
    // an absent source key must never poison it with `undefined`.
    expect(() => assetReconstructionInputSchema.parse(converted)).not.toThrow();
    // Only the value-schema drop is reported for gap observation — the
    // absent key (skip) and the intentional clear are not drops.
    expect(drops).toEqual([
      { sourceField: 'osLastBootTime', targetSlug: 'osLastBootTime' },
    ]);
  });

  it('surfaces dropped legacy field values as one authority-neutral unsupported gap while the run succeeds', async () => {
    const { service, driver, prisma, provenance, writer, tx } = setup();
    const textField = '00000000-0000-4000-8000-000000000501';
    const datetimeField = '00000000-0000-4000-8000-000000000502';
    prisma.integrationResource.findFirst.mockResolvedValueOnce({
      id: 'resource', integrationId: 'integration', resourceKey: 'records', enabled: true,
      targetKind: 'asset', targetConfig: {}, dependsOnResourceKeys: [],
      assetLayoutId: '00000000-0000-4000-8000-000000000007',
      assetLayout: { fields: [] }, matchKeyFieldIds: [],
      fieldMappings: [
        {
          sourceField: 'deviceName',
          targetField: { id: textField, slug: 'device_name', fieldType: 'TEXT', options: {}, archivedAt: null },
          transform: null, syncDirection: 'source_wins',
        },
        {
          sourceField: 'osLastBootTime',
          targetField: { id: datetimeField, slug: 'os_last_boot_time', fieldType: 'DATETIME', options: {}, archivedAt: null },
          transform: null, syncDirection: 'source_wins',
        },
      ],
    });
    driver.fetchRecords.mockResolvedValueOnce({
      // A whole fleet shares the same bad mapping (epoch seconds into a
      // DATETIME field) — the drop must stay one bounded observation.
      records: [
        { externalId: 'device-1', displayName: 'Device 1', fields: { deviceName: 'Alpha', osLastBootTime: 1752570000 }, updatedAt: null },
        { externalId: 'device-2', displayName: 'Device 2', fields: { deviceName: 'Beta', osLastBootTime: 1752570001 }, updatedAt: null },
      ],
      hasMore: false, cursor: null, terminal: true,
      snapshotAt: '2026-07-14T10:00:00.000Z',
    });
    writer.write.mockImplementation(async (_ctx, record) => ({
      targetKind: 'asset', targetId: 'asset-id', checksum: 'c'.repeat(64), change: 'created',
      provenance: {
        integrationId: 'integration', externalOrgId: 'org-1', resourceKey: 'records',
        externalId: record.externalId, sourceRevision: null, sourceFingerprint: null,
        firstSeenAt: '2026-07-14T10:00:00.000Z', lastSeenAt: '2026-07-14T10:00:00.000Z',
        lastSyncedAt: '2026-07-14T10:00:00.000Z', ownership: 'breeze', state: 'active',
      },
      gaps: [],
    }));

    await expect(service.runMapping({
      syncRunId: 'drop-run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'incremental',
    })).resolves.toMatchObject({
      status: 'succeeded',
      totals: { fetched: 2, created: 2, blocked: 0, errors: 0 },
    });

    // The representable sibling field still syncs on every record.
    expect(writer.write).toHaveBeenCalledTimes(2);
    const [, firstWritten] = writer.write.mock.calls[0]! as unknown as [unknown, AssetReconstructionInput];
    expect(firstWritten.fieldValues).toEqual([
      { targetFieldId: textField, value: 'Alpha', syncDirection: 'source_wins' },
    ]);

    // Both devices collapse into ONE mapping-level observation whose
    // dedupe discriminators (null externalId + stable reasonCode) keep a
    // fleet with the same bad mapping to a single persisted row.
    expect(provenance.persistGaps).toHaveBeenCalledWith(expect.anything(), expect.anything(), [
      expect.objectContaining({
        kind: 'unsupported',
        externalId: null,
        details: {
          reasonCode: 'legacy_value_not_representable',
          fieldPaths: ['osLastBootTime -> os_last_boot_time'],
          candidateCount: 2,
        },
      }),
    ]);
    // The observation must satisfy the real persistence schema so
    // persistGaps can never throw (and fail the run) over a drop gap.
    const observation = (provenance.persistGaps.mock.calls[0]! as unknown as [
      unknown, unknown, Array<Record<string, unknown>>,
    ])[2][0]!;
    expect(integrationReconstructionGapInputSchema.safeParse({
      companyId: '00000000-0000-4000-8000-000000000901',
      integrationCompanyMappingId: '00000000-0000-4000-8000-000000000902',
      resourceId: '00000000-0000-4000-8000-000000000903',
      externalId: observation.externalId as string | null,
      kind: observation.kind,
      message: observation.message,
      details: observation.details,
      firstSeenAt: '2026-07-14T10:00:00.000Z',
      lastSeenAt: '2026-07-14T10:00:00.000Z',
      resolvedAt: null,
    }).success).toBe(true);

    // Authority-neutral: the traversal stays authoritative, absent gaps
    // resolve, and the terminal checkpoint completes normally.
    expect(provenance.resolveAbsentGaps).toHaveBeenCalledTimes(1);
    expect(tx.integrationSyncCheckpoint.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ authoritative: true }),
      update: expect.objectContaining({ authoritative: true }),
    }));
  });

  it('dispatches typed input and commits its binding before the page checkpoint', async () => {
    const { service, writer, tx, order, audit } = setup();
    await expect(service.runMapping({
      syncRunId: 'run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'incremental',
    })).resolves.toMatchObject({ status: 'succeeded', totals: { created: 1 } });
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({ tx, existingTargetId: null }), input);
    expect(audit.logManyWithClient).toHaveBeenCalledWith(tx, [{
      actorId: 'actor',
      action: 'integration.target.created',
      entityType: 'IntegrationTarget',
      entityId: 'subnet-id',
      companyId: 'company',
      ip: '0.0.0.0',
      userAgent: 'weavestream-worker/integration-reconstruction',
      after: {
        integrationId: 'integration',
        integrationCompanyMappingId: 'mapping',
        resourceId: 'resource',
        targetId: 'subnet-id',
        targetKind: 'subnet',
        state: 'active',
        counts: { records: 1, gaps: 0 },
      },
    }]);
    expect(order).toEqual([
      'lock-scope', 'target+audit', 'binding', 'gaps', 'resolve-gaps', 'completeness', 'checkpoint',
    ]);
  });

  it('clears instead of scoring completeness for non-dossier drivers', async () => {
    const { service, order, completeness } = setup({ completenessParticipant: false });
    await expect(service.runMapping({
      syncRunId: 'run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'incremental',
    })).resolves.toMatchObject({ status: 'succeeded', totals: { created: 1 } });
    expect(completeness.recalculate).not.toHaveBeenCalled();
    expect(completeness.clearNonParticipant).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId: 'company', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
    }));
    expect(order).toEqual([
      'lock-scope', 'target+audit', 'binding', 'gaps', 'resolve-gaps', 'completeness-clear', 'checkpoint',
    ]);
  });

  it('persists page lifecycle audits with one transaction-scoped batch call', async () => {
    const { service, driver, audit, tx } = setup();
    driver.fetchRecords.mockResolvedValueOnce({
      records: [
        { reconstructionInput: input },
        { reconstructionInput: {
          ...input,
          externalId: 'org-1:subnets:dmz',
          source: { ...input.source, sourceId: 'dmz' },
          name: 'DMZ', cidr: '10.0.1.0/24',
        } },
      ],
      hasMore: false, cursor: null, terminal: true,
      snapshotAt: '2026-07-14T10:00:00.000Z',
      sourceHighWater: '2026-07-14T09:00:00.000Z',
    });

    await expect(service.runMapping({
      syncRunId: 'batched-audit-run', integrationCompanyMappingId: 'mapping',
      resourceId: 'resource', dryRun: false, actorId: 'actor', mode: 'incremental',
    })).resolves.toMatchObject({ status: 'succeeded', totals: { created: 2 } });

    expect(audit.logWithClient).not.toHaveBeenCalled();
    expect(audit.logManyWithClient).toHaveBeenCalledTimes(1);
    expect(audit.logManyWithClient).toHaveBeenCalledWith(tx, [
      expect.objectContaining({ action: 'integration.target.created' }),
      expect.objectContaining({ action: 'integration.target.created' }),
    ]);
  });

  it.each([
    { change: 'updated' as const, staleBinding: false, state: 'active' as const, gap: null },
    { change: 'restored' as const, staleBinding: true, state: 'active' as const, gap: null },
    {
      change: 'blocked' as const,
      staleBinding: false,
      state: 'blocked' as const,
      gap: {
        kind: 'missing_dependency' as const,
        message: 'A required native target dependency was unavailable.',
        details: { reasonCode: 'dependency_not_found' },
      },
    },
  ])('emits the exact safe generic $change target audit row', async ({
    change,
    staleBinding,
    state,
    gap,
  }) => {
    const { service, writer, tx, audit } = setup({ staleBinding });
    writer.write.mockResolvedValueOnce({
      targetKind: 'subnet',
      targetId: 'subnet-id',
      checksum: 'b'.repeat(64),
      change,
      provenance: {
        integrationId: 'integration',
        externalOrgId: 'org-1',
        resourceKey: 'subnets',
        externalId: input.externalId,
        sourceRevision: null,
        sourceFingerprint: null,
        firstSeenAt: '2026-07-12T10:00:00.000Z',
        lastSeenAt: '2026-07-14T10:00:00.000Z',
        lastSyncedAt: state === 'active' ? '2026-07-14T10:00:00.000Z' : null,
        ownership: 'breeze',
        state,
      },
      gaps: gap ? [gap] : [],
    });

    await service.runMapping({
      syncRunId: `${change}-run`,
      integrationCompanyMappingId: 'mapping',
      resourceId: 'resource',
      dryRun: false,
      actorId: 'actor',
      mode: 'incremental',
    });

    expect(audit.logManyWithClient).toHaveBeenCalledWith(tx, [{
      actorId: 'actor',
      action: `integration.target.${change}`,
      entityType: 'IntegrationTarget',
      entityId: 'subnet-id',
      companyId: 'company',
      ip: '0.0.0.0',
      userAgent: 'weavestream-worker/integration-reconstruction',
      after: {
        integrationId: 'integration',
        integrationCompanyMappingId: 'mapping',
        resourceId: 'resource',
        targetId: 'subnet-id',
        targetKind: 'subnet',
        state,
        counts: { records: 1, gaps: gap ? 1 : 0 },
        ...(gap ? { reasonCategory: 'missing_dependency' } : {}),
      },
    }]);
    expect(JSON.stringify(audit.logManyWithClient.mock.calls)).not.toContain(
      'dependency_not_found',
    );
  });

  it('uses the stable full snapshot as the seen marker and commits gaps, stale sweep, completeness, then terminal checkpoint atomically', async () => {
    const { service, tx, order, provenance, completeness } = setup();
    await expect(service.runMapping({
      syncRunId: 'run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'full',
    })).resolves.toMatchObject({ status: 'succeeded', totals: { stale: 2, archived: 1 } });
    expect(tx.integrationSyncRecord.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ lastSeenAt: new Date('2026-07-14T10:00:00.000Z') }),
      update: expect.objectContaining({ lastSeenAt: new Date('2026-07-14T10:00:00.000Z') }),
    }));
    expect(provenance.staleUnseen).toHaveBeenCalledWith(tx, expect.objectContaining({
      targetKind: 'subnet', snapshotAt: new Date('2026-07-14T10:00:00.000Z'),
    }));
    expect(completeness.recalculate).toHaveBeenCalledWith(tx, expect.objectContaining({
      evaluatedAt: new Date('2026-07-14T10:00:00.000Z'),
    }));
    // The scope lock leads every page: pages queue on the watermark
    // BEFORE their first target/binding write so a concurrent stale
    // sweep (binding-first) can never interleave with page writes
    // (target-first) — the lock-order-inversion deadlock and the
    // archive-then-reactivate anomaly are both structurally excluded.
    expect(provenance.lockScope).toHaveBeenCalledWith(tx, expect.objectContaining({
      resourceId: 'resource', observedAt: new Date('2026-07-14T10:00:00.000Z'),
    }));
    expect(order).toEqual([
      'lock-scope', 'target+audit', 'binding', 'gaps', 'resolve-gaps',
      'stale-sweep', 'completeness', 'checkpoint',
    ]);
  });

  it('restores a stale binding in place, clears staleSince, and carries native/manual preservation state', async () => {
    const { service, writer, tx } = setup({ staleBinding: true });
    writer.write.mockResolvedValueOnce({
      targetKind: 'subnet', targetId: 'subnet-id', checksum: 'b'.repeat(64), change: 'restored',
      provenance: {
        integrationId: 'integration', externalOrgId: 'org-1', resourceKey: 'subnets',
        externalId: input.externalId, sourceRevision: null, sourceFingerprint: null,
        firstSeenAt: '2026-07-12T10:00:00.000Z', lastSeenAt: '2026-07-14T10:00:00.000Z',
        lastSyncedAt: '2026-07-14T10:00:00.000Z', ownership: 'breeze', state: 'active',
      },
      fieldChecksums: { 'native-field': 'preserved-checksum' }, gaps: [],
    });

    await expect(service.runMapping({
      syncRunId: 'restore-run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'incremental',
    })).resolves.toMatchObject({ status: 'succeeded', totals: { restored: 1 } });
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      existingTargetId: 'subnet-id', existingState: 'stale',
      previousFieldChecksums: { 'native-field': 'preserved-checksum' },
      previousProvenance: expect.objectContaining({ ownership: 'breeze', state: 'stale' }),
    }), input);
    expect(tx.integrationSyncRecord.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        subnetId: 'subnet-id', state: 'active', staleSince: null,
        lastSyncedFieldChecksums: { 'native-field': 'preserved-checksum' },
        provenance: expect.objectContaining({ ownership: 'breeze', state: 'active' }),
      }),
    }));
  });

  it('keeps a stable full snapshot across two pages and defers resolution, sweep, completeness, and completion markers until terminal', async () => {
    const { service, driver, tx, provenance, completeness, order } = setup();
    driver.fetchRecords
      .mockResolvedValueOnce({
        records: [{ reconstructionInput: input }], hasMore: true, cursor: 'opaque-page-2',
        terminal: false, schemaVersion: '1', snapshotAt: '2026-07-14T10:00:00.000Z',
        sourceHighWater: '2026-07-14T09:30:00.000Z', blockedInputs: [],
      })
      .mockResolvedValueOnce({
        records: [{ reconstructionInput: input }], hasMore: false, cursor: null,
        terminal: true, schemaVersion: '1', snapshotAt: '2026-07-14T10:00:00.000Z',
        sourceHighWater: '2026-07-14T09:45:00.000Z', blockedInputs: [],
      });

    await expect(service.runMapping({
      syncRunId: 'new-run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'full',
    })).resolves.toMatchObject({ status: 'succeeded' });

    expect(tx.integrationSyncRecord.upsert).toHaveBeenCalledTimes(2);
    const bindingCalls = tx.integrationSyncRecord.upsert.mock.calls as unknown as Array<[
      { create: { lastSeenAt: Date }; update: { lastSeenAt: Date } },
    ]>;
    for (const [call] of bindingCalls) {
      expect(call.create.lastSeenAt).toEqual(new Date('2026-07-14T10:00:00.000Z'));
      expect(call.update.lastSeenAt).toEqual(new Date('2026-07-14T10:00:00.000Z'));
    }
    expect(provenance.persistGaps).toHaveBeenCalledTimes(2);
    expect(provenance.resolveAbsentGaps).toHaveBeenCalledTimes(1);
    expect(provenance.staleUnseen).toHaveBeenCalledTimes(1);
    expect(completeness.recalculate).toHaveBeenCalledTimes(1);
    const checkpointCalls = tx.integrationSyncCheckpoint.upsert.mock.calls as unknown as Array<[
      { update: Record<string, unknown> },
    ]>;
    const checkpoints = checkpointCalls.map(([call]) => call);
    expect(checkpoints[0]!.update).not.toHaveProperty('lastFullCompletedAt');
    expect(checkpoints[0]!.update).not.toHaveProperty('highWaterAt');
    expect(checkpoints[1]!.update).toHaveProperty('lastFullCompletedAt');
    expect(checkpoints[1]!.update['highWaterAt']).toEqual(new Date('2026-07-14T09:45:00.000Z'));
    expect(order).toEqual([
      'lock-scope', 'target+audit', 'binding', 'gaps', 'checkpoint',
      'lock-scope', 'target+audit', 'binding', 'gaps', 'resolve-gaps',
      'stale-sweep', 'completeness', 'checkpoint',
    ]);
  });

  it('uses one snapshot marker across incremental pages and preserves prior gaps after an incomplete page', async () => {
    const { service, driver, provenance } = setup();
    driver.fetchRecords
      .mockResolvedValueOnce({
        records: [], hasMore: true, cursor: 'page-2', terminal: false,
        schemaVersion: '1', snapshotAt: '2026-07-14T10:00:00.000Z',
        blockedInputs: [{
          kind: 'missing_dependency', externalId: 'safe-source-1',
          message: 'A dependency was unavailable.', details: { reasonCode: 'dependency_missing' },
        }],
      })
      .mockResolvedValueOnce({
        records: [], hasMore: false, cursor: null, terminal: true,
        schemaVersion: '1', snapshotAt: '2026-07-14T10:00:00.000Z', blockedInputs: [],
      });
    await expect(service.runMapping({
      syncRunId: 'run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'incremental',
    })).resolves.toMatchObject({ status: 'failed' });
    const gapCalls = provenance.persistGaps.mock.calls as unknown as Array<[
      unknown, { observedAt: Date }, unknown[],
    ]>;
    const scopes = gapCalls.map((call) => call[1]);
    expect(scopes).toHaveLength(2);
    expect(scopes[0]!.observedAt).toEqual(new Date('2026-07-14T10:00:00.000Z'));
    expect(scopes[1]!.observedAt).toEqual(scopes[0]!.observedAt);
    expect(provenance.resolveAbsentGaps).not.toHaveBeenCalled();
  });

  it('quarantines a mapped cross-company move before the native writer and persists a safe ambiguous gap', async () => {
    const { service, provenance, writer } = setup();
    provenance.findMoveConflict.mockResolvedValueOnce({ count: 1 });
    await expect(service.runMapping({
      syncRunId: 'run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'incremental',
    })).resolves.toMatchObject({
      status: 'succeeded', totals: { blocked: 1, skippedAmbiguous: 1, created: 0 },
    });
    expect(writer.write).not.toHaveBeenCalled();
    expect(provenance.persistGaps).toHaveBeenCalledWith(expect.anything(), expect.anything(), [
      expect.objectContaining({
        kind: 'ambiguous',
        details: expect.objectContaining({ reasonCode: 'cross_org_move_quarantined' }),
      }),
    ]);
  });

  it('persists a generic validation quarantine when typed source identity is rejected', async () => {
    const { service, driver, provenance, writer } = setup();
    driver.fetchRecords.mockResolvedValueOnce({
      records: [{ reconstructionInput: { ...input, externalId: 'wrong' } }],
      hasMore: false, cursor: null, terminal: true,
      snapshotAt: '2026-07-14T10:00:00.000Z',
    });
    await service.runMapping({
      syncRunId: 'run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'incremental',
    });
    expect(writer.write).not.toHaveBeenCalled();
    expect(provenance.persistGaps).toHaveBeenCalledWith(expect.anything(), expect.anything(), [
      expect.objectContaining({
        kind: 'validation', message: 'Source record failed bounded reconstruction validation.',
        details: { reasonCode: 'invalid_reconstruction_input' },
      }),
    ]);
  });

  it('commits valid siblings and safe validation gaps without authoritative terminal reconciliation', async () => {
    const { service, driver, writer, tx, provenance, completeness } = setup();
    driver.fetchRecords.mockResolvedValueOnce({
      records: [
        { reconstructionInput: input },
        { reconstructionInput: { ...input, externalId: 'wrong-scope-id' } },
      ],
      hasMore: false, cursor: null, terminal: true,
      snapshotAt: '2026-07-14T10:00:00.000Z',
      sourceHighWater: '2026-07-14T09:00:00.000Z',
    });

    await expect(service.runMapping({
      syncRunId: 'validation-run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'full',
    })).resolves.toMatchObject({ status: 'failed', totals: { created: 1, errors: 1 } });
    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(tx.integrationSyncRecord.upsert).toHaveBeenCalledTimes(1);
    expect(provenance.persistGaps).toHaveBeenCalledWith(expect.anything(), expect.anything(), [
      expect.objectContaining({ kind: 'validation' }),
    ]);
    expect(provenance.resolveAbsentGaps).not.toHaveBeenCalled();
    expect(provenance.staleUnseen).not.toHaveBeenCalled();
    expect(completeness.recalculate).not.toHaveBeenCalled();
    expect(tx.integrationSyncCheckpoint.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ authoritative: false, lastCompletedAt: null }),
      update: expect.objectContaining({ authoritative: false }),
    }));
    const checkpoint = (tx.integrationSyncCheckpoint.upsert.mock.calls as unknown as Array<[
      { update: Record<string, unknown> },
    ]>)[0]![0];
    expect(checkpoint.update).not.toHaveProperty('highWaterAt');
    expect(checkpoint.update).not.toHaveProperty('lastFullCompletedAt');
  });

  it('persists a non-retryable missing dependency without replacing incremental last-known-good state', async () => {
    const { service, driver, tx, provenance, completeness } = setup();
    driver.fetchRecords.mockResolvedValueOnce({
      records: [], hasMore: false, cursor: null, terminal: true,
      snapshotAt: '2026-07-14T10:00:00.000Z',
      sourceHighWater: '2026-07-14T09:00:00.000Z',
      blockedInputs: [{
        kind: 'missing_dependency', externalId: null,
        message: 'A required upstream dependency was unavailable.',
        details: { reasonCode: 'dependency_unavailable', dependencyResourceKey: 'sites' },
      }],
    });

    await expect(service.runMapping({
      syncRunId: 'dependency-run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'incremental',
    })).resolves.toMatchObject({ status: 'failed', totals: { missingDependency: 1 } });
    expect(provenance.persistGaps).toHaveBeenCalledWith(expect.anything(), expect.anything(), [
      expect.objectContaining({ kind: 'missing_dependency' }),
    ]);
    expect(provenance.resolveAbsentGaps).not.toHaveBeenCalled();
    expect(completeness.recalculate).not.toHaveBeenCalled();
    expect(tx.integrationSyncCheckpoint.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ authoritative: false, lastCompletedAt: null }),
      update: expect.objectContaining({ authoritative: false }),
    }));
  });

  it('loads a persisted non-authoritative cursor on a second process invocation and preserves last-known-good terminal state', async () => {
    const { service, driver, tx, prisma, provenance, completeness } = setup();
    let persistedCheckpoint: Record<string, unknown> | null = null;
    prisma.integrationSyncCheckpoint.findUnique.mockImplementation(async () => persistedCheckpoint);
    tx.integrationSyncCheckpoint.upsert.mockImplementation((async ({ create, update }: {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      persistedCheckpoint = persistedCheckpoint
        ? { ...persistedCheckpoint, ...update }
        : { ...create };
      return persistedCheckpoint;
    }) as never);
    driver.fetchRecords
      .mockResolvedValueOnce({
        records: [{ reconstructionInput: { ...input, externalId: 'wrong-scope-id' } }],
        hasMore: true,
        cursor: 'page-2',
        terminal: false,
        snapshotAt: '2026-07-14T10:00:00.000Z',
        sourceHighWater: '2026-07-14T09:00:00.000Z',
      })
      .mockRejectedValueOnce(new Error('process interrupted after checkpoint'));

    await expect(service.runMapping({
      syncRunId: 'resume-run-1', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'full',
    })).resolves.toMatchObject({ status: 'failed', error: 'process interrupted after checkpoint' });
    expect(persistedCheckpoint).toMatchObject({
      cursor: 'page-2', schemaVersion: 'legacy', authoritative: false, highWaterAt: null,
      lastCompletedAt: null, lastFullCompletedAt: null,
    });

    provenance.resolveAbsentGaps.mockClear();
    provenance.staleUnseen.mockClear();
    completeness.recalculate.mockClear();
    driver.fetchRecords.mockReset().mockResolvedValueOnce({
      records: [], hasMore: false, cursor: null, terminal: true,
      snapshotAt: '2026-07-14T10:00:00.000Z',
      sourceHighWater: '2026-07-14T09:30:00.000Z',
    });

    await expect(service.runMapping({
      syncRunId: 'resume-run-2', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'full',
    })).resolves.toMatchObject({ status: 'failed', error: expect.stringContaining('incomplete') });
    expect(prisma.integrationSyncCheckpoint.findUnique).toHaveBeenCalledTimes(2);
    expect(provenance.resolveAbsentGaps).not.toHaveBeenCalled();
    expect(provenance.staleUnseen).not.toHaveBeenCalled();
    expect(completeness.recalculate).not.toHaveBeenCalled();
    expect(persistedCheckpoint).toMatchObject({
      cursor: null, schemaVersion: null, authoritative: false, highWaterAt: null,
      lastCompletedAt: null, lastFullCompletedAt: null,
    });
  });

  it('fails a resumed traversal whose driver schema version diverges from the checkpoint', async () => {
    const { service, driver, tx } = setup({ resumeCursor: 'page-2', resumeSchemaVersion: 'v1' });
    driver.fetchRecords.mockResolvedValueOnce({
      records: [], hasMore: true, cursor: 'page-3', terminal: false,
      schemaVersion: 'v2', snapshotAt: '2026-07-13T10:00:00.000Z',
    });

    await expect(service.runMapping({
      syncRunId: 'resume-schema-run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'full',
    })).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('schemaVersion must remain stable'),
    });
    expect(tx.integrationSyncCheckpoint.upsert).not.toHaveBeenCalled();
  });

  it('marks a safely identified secret-blocked source binding seen and remains authoritative', async () => {
    const { service, driver, tx, provenance, completeness } = setup({ staleBinding: true });
    driver.fetchRecords.mockResolvedValueOnce({
      records: [], hasMore: false, cursor: null, terminal: true,
      snapshotAt: '2026-07-14T10:00:00.000Z',
      blockedInputs: [{
        kind: 'secret_blocked', externalId: input.externalId,
        message: 'Credential material requires operator documentation.',
        details: { reasonCode: 'secret_not_exported' },
      }],
    });

    await expect(service.runMapping({
      syncRunId: 'secret-run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'full',
    })).resolves.toMatchObject({ status: 'succeeded', totals: { secretBlocked: 1 } });
    expect(tx.integrationSyncRecord.update).toHaveBeenCalledWith({
      where: { id: 'binding-id' },
      data: expect.objectContaining({
        state: 'blocked', lastSeenAt: new Date('2026-07-14T10:00:00.000Z'),
        provenance: expect.objectContaining({ ownership: 'breeze', state: 'blocked' }),
      }),
    });
    expect(provenance.resolveAbsentGaps).toHaveBeenCalled();
    expect(provenance.staleUnseen).toHaveBeenCalled();
    expect(completeness.recalculate).toHaveBeenCalled();
  });

  it('recovers an exact secret-blocked Breeze binding to the same native target on a later valid source record', async () => {
    const { service, driver, tx, prisma, writerRegistry, provenance } = setup();
    const integrationId = '00000000-0000-4000-8000-000000000031';
    const targetId = '00000000-0000-4000-8000-000000000032';
    const layoutId = '00000000-0000-4000-8000-000000000033';
    const fieldId = '00000000-0000-4000-8000-000000000034';
    const externalId = 'org-1:devices:device-1';
    const assetInput: AssetReconstructionInput = {
      targetKind: 'asset',
      externalId,
      source: { externalOrgId: 'org-1', resourceKey: 'devices', sourceId: 'device-1' },
      name: 'Device 1',
      assetLayoutId: layoutId,
      matchKeyFieldIds: [],
      fieldValues: [{ targetFieldId: fieldId, value: 'Device 1', syncDirection: 'source_wins' }],
    };
    let persistedBinding = {
      id: 'binding-id', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      externalId, companyId: 'company', targetKind: 'asset', assetId: targetId,
      subnetId: null, ipReservationId: null, articleId: null, relationId: null,
      state: 'active', staleSince: new Date('2026-07-13T10:00:00.000Z'),
      checksum: 'a'.repeat(64), lastSyncedFieldChecksums: {},
      lastSeenAt: new Date('2026-07-13T10:00:00.000Z'),
      companyMapping: { integrationId, externalOrgId: 'org-1' },
      resource: { integrationId, resourceKey: 'devices' },
      provenance: {
        integrationId, externalOrgId: 'org-1', resourceKey: 'devices', externalId,
        sourceRevision: null, sourceFingerprint: null,
        firstSeenAt: '2026-07-12T10:00:00.000Z', lastSeenAt: '2026-07-13T10:00:00.000Z',
        lastSyncedAt: '2026-07-13T10:00:00.000Z', ownership: 'breeze', state: 'active',
      },
    };
    prisma.integrationCompanyMapping.findUnique.mockResolvedValue({
      id: 'mapping', integrationId, companyId: 'company', externalOrgId: 'org-1',
      filter: {}, integration: { id: integrationId, driver: 'typed' },
    });
    prisma.integrationResource.findFirst.mockResolvedValue({
      id: 'resource', integrationId, resourceKey: 'devices', enabled: true,
      targetKind: 'asset', targetConfig: {}, dependsOnResourceKeys: [],
      assetLayoutId: layoutId, assetLayout: { fields: [] }, matchKeyFieldIds: [],
      fieldMappings: [{
        sourceField: 'name', syncDirection: 'source_wins', transform: null,
        targetField: { id: fieldId, slug: 'name', fieldType: 'TEXT', options: {}, archivedAt: null },
      }],
    });
    tx.integrationSyncRecord.findUnique.mockImplementation(async () => persistedBinding);
    tx.integrationSyncRecord.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      persistedBinding = { ...persistedBinding, ...data } as typeof persistedBinding;
      return persistedBinding;
    });
    tx.integrationSyncRecord.upsert.mockImplementation((async ({ update }: { update: Record<string, unknown> }) => {
      persistedBinding = { ...persistedBinding, ...update } as typeof persistedBinding;
      return persistedBinding;
    }) as never);
    provenance.buildProvenance.mockImplementation(((value: {
      previous?: Record<string, unknown>;
      state?: string;
      observedAt?: Date;
      syncedAt?: Date | null;
    }) => ({
      ...value.previous,
      state: value.state,
      lastSeenAt: value.observedAt?.toISOString(),
      lastSyncedAt: value.syncedAt?.toISOString() ?? value.previous?.lastSyncedAt ?? null,
    })) as never);
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
      return { targetId, companyId: nativeInput.companyId, change: 'updated' as const };
    }) };
    writerRegistry.get.mockReturnValue(new AssetTargetWriter(nativePort));
    driver.fetchRecords
      .mockResolvedValueOnce({
        records: [], hasMore: false, cursor: null, terminal: true,
        snapshotAt: '2026-07-14T10:00:00.000Z',
        blockedInputs: [{
          kind: 'secret_blocked', externalId,
          message: 'Credential material requires operator documentation.',
          details: { reasonCode: 'secret_not_exported' },
        }],
      })
      .mockResolvedValueOnce({
        records: [{ reconstructionInput: assetInput }],
        hasMore: false, cursor: null, terminal: true,
        snapshotAt: '2026-07-14T11:00:00.000Z',
      });

    await expect(service.runMapping({
      syncRunId: 'blocked-run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'incremental',
    })).resolves.toMatchObject({ status: 'succeeded', totals: { secretBlocked: 1 } });
    expect(persistedBinding).toMatchObject({
      assetId: targetId, state: 'blocked',
      provenance: expect.objectContaining({ state: 'blocked', ownership: 'breeze' }),
    });

    provenance.resolveAbsentGaps.mockClear();
    const recovery = await service.runMapping({
      syncRunId: 'recovery-run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'incremental',
    });
    expect(nativePort.writeFromIntegration).toHaveBeenCalledWith(expect.objectContaining({
      existingTargetId: targetId,
    }));
    expect(recovery).toMatchObject({ status: 'succeeded', totals: { updated: 1 } });
    expect(persistedBinding).toMatchObject({
      assetId: targetId, state: 'active', staleSince: null,
      provenance: expect.objectContaining({ state: 'active', ownership: 'breeze' }),
    });
    expect(provenance.resolveAbsentGaps).toHaveBeenCalledTimes(1);
  });

  it('caps legal per-record writer gaps and adds one safe overflow observation', async () => {
    const { service, driver, writer, provenance } = setup();
    driver.fetchRecords.mockResolvedValueOnce({
      records: [{ reconstructionInput: input }], hasMore: false, cursor: null, terminal: true,
      snapshotAt: '2026-07-14T10:00:00.000Z',
      blockedInputs: Array.from({ length: 1_000 }, (_, index) => ({
        kind: 'validation' as const, externalId: `safe-${index}`,
        message: 'Input requires operator review.', details: { reasonCode: 'invalid_input' },
      })),
    });
    writer.write.mockResolvedValueOnce({
      targetKind: 'subnet', targetId: 'subnet-id', checksum: 'checksum', change: 'created',
      provenance: {
        integrationId: '00000000-0000-0000-0000-000000000001',
        externalOrgId: 'org-1', resourceKey: 'subnets', externalId: input.externalId,
        sourceRevision: null, sourceFingerprint: null,
        firstSeenAt: '2026-07-14T10:00:00.000Z', lastSeenAt: '2026-07-14T10:00:00.000Z',
        lastSyncedAt: '2026-07-14T10:00:00.000Z', ownership: 'breeze', state: 'active',
      },
      gaps: [{ kind: 'validation', message: 'Additional writer validation.' }],
    });
    await service.runMapping({
      syncRunId: 'run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'incremental',
    });
    const overflowCalls = provenance.persistGaps.mock.calls as unknown as Array<[
      unknown, unknown, Array<Record<string, unknown>>,
    ]>;
    const observations = overflowCalls[0]![2];
    expect(observations).toHaveLength(1_000);
    expect(observations.at(-1)).toEqual(expect.objectContaining({
      externalId: null,
      details: expect.objectContaining({ reasonCode: 'gap_observation_overflow', candidateCount: 2 }),
    }));
  });

  it.each([
    ['incremental', false],
    ['full dry run', true],
  ] as const)('never stales during %s traversal', async (_label, dryRun) => {
    const { service, provenance } = setup();
    await service.runMapping({
      syncRunId: 'run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun, actorId: 'actor', mode: dryRun ? 'full' : 'incremental',
    });
    expect(provenance.staleUnseen).not.toHaveBeenCalled();
  });

  it('rolls back stale, completeness, and full completion when the bounded terminal sweep fails', async () => {
    const { service, provenance, completeness, tx, order } = setup();
    provenance.staleUnseen.mockRejectedValueOnce(new Error('bounded stale sweep exceeded'));
    await expect(service.runMapping({
      syncRunId: 'run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'full',
    })).resolves.toMatchObject({ status: 'failed', error: 'bounded stale sweep exceeded' });
    expect(order).toEqual([]);
    expect(completeness.recalculate).not.toHaveBeenCalled();
    expect(tx.integrationSyncCheckpoint.upsert).not.toHaveBeenCalled();
  });

  it('rolls back the terminal page and never sweeps or checkpoints a cancelled full run', async () => {
    const { service, provenance, completeness, tx, order } = setup({ cancelled: true });

    await expect(service.runMapping({
      syncRunId: 'cancelled-run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: false, actorId: 'actor', mode: 'full',
    })).resolves.toMatchObject({ status: 'failed', error: expect.stringMatching(/cancelled/i) });
    expect(order).toEqual([]);
    expect(tx.integrationSyncRun.updateMany).toHaveBeenCalledWith({
      where: { id: 'cancelled-run', status: { in: ['queued', 'running'] } },
      data: { status: 'running' },
    });
    expect(provenance.resolveAbsentGaps).not.toHaveBeenCalled();
    expect(provenance.staleUnseen).not.toHaveBeenCalled();
    expect(completeness.recalculate).not.toHaveBeenCalled();
    expect(tx.integrationSyncCheckpoint.upsert).not.toHaveBeenCalled();
  });

  it('keeps dry runs free of binding and checkpoint writes', async () => {
    const { service, tx, provenance } = setup();
    await service.runMapping({
      syncRunId: 'run', integrationCompanyMappingId: 'mapping', resourceId: 'resource',
      dryRun: true, actorId: 'actor', mode: 'full',
    });
    expect(tx.integrationSyncRecord.upsert).not.toHaveBeenCalled();
    expect(tx.integrationSyncCheckpoint.upsert).not.toHaveBeenCalled();
    // The scope lock's absent-row branch seeds the watermark row — a
    // write — so dry runs must never take it.
    expect(provenance.lockScope).not.toHaveBeenCalled();
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
    const { service, driver, tx, order, provenance, completeness } = setup();
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
    expect(provenance.staleUnseen).not.toHaveBeenCalled();
    expect(completeness.recalculate).not.toHaveBeenCalled();
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
      integrationSyncRun: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
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
      {
        assertIntegrationActor: jest.fn().mockResolvedValue(undefined),
        logWithClient: jest.fn().mockResolvedValue(undefined),
        logManyWithClient: jest.fn().mockResolvedValue(undefined),
      } as never,
      { loadDriverContext: jest.fn().mockResolvedValue({ config: { baseUrl: 'https://breeze.example' }, secret: { apiKey: 'key' } }) } as never,
      { get: jest.fn().mockReturnValue(breeze) } as never,
      { execute: jest.fn() } as never,
      { get: jest.fn().mockReturnValue(assetWriter) } as never,
      {
        buildProvenance: jest.fn(({ previous }: { previous: unknown }) => previous),
        lockScope: jest.fn(), persistGaps: jest.fn(), resolveAbsentGaps: jest.fn(),
        staleUnseen: jest.fn(), findMoveConflict: jest.fn().mockResolvedValue(null),
      } as never,
      { recalculate: jest.fn() } as never,
      new FieldTypesRegistry(),
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
    // writeFromIntegration reads through the caller-provided tx, so the tx
    // mock must expose the same read delegates as a real TransactionClient
    // over the shared in-memory store.
    const assetReads = {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => assets.get(where.id) ?? null),
      findFirst: jest.fn(async ({ where }: { where: { companyId: string; externalId: string; externalSource: string | null; NOT?: { id: string } } }) =>
        [...assets.values()].find((row) => row.companyId === where.companyId && row.externalId === where.externalId && row.externalSource === where.externalSource && row.id !== where.NOT?.id) ?? null),
      findMany: jest.fn().mockResolvedValue([]),
    };
    const assetLayoutReads = { findUnique: jest.fn().mockResolvedValue(assetLayout) };
    const assetFieldValueReads = { findFirst: jest.fn().mockResolvedValue(null) };
    const tx = {
      integrationSyncRun: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      assetLayout: assetLayoutReads,
      asset: {
        ...assetReads,
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
        ...assetFieldValueReads,
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
      assetLayout: assetLayoutReads,
      integrationSyncRecord: { findUnique: jest.fn(bindingLookup) },
      asset: assetReads,
      assetFieldValue: assetFieldValueReads,
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
