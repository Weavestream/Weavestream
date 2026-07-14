import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import {
  integrationProvenanceSchema,
  integrationReconstructionGapInputSchema,
  integrationTransformSchema,
  stripNul,
} from '@weavestream/shared';
import type {
  SafeIntegrationProvenance,
  SyncRunConflict,
  SyncRunTotals,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { EnvService } from '../config/env.service.js';
import { IntegrationsService } from './integrations.service.js';
import { IntegrationDriverRegistry } from './drivers/integration-driver.registry.js';
import {
  type DriverFetchPage,
  type DriverBlockedInput,
  type DriverRecord,
  type FetchRecordsContext,
} from './drivers/integration-driver.js';
import { describeError } from '../common/describe-error.js';
import { IntegrationTransformService } from './transforms/integration-transform.service.js';
import { ReconstructionWriterRegistry } from './reconstruction/reconstruction-writer.registry.js';
import {
  type AssetReconstructionInput,
  type ReconstructionDependencyRef,
  type ReconstructionInput,
  type ReconstructionWriteContext,
  type ReconstructionWriteOutcome,
  type ReconstructionWriter,
} from './reconstruction/reconstruction-target.js';
import { integrationAssetExternalSource } from './integration-asset-source.js';
import { IntegrationProvenanceService } from './reconstruction/integration-provenance.service.js';
import { IntegrationCompletenessService } from './reconstruction/integration-completeness.service.js';

/** Executes one resource inside a mapping DAG through its native writer. */

export interface MappingRunInput {
  syncRunId: string;
  integrationCompanyMappingId: string;
  /** Resource selected by the per-mapping DAG worker. */
  resourceId: string;
  dryRun: boolean;
  /** Triggered-by user id for audit attribution; null on scheduled runs. */
  actorId: string | null;
  mode?: 'incremental' | 'full';
}

export interface MappingRunOutcome {
  status: 'succeeded' | 'failed';
  /** Per-resource counters for this single (mapping, resource) job. */
  totals: SyncRunTotals;
  conflicts: SyncRunConflict[];
  error: string | null;
  companyId: string;
  /** Resource key the job ran against — used by the per-mapping merge. */
  resourceKey: string;
}

export interface ValidatedDriverFetchPage {
  records: DriverRecord[];
  hasMore: boolean;
  cursor: string | null;
  schemaVersion: string;
  snapshotAt: string;
  blockedInputs: DriverBlockedInput[];
  sourceHighWater: string | null;
  terminal: boolean;
}

export function validateDriverFetchPage(
  page: Partial<DriverFetchPage> & Pick<DriverFetchPage, 'records' | 'hasMore' | 'cursor'>,
  state: {
    traversalStartedAt: string;
    previousCursor: string | null;
    expectedSchemaVersion: string | null;
    expectedSnapshotAt: string | null;
  },
): ValidatedDriverFetchPage {
  if (!Array.isArray(page.records) || page.records.length > 10_000) {
    throw new BadRequestException('Driver page records are invalid or unbounded.');
  }
  const schemaVersion = page.schemaVersion ?? 'legacy';
  if (schemaVersion.length < 1 || schemaVersion.length > 32) {
    throw new BadRequestException('Driver page schemaVersion must contain 1 to 32 characters.');
  }
  const snapshotAt = page.snapshotAt ?? state.expectedSnapshotAt ?? state.traversalStartedAt;
  assertIsoDate(snapshotAt, 'snapshotAt');
  if (page.sourceHighWater != null) assertIsoDate(page.sourceHighWater, 'sourceHighWater');
  const terminal = page.terminal ?? (!page.hasMore && page.cursor === null);
  if (page.hasMore && (page.cursor === null || terminal)) {
    throw new BadRequestException('A nonterminal driver page requires a non-null cursor.');
  }
  if (terminal && (page.hasMore || page.cursor !== null)) {
    throw new BadRequestException('A terminal driver page requires hasMore=false and cursor=null.');
  }
  if (page.cursor !== null && page.cursor === state.previousCursor) {
    throw new BadRequestException('Driver page cursor did not advance.');
  }
  if (state.expectedSchemaVersion && schemaVersion !== state.expectedSchemaVersion) {
    throw new BadRequestException('Driver page schemaVersion must remain stable across pages.');
  }
  if (state.expectedSnapshotAt && snapshotAt !== state.expectedSnapshotAt) {
    throw new BadRequestException('Driver page snapshotAt must remain stable across pages.');
  }
  if (page.sourceHighWater && page.sourceHighWater > snapshotAt) {
    throw new BadRequestException('Driver page sourceHighWater cannot exceed snapshotAt.');
  }
  const blockedInputs = page.blockedInputs ?? [];
  if (!Array.isArray(blockedInputs) || blockedInputs.length > 1_000) {
    throw new BadRequestException('Driver blockedInputs must contain at most 1000 entries.');
  }
  for (const blocked of blockedInputs) {
    if (
      !blocked ||
      blocked.message.length < 1 ||
      blocked.message.length > 512 ||
      (blocked.externalId !== null && blocked.externalId.length > 1_024)
    ) {
      throw new BadRequestException('Driver blocked input metadata is invalid or unbounded.');
    }
    const at = state.traversalStartedAt;
    const parsed = integrationReconstructionGapInputSchema.safeParse({
      companyId: '00000000-0000-0000-0000-000000000000',
      integrationCompanyMappingId: '00000000-0000-0000-0000-000000000000',
      resourceId: '00000000-0000-0000-0000-000000000000',
      externalId: blocked.externalId,
      kind: blocked.kind,
      message: blocked.message,
      details: blocked.details ?? {},
      firstSeenAt: at,
      lastSeenAt: at,
      resolvedAt: null,
    });
    if (!parsed.success) {
      throw new BadRequestException('Driver blocked input metadata is not sanitized.');
    }
  }
  return {
    records: page.records,
    hasMore: page.hasMore,
    cursor: page.cursor,
    schemaVersion,
    snapshotAt,
    blockedInputs,
    sourceHighWater: page.sourceHighWater ?? null,
    terminal,
  };
}

function assertIsoDate(value: string, field: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new BadRequestException(`Driver page ${field} must be an ISO date.`);
  }
  if (new Date(value).toISOString() !== value) {
    throw new BadRequestException(`Driver page ${field} must be a canonical ISO date.`);
  }
}

@Injectable()
export class IntegrationSyncRunnerService {
  private readonly logger = new Logger(IntegrationSyncRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly audit: AuditLogService,
    private readonly integrations: IntegrationsService,
    private readonly drivers: IntegrationDriverRegistry,
    private readonly transforms: IntegrationTransformService,
    private readonly writers: ReconstructionWriterRegistry,
    private readonly provenance: IntegrationProvenanceService,
    private readonly completeness: IntegrationCompletenessService,
  ) {}

  async runMapping(input: MappingRunInput): Promise<MappingRunOutcome> {
    const totals = emptyTotals();
    const conflicts: SyncRunConflict[] = [];
    const mapping = await this.prisma.integrationCompanyMapping.findUnique({
      where: { id: input.integrationCompanyMappingId },
      include: { integration: { select: { id: true, driver: true } } },
    });
    if (!mapping) {
      throw new NotFoundException(
        `IntegrationCompanyMapping ${input.integrationCompanyMappingId} not found`,
      );
    }
    const resource = await this.prisma.integrationResource.findFirst({
      where: { id: input.resourceId, integrationId: mapping.integrationId },
      include: {
        fieldMappings: {
          include: {
            targetField: {
              select: { id: true, slug: true, fieldType: true, options: true, archivedAt: true },
            },
          },
        },
        assetLayout: { include: { fields: { orderBy: { position: 'asc' } } } },
      },
    });
    if (!resource) {
      throw new NotFoundException(`IntegrationResource ${input.resourceId} not found.`);
    }
    if (!resource.enabled) {
      return { status: 'succeeded', totals, conflicts, error: null, companyId: mapping.companyId, resourceKey: resource.resourceKey };
    }
    if (
      resource.targetKind === 'asset' &&
      (!resource.assetLayoutId || !resource.assetLayout || resource.fieldMappings.length === 0)
    ) {
      throw new BadRequestException(
        `Asset resource ${resource.resourceKey} requires an asset layout and field mappings.`,
      );
    }
    if (!input.actorId) {
      totals.blocked += 1;
      totals.missingDependency += 1;
      conflicts.push({
        kind: 'validation_error', externalId: '',
        message: 'missing_audit_actor: no authorized integration audit actor is available.',
      });
      return { status: 'failed', totals, conflicts, error: 'missing_audit_actor', companyId: mapping.companyId, resourceKey: resource.resourceKey };
    }
    try {
      await this.audit.assertIntegrationActor(input.actorId, mapping.companyId);
    } catch {
      totals.blocked += 1;
      totals.missingDependency += 1;
      conflicts.push({
        kind: 'validation_error', externalId: '',
        message: 'missing_audit_actor: the integration audit actor is not authorized for this company.',
      });
      return {
        status: 'failed', totals, conflicts, error: 'missing_audit_actor',
        companyId: mapping.companyId, resourceKey: resource.resourceKey,
      };
    }

    const mode = input.mode ?? 'incremental';
    const checkpoint = await this.prisma.integrationSyncCheckpoint.findUnique({
      where: {
        integrationCompanyMappingId_resourceId_mode: {
          integrationCompanyMappingId: mapping.id,
          resourceId: resource.id,
          mode,
        },
      },
    });
    const driver = this.drivers.get(mapping.integration.driver);
    const loaded = await this.integrations.loadDriverContext(mapping.integrationId);
    const traversalStartedAt = new Date().toISOString();
    const fetchCtx: FetchRecordsContext = {
      config: loaded.config,
      secret: loaded.secret,
      http: {
        timeoutMs: this.env.values.INTEGRATION_HTTP_TIMEOUT_MS,
        maxRetries: this.env.values.INTEGRATION_HTTP_MAX_RETRIES,
        backoffMs: this.env.values.INTEGRATION_HTTP_BACKOFF_MS,
      },
      correlationId: randomUUID(),
      externalOrgId: mapping.externalOrgId,
      resourceKey: resource.resourceKey,
      filter: (mapping.filter ?? {}) as Record<string, unknown>,
      mode,
      updatedSince:
        mode === 'incremental' && checkpoint?.highWaterAt
          ? checkpoint.highWaterAt.toISOString()
          : null,
      snapshotAt:
        checkpoint?.cursor !== null && checkpoint?.cursor !== undefined && checkpoint.snapshotAt
          ? checkpoint.snapshotAt.toISOString()
          : null,
    };

    let cursor = checkpoint?.cursor ?? null;
    let schemaVersion: string | null = null;
    let snapshotAt = checkpoint?.cursor !== null && checkpoint?.cursor !== undefined
      ? checkpoint.snapshotAt?.toISOString() ?? null
      : null;
    let traversalHighWater = checkpoint?.highWaterAt?.toISOString() ?? null;
    const seenCursors = new Set<string>();
    if (cursor !== null) seenCursors.add(cursor);
    let pages = 0;
    try {
      while (true) {
        const rawPage = await driver.fetchRecords(
          { ...fetchCtx, snapshotAt },
          cursor,
        );
        const page = validateDriverFetchPage(rawPage, {
          traversalStartedAt,
          previousCursor: cursor,
          expectedSchemaVersion: schemaVersion,
          expectedSnapshotAt: snapshotAt,
        });
        schemaVersion = page.schemaVersion;
        snapshotAt = page.snapshotAt;
        if (page.cursor !== null) {
          if (seenCursors.has(page.cursor)) {
            throw new BadRequestException('Driver page cursor cycle detected.');
          }
          seenCursors.add(page.cursor);
        }
        if (page.sourceHighWater) {
          if (traversalHighWater && page.sourceHighWater < traversalHighWater) {
            throw new BadRequestException(
              'Driver source high-water cannot regress within a traversal.',
            );
          }
          traversalHighWater = page.sourceHighWater;
        }
        pages += 1;
        if (pages > 1_000) throw new BadRequestException('Driver traversal exceeded 1000 pages.');

        const pageTotals = emptyTotals();
        const pageConflicts: SyncRunConflict[] = [];
        const processPage = async (tx: Prisma.TransactionClient): Promise<void> => {
          const runClaim = await tx.integrationSyncRun.updateMany({
            where: {
              id: input.syncRunId,
              status: { in: ['queued', 'running'] },
            },
            data: { status: 'running' },
          });
          if (runClaim.count !== 1) {
            throw new BadRequestException(
              `Sync run ${input.syncRunId} is cancelled or not active; page reconciliation was rolled back.`,
            );
          }
          const observedAt = new Date(page.snapshotAt);
          const pageGaps: Array<{
            externalId: string | null;
            syncRecordId: string | null;
            kind: DriverBlockedInput['kind'];
            message: string;
            details: Record<string, unknown>;
          }> = [];
          let droppedGapCount = 0;
          const observeGap = (gap: (typeof pageGaps)[number]): void => {
            if (pageGaps.length < 999) pageGaps.push(gap);
            else droppedGapCount += 1;
          };
          for (const blocked of page.blockedInputs) {
            if (
              blocked.kind === 'synchronization_error' &&
              blocked.details?.retryable === true
            ) {
              throw new Error(blocked.message);
            }
            this.accumulateBlockedInput(pageTotals, pageConflicts, blocked);
            observeGap({
              externalId: blocked.externalId,
              syncRecordId: null,
              kind: blocked.kind,
              message: blocked.message,
              details: { ...(blocked.details ?? {}) },
            });
          }
          for (const record of page.records) {
            pageTotals.fetched += 1;
            let reconstruction: ReconstructionInput;
            const safeRecord = record.reconstructionInput === undefined
              ? stripNul(record)
              : record;
            try {
              reconstruction = this.toReconstructionInput(safeRecord, resource, mapping);
              this.assertTypedIdentity(reconstruction, resource.targetKind, mapping.externalOrgId, resource.resourceKey);
            } catch {
              pageTotals.blocked += 1;
              pageTotals.errors += 1;
              pageConflicts.push({
                kind: 'validation_error', externalId: '',
                message: 'Source record failed bounded reconstruction validation.',
              });
              observeGap({
                externalId: safeRecord.reconstructionInput?.externalId ?? safeRecord.externalId ?? null,
                syncRecordId: null,
                kind: 'validation',
                message: 'Source record failed bounded reconstruction validation.',
                details: { reasonCode: 'invalid_reconstruction_input' },
              });
              continue;
            }
            const legacyRawId = safeRecord.reconstructionInput === undefined
              ? safeRecord.externalId
              : null;
            const writeNow = new Date();
            const existing = await this.findAndMigrateBinding(
              tx,
              mapping.id,
              resource.id,
              reconstruction.externalId,
              legacyRawId,
              mapping.integrationId,
              reconstruction,
              writeNow,
            );
            const moveConflict = await this.provenance.findMoveConflict(tx, {
              integrationId: mapping.integrationId,
              integrationCompanyMappingId: mapping.id,
              resourceId: resource.id,
              companyId: mapping.companyId,
              resourceKey: reconstruction.source.resourceKey,
              sourceId: reconstruction.source.sourceId,
            });
            if (moveConflict) {
              pageTotals.blocked += 1;
              pageTotals.skippedAmbiguous += 1;
              pageConflicts.push({
                kind: 'validation_error',
                externalId: reconstruction.externalId,
                message: 'Source identity is already bound under another organization mapping.',
              });
              observeGap({
                externalId: reconstruction.externalId,
                syncRecordId: null,
                kind: 'ambiguous',
                message: 'Source identity move requires operator review.',
                details: {
                  reasonCode: 'cross_org_move_quarantined',
                  sourceResource: reconstruction.source.resourceKey,
                  sourceOrgId: reconstruction.source.externalOrgId,
                  sourceId: reconstruction.source.sourceId,
                  candidateCount: moveConflict.count,
                },
              });
              continue;
            }
            const writeContext: ReconstructionWriteContext = {
              tx,
              companyId: mapping.companyId,
              integrationId: mapping.integrationId,
              integrationCompanyMappingId: mapping.id,
              resourceId: resource.id,
              resourceKey: resource.resourceKey,
              externalOrgId: mapping.externalOrgId,
              auditActorId: input.actorId!,
              now: writeNow,
              dryRun: input.dryRun,
              existingTargetId: targetIdFromBinding(existing),
              existingState: existing?.state ?? null,
              previousChecksum: existing?.checksum ?? null,
              previousFieldChecksums: (existing?.lastSyncedFieldChecksums ?? {}) as Record<string, string>,
              previousProvenance: parseProvenance(existing?.provenance),
              resolveBinding: (ref) => this.resolveBinding(tx, mapping.id, mapping.companyId, mapping.integrationId, ref),
            };
            const writer = this.writers.get(reconstruction.targetKind) as ReconstructionWriter<ReconstructionInput>;
            const outcome = await writer.write(writeContext, reconstruction);
            const retryableGap = outcome.gaps.find(
              (gap) => gap.kind === 'synchronization_error',
            );
            if (retryableGap) throw new Error(retryableGap.message);
            this.accumulateWriterOutcome(
              pageTotals,
              pageConflicts,
              reconstruction.externalId,
              outcome,
            );
            if (input.dryRun) continue;
            const activeProvenance = this.provenance.buildProvenance({
              integrationId: mapping.integrationId,
              externalOrgId: reconstruction.source.externalOrgId,
              resourceKey: reconstruction.source.resourceKey,
              externalId: reconstruction.externalId,
              sourceRevision: reconstruction.source.revision ?? null,
              sourceFingerprint: reconstruction.source.fingerprint ?? null,
              observedAt,
              syncedAt: outcome.change === 'blocked' ? null : writeNow,
              state: outcome.change === 'blocked' ? 'blocked' : 'active',
              previous: parseProvenance(existing?.provenance),
            });
            if (outcome.change === 'blocked') {
              if (existing) {
                await tx.integrationSyncRecord.update({
                  where: { id: existing.id },
                  data: {
                    state: 'blocked',
                    provenance: activeProvenance as unknown as Prisma.InputJsonValue,
                    lastSeenAt: observedAt,
                  },
                });
              }
              for (const gap of outcome.gaps) observeGap({
                externalId: reconstruction.externalId,
                syncRecordId: existing?.id ?? null,
                kind: gap.kind,
                message: gap.message,
                details: { ...(gap.details ?? {}) },
              });
              continue;
            }
            const binding = await tx.integrationSyncRecord.upsert({
              where: {
                integrationCompanyMappingId_resourceId_externalId: {
                  integrationCompanyMappingId: mapping.id,
                  resourceId: resource.id,
                  externalId: reconstruction.externalId,
                },
              },
              create: bindingData(mapping.id, resource.id, mapping.companyId, input.syncRunId, reconstruction, outcome, activeProvenance, observedAt, writeNow),
              update: bindingData(mapping.id, resource.id, mapping.companyId, input.syncRunId, reconstruction, outcome, activeProvenance, observedAt, writeNow),
            });
            for (const gap of outcome.gaps) observeGap({
              externalId: reconstruction.externalId,
              syncRecordId: binding.id,
              kind: gap.kind,
              message: gap.message,
              details: { ...(gap.details ?? {}) },
            });
          }
          if (!input.dryRun) {
            if (droppedGapCount > 0) {
              pageGaps.push({
                externalId: null,
                syncRecordId: null,
                kind: 'validation',
                message: 'Additional bounded gap observations require operator review.',
                details: {
                  reasonCode: 'gap_observation_overflow',
                  candidateCount: Math.min(droppedGapCount, 1_000_000),
                },
              });
            }
            await this.provenance.persistGaps(tx, {
              companyId: mapping.companyId,
              integrationCompanyMappingId: mapping.id,
              resourceId: resource.id,
              observedAt,
            }, pageGaps);
            if (page.terminal) {
              await this.provenance.resolveAbsentGaps(tx, {
                companyId: mapping.companyId,
                integrationCompanyMappingId: mapping.id,
                resourceId: resource.id,
                observedAt,
              });
              if (mode === 'full') {
                const reconciled = await this.provenance.staleUnseen(tx, {
                  integrationId: mapping.integrationId,
                  companyId: mapping.companyId,
                  integrationCompanyMappingId: mapping.id,
                  resourceId: resource.id,
                  targetKind: resource.targetKind,
                  snapshotAt: observedAt,
                  auditActorId: input.actorId!,
                });
                pageTotals.stale += reconciled.stale;
                pageTotals.archived += reconciled.archived;
              }
              await this.completeness.recalculate(tx, {
                companyId: mapping.companyId,
                integrationCompanyMappingId: mapping.id,
                resourceId: resource.id,
                evaluatedAt: observedAt,
              });
            }
            const highWater = page.terminal
              ? traversalHighWater ?? deriveLegacyHighWater(page.records)
              : checkpoint?.highWaterAt?.toISOString() ?? null;
            await tx.integrationSyncCheckpoint.upsert({
              where: {
                integrationCompanyMappingId_resourceId_mode: {
                  integrationCompanyMappingId: mapping.id,
                  resourceId: resource.id,
                  mode,
                },
              },
              create: {
                companyId: mapping.companyId, integrationCompanyMappingId: mapping.id,
                resourceId: resource.id, mode, cursor: page.terminal ? null : page.cursor,
                snapshotAt: new Date(page.snapshotAt),
                highWaterAt: highWater ? new Date(highWater) : null,
                lastCompletedAt: page.terminal ? new Date() : null,
                lastFullCompletedAt: page.terminal && mode === 'full' ? new Date() : null,
              },
              update: {
                cursor: page.terminal ? null : page.cursor,
                snapshotAt: new Date(page.snapshotAt),
                ...(page.terminal ? {
                  highWaterAt: highWater ? new Date(highWater) : undefined,
                  lastCompletedAt: new Date(),
                  ...(mode === 'full' ? { lastFullCompletedAt: new Date() } : {}),
                } : {}),
              },
            });
          }
          if (input.dryRun) throw new DryRunPageRollback();
        };
        if (input.dryRun) {
          try {
            await this.prisma.$transaction(async (tx) => processPage(tx), { timeout: 60_000 });
          } catch (error) {
            if (!(error instanceof DryRunPageRollback)) throw error;
          }
        } else {
          await this.prisma.$transaction(async (tx) => processPage(tx), { timeout: 60_000 });
        }
        mergePageOutcome(totals, conflicts, pageTotals, pageConflicts);
        if (page.terminal) break;
        if (!page.hasMore) {
          throw new BadRequestException(
            'Driver traversal ended without a terminal page.',
          );
        }
        cursor = page.cursor;
      }
      return { status: 'succeeded', totals, conflicts, error: null, companyId: mapping.companyId, resourceKey: resource.resourceKey };
    } catch (error) {
      const message = describeError(error);
      totals.errors += 1;
      conflicts.push({ kind: 'driver_error', externalId: '', message: message.slice(0, 500) });
      return { status: 'failed', totals, conflicts, error: message.slice(0, 4_000), companyId: mapping.companyId, resourceKey: resource.resourceKey };
    }
  }

  private toReconstructionInput(
    record: DriverRecord,
    resource: ResourceForReconstruction,
    mapping: {
      externalOrgId: string;
      integrationId: string;
      integration: { driver: string };
    },
  ): ReconstructionInput {
    if (record.reconstructionInput !== undefined) return record.reconstructionInput;
    if (resource.targetKind !== 'asset' || !resource.assetLayoutId) {
      throw new BadRequestException('Legacy driver records may only target asset resources.');
    }
    const source = {
      externalOrgId: mapping.externalOrgId,
      resourceKey: resource.resourceKey,
      sourceId: record.externalId,
      revision: boundedLegacyProvenance(record.sourceRevision, 'sourceRevision'),
      fingerprint: boundedLegacyProvenance(
        record.sourceFingerprint,
        'sourceFingerprint',
      ),
      updatedAt: record.updatedAt,
    };
    const fieldValues = resource.fieldMappings
      .filter((field) => field.targetField && field.targetField.archivedAt === null)
      .map((field) => {
        const raw = record.fields[field.sourceField];
        const value = field.transform
          ? this.transforms.execute(raw, integrationTransformSchema.parse(field.transform), record.fields)
          : raw;
        return {
          targetFieldId: field.targetField!.id,
          value,
          syncDirection: field.syncDirection,
        };
      });
    return {
      targetKind: 'asset',
      externalId: `${source.externalOrgId}:${source.resourceKey}:${source.sourceId}`,
      source,
      name: record.displayName?.trim() || record.externalId,
      assetLayoutId: resource.assetLayoutId,
      externalSource: integrationAssetExternalSource(
        mapping.integration.driver,
        mapping.integrationId,
      ),
      matchKeyFieldIds: resource.matchKeyFieldIds,
      fieldValues,
      ...(typeof (resource.targetConfig as Record<string, unknown>)['bindingResourceKey'] === 'string'
        ? {
            bindingResourceKey: (resource.targetConfig as Record<string, string>)[
              'bindingResourceKey'
            ],
          }
        : {}),
    } satisfies AssetReconstructionInput;
  }

  private assertTypedIdentity(
    input: ReconstructionInput,
    targetKind: string,
    externalOrgId: string,
    resourceKey: string,
  ): void {
    const expected = `${externalOrgId}:${resourceKey}:${input.source.sourceId}`;
    if (
      input.targetKind !== targetKind ||
      input.source.externalOrgId !== externalOrgId ||
      input.source.resourceKey !== resourceKey ||
      input.externalId !== expected
    ) {
      throw new BadRequestException('Driver reconstruction input identity does not match its resource context.');
    }
  }

  private async findAndMigrateBinding(
    tx: Prisma.TransactionClient,
    mappingId: string,
    resourceId: string,
    externalId: string,
    legacyRawId: string | null,
    integrationId: string,
    reconstruction: ReconstructionInput,
    now: Date,
  ) {
    const exact = await tx.integrationSyncRecord.findUnique({
      where: { integrationCompanyMappingId_resourceId_externalId: {
        integrationCompanyMappingId: mappingId, resourceId, externalId,
      } },
    });
    if (exact || !legacyRawId || legacyRawId === externalId) return exact;
    const legacy = await tx.integrationSyncRecord.findUnique({
      where: { integrationCompanyMappingId_resourceId_externalId: {
        integrationCompanyMappingId: mappingId, resourceId, externalId: legacyRawId,
      } },
    });
    if (!legacy) return null;
    const provenance = parseProvenance(legacy.provenance);
    const migratedProvenance = provenance
      ? { ...provenance, externalId }
      : migrationProvenance(integrationId, reconstruction, now);
    return tx.integrationSyncRecord.update({
      where: { id: legacy.id },
      data: {
        externalId,
        provenance: migratedProvenance as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private async resolveBinding(
    tx: Prisma.TransactionClient,
    mappingId: string,
    companyId: string,
    integrationId: string,
    ref: ReconstructionDependencyRef,
  ) {
    const dependency = await tx.integrationResource.findUnique({
      where: { integrationId_resourceKey: { integrationId, resourceKey: ref.resourceKey } },
      select: { id: true },
    });
    if (!dependency) return null;
    const binding = await tx.integrationSyncRecord.findUnique({
      where: { integrationCompanyMappingId_resourceId_externalId: {
        integrationCompanyMappingId: mappingId,
        resourceId: dependency.id,
        externalId: ref.externalId,
      } },
    });
    if (!binding) return null;
    const targetId = targetIdFromBinding(binding);
    return targetId
      ? {
          targetKind: binding.targetKind,
          targetId,
          companyId,
          resourceId: dependency.id,
          externalId: ref.externalId,
        }
      : null;
  }

  private accumulateWriterOutcome(
    totals: SyncRunTotals,
    conflicts: SyncRunConflict[],
    externalId: string,
    outcome: ReconstructionWriteOutcome,
  ): void {
    if (outcome.change === 'created') totals.created += 1;
    else if (outcome.change === 'updated') totals.updated += 1;
    else if (outcome.change === 'unchanged') totals.unchanged += 1;
    else if (outcome.change === 'restored') totals.restored += 1;
    else totals.blocked += 1;
    for (const gap of outcome.gaps.slice(0, 100)) {
      if (gap.kind === 'secret_blocked') totals.secretBlocked += 1;
      if (gap.kind === 'missing_dependency') totals.missingDependency += 1;
      conflicts.push({
        kind: gap.kind === 'synchronization_error' ? 'driver_error' : 'validation_error',
        externalId,
        message: gap.message.slice(0, 500),
      });
    }
  }

  private accumulateBlockedInput(
    totals: SyncRunTotals,
    conflicts: SyncRunConflict[],
    blocked: DriverBlockedInput,
  ): void {
    totals.blocked += 1;
    if (blocked.kind === 'secret_blocked') totals.secretBlocked += 1;
    if (blocked.kind === 'missing_dependency') totals.missingDependency += 1;
    conflicts.push({
      kind: blocked.kind === 'synchronization_error' ? 'driver_error' : 'validation_error',
      externalId: blocked.externalId ?? '',
      message: blocked.message.slice(0, 500),
    });
  }

}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

interface ResourceForReconstruction {
  id: string;
  resourceKey: string;
  targetKind: 'asset' | 'subnet' | 'ip_reservation' | 'article' | 'relation';
  targetConfig: unknown;
  assetLayoutId: string | null;
  matchKeyFieldIds: string[];
  fieldMappings: Array<{
    sourceField: string;
    syncDirection: 'source_wins' | 'preserve_manual' | 'manual_only';
    transform: unknown;
    targetField: {
      id: string;
      slug: string;
      fieldType: string;
      options: unknown;
      archivedAt: Date | null;
    } | null;
  }>;
}

type BindingLike = {
  id: string;
  targetKind: 'asset' | 'subnet' | 'ip_reservation' | 'article' | 'relation';
  assetId: string | null;
  subnetId: string | null;
  ipReservationId: string | null;
  articleId: string | null;
  relationId: string | null;
  state: 'active' | 'stale' | 'blocked';
  checksum: string;
  lastSyncedFieldChecksums: unknown;
  provenance: unknown;
};

function targetIdFromBinding(binding: BindingLike | null | undefined): string | null {
  if (!binding) return null;
  if (binding.targetKind === 'asset') return binding.assetId;
  if (binding.targetKind === 'subnet') return binding.subnetId;
  if (binding.targetKind === 'ip_reservation') return binding.ipReservationId;
  if (binding.targetKind === 'article') return binding.articleId;
  return binding.relationId;
}

function parseProvenance(value: unknown): SafeIntegrationProvenance | null {
  const parsed = integrationProvenanceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function bindingData(
  mappingId: string,
  resourceId: string,
  companyId: string,
  syncRunId: string,
  input: ReconstructionInput,
  outcome: ReconstructionWriteOutcome,
  provenance: SafeIntegrationProvenance,
  observedAt: Date,
  syncedAt: Date,
) {
  return {
    integrationCompanyMappingId: mappingId,
    resourceId,
    syncRunId,
    companyId,
    targetKind: outcome.targetKind,
    assetId: outcome.targetKind === 'asset' ? outcome.targetId : null,
    subnetId: outcome.targetKind === 'subnet' ? outcome.targetId : null,
    ipReservationId: outcome.targetKind === 'ip_reservation' ? outcome.targetId : null,
    articleId: outcome.targetKind === 'article' ? outcome.targetId : null,
    relationId: outcome.targetKind === 'relation' ? outcome.targetId : null,
    externalId: input.externalId,
    lastSyncedAt: syncedAt,
    state: 'active' as const,
    lastSeenAt: observedAt,
    staleSince: null,
    sourceUpdatedAt: input.source.updatedAt ? new Date(input.source.updatedAt) : null,
    provenance: provenance as unknown as Prisma.InputJsonValue,
    checksum: outcome.checksum,
    lastSyncedFieldChecksums: (outcome.fieldChecksums ?? {}) as Prisma.InputJsonValue,
  };
}

function deriveLegacyHighWater(records: DriverRecord[]): string | null {
  let highest: string | null = null;
  for (const record of records) {
    if (record.reconstructionInput !== undefined || !record.updatedAt) continue;
    const timestamp = Date.parse(record.updatedAt);
    if (!Number.isFinite(timestamp)) continue;
    const canonical = new Date(timestamp).toISOString();
    if (!highest || canonical > highest) highest = canonical;
  }
  return highest;
}

function boundedLegacyProvenance(
  value: string | null | undefined,
  field: string,
): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 256) {
    throw new BadRequestException(
      `Legacy driver ${field} must contain at most 256 characters.`,
    );
  }
  return value;
}

function migrationProvenance(
  integrationId: string,
  input: ReconstructionInput,
  now: Date,
): SafeIntegrationProvenance {
  const at = now.toISOString();
  return integrationProvenanceSchema.parse({
    integrationId,
    externalOrgId: input.source.externalOrgId,
    resourceKey: input.source.resourceKey,
    externalId: input.externalId,
    sourceRevision: input.source.revision ?? null,
    sourceFingerprint: input.source.fingerprint ?? null,
    firstSeenAt: at,
    lastSeenAt: at,
    lastSyncedAt: at,
    ownership: 'breeze',
    state: 'active',
  });
}

const MAX_RUN_CONFLICTS = 10_000;

class DryRunPageRollback extends Error {}

function mergePageOutcome(
  totals: SyncRunTotals,
  conflicts: SyncRunConflict[],
  pageTotals: SyncRunTotals,
  pageConflicts: SyncRunConflict[],
): void {
  for (const key of [
    'fetched', 'created', 'updated', 'unchanged', 'claimed', 'archived',
    'skippedAmbiguous', 'skippedManual', 'skippedArchived', 'stale', 'restored',
    'blocked', 'secretBlocked', 'missingDependency', 'errors',
  ] as const) {
    totals[key] += pageTotals[key];
  }
  const remaining = MAX_RUN_CONFLICTS - conflicts.length;
  if (remaining > 0) conflicts.push(...pageConflicts.slice(0, remaining));
}

function emptyTotals(): SyncRunTotals {
  return {
    fetched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    claimed: 0,
    archived: 0,
    skippedAmbiguous: 0,
    skippedManual: 0,
    skippedArchived: 0,
    stale: 0,
    restored: 0,
    blocked: 0,
    secretBlocked: 0,
    missingDependency: 0,
    errors: 0,
  };
}

/**
 * Stable hash of the projection config — source key, target field,
 * and direction for every writable mapping. Order-independent so a
 * cosmetic re-order doesn't blow the cache, but any semantic change
 * does.
 */
export function computeMappingFingerprint(
  writableMappings: ReadonlyArray<{
    sourceField: string;
    syncDirection: 'source_wins' | 'preserve_manual' | 'manual_only';
    targetField: { id: string };
    transform?: unknown;
  }>,
): string {
  const rows = writableMappings
    .map((m) => ({
      sourceField: m.sourceField,
      targetFieldId: m.targetField.id,
      syncDirection: m.syncDirection,
      transform:
        m.transform == null
          ? null
          : sortedJson(integrationTransformSchema.parse(m.transform)),
    }))
    .sort((a, b) => {
      if (a.sourceField !== b.sourceField) {
        return a.sourceField.localeCompare(b.sourceField);
      }
      if (a.targetFieldId !== b.targetFieldId) {
        return a.targetFieldId.localeCompare(b.targetFieldId);
      }
      return JSON.stringify(a).localeCompare(JSON.stringify(b));
    });
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortedJson((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}
