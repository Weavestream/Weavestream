import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  integrationProvenanceSchema,
  integrationReconstructionGapInputSchema,
  type IntegrationTargetKind,
  type ReconstructionGapKind,
  type SafeIntegrationProvenance,
} from '@weavestream/shared';
import { AuditLogService } from '../../audit/audit.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { scanSensitiveMaterial } from '../sensitive-material.js';

const DEFAULT_STALE_BATCH = 200;
const DEFAULT_STALE_LIMIT = 10_000;
const TARGET_MUTATION_BATCH = 500;
const MAX_GAPS_PER_PAGE = 1_000;

export interface ProvenanceBuildInput {
  integrationId: string;
  externalOrgId: string;
  resourceKey: string;
  externalId: string;
  sourceRevision: string | null;
  sourceFingerprint: string | null;
  observedAt: Date;
  syncedAt: Date | null;
  state: 'active' | 'stale' | 'blocked';
  previous: SafeIntegrationProvenance | null;
}

export interface ProvenanceScope {
  companyId: string;
  integrationCompanyMappingId: string;
  resourceId: string;
  observedAt: Date;
}

export interface SafeGapObservation {
  externalId: string | null;
  syncRecordId: string | null;
  kind: ReconstructionGapKind;
  message: string;
  details: Record<string, unknown>;
}

export interface StaleSweepInput extends Omit<ProvenanceScope, 'observedAt'> {
  integrationId: string;
  targetKind: IntegrationTargetKind;
  snapshotAt: Date;
  auditActorId: string;
  batchSize?: number;
  maxRecords?: number;
}

export interface MoveConflictInput {
  integrationId: string;
  integrationCompanyMappingId: string;
  resourceId: string;
  companyId: string;
  resourceKey: string;
  sourceId: string;
}

@Injectable()
export class IntegrationProvenanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  buildProvenance(input: ProvenanceBuildInput): SafeIntegrationProvenance {
    return integrationProvenanceSchema.parse({
      integrationId: input.integrationId,
      externalOrgId: input.externalOrgId,
      resourceKey: input.resourceKey,
      externalId: input.externalId,
      sourceRevision: input.sourceRevision,
      sourceFingerprint: input.sourceFingerprint,
      firstSeenAt: input.previous?.firstSeenAt ?? input.observedAt.toISOString(),
      lastSeenAt: input.observedAt.toISOString(),
      lastSyncedAt: input.syncedAt?.toISOString() ?? input.previous?.lastSyncedAt ?? null,
      ownership: input.previous?.ownership ?? 'breeze',
      state: input.state,
    });
  }

  async persistGaps(
    tx: Prisma.TransactionClient,
    scope: ProvenanceScope,
    observations: readonly SafeGapObservation[],
  ): Promise<void> {
    if (observations.length > MAX_GAPS_PER_PAGE) {
      throw new BadRequestException('Gap observations exceeded the bounded page limit.');
    }
    for (const observation of observations) {
      const message = safeGapMessage(observation.kind, observation.message);
      const safeExternalId = safeGapExternalId(observation.externalId);
      const parsed = integrationReconstructionGapInputSchema.parse({
        companyId: scope.companyId,
        integrationCompanyMappingId: scope.integrationCompanyMappingId,
        resourceId: scope.resourceId,
        externalId: safeExternalId,
        kind: observation.kind,
        message,
        details: observation.details,
        firstSeenAt: scope.observedAt.toISOString(),
        lastSeenAt: scope.observedAt.toISOString(),
        resolvedAt: null,
      });
      const dedupeKey = gapDedupeKey({
        externalId: parsed.externalId,
        kind: parsed.kind,
        details: parsed.details,
      });
      await tx.integrationReconstructionGap.upsert({
        where: {
          integrationCompanyMappingId_resourceId_dedupeKey: {
            integrationCompanyMappingId: scope.integrationCompanyMappingId,
            resourceId: scope.resourceId,
            dedupeKey,
          },
        },
        create: {
          companyId: scope.companyId,
          integrationCompanyMappingId: scope.integrationCompanyMappingId,
          resourceId: scope.resourceId,
          syncRecordId: observation.syncRecordId,
          dedupeKey,
          kind: parsed.kind,
          message: parsed.message,
          details: parsed.details as Prisma.InputJsonValue,
          firstSeenAt: scope.observedAt,
          lastSeenAt: scope.observedAt,
          resolvedAt: null,
        },
        update: {
          syncRecordId: observation.syncRecordId,
          kind: parsed.kind,
          message: parsed.message,
          details: parsed.details as Prisma.InputJsonValue,
          lastSeenAt: scope.observedAt,
          resolvedAt: null,
        },
      });
    }
  }

  async resolveAbsentGaps(
    tx: Prisma.TransactionClient,
    scope: ProvenanceScope,
  ): Promise<void> {
    await tx.integrationReconstructionGap.updateMany({
      where: {
        companyId: scope.companyId,
        integrationCompanyMappingId: scope.integrationCompanyMappingId,
        resourceId: scope.resourceId,
        resolvedAt: null,
        lastSeenAt: { lt: scope.observedAt },
        NOT: { dedupeKey: { startsWith: 'completeness:' } },
      },
      data: { resolvedAt: scope.observedAt },
    });
  }

  async findMoveConflict(
    tx: Prisma.TransactionClient,
    input: MoveConflictInput,
  ): Promise<{ count: number } | null> {
    const suffix = `:${input.resourceKey}:${input.sourceId}`;
    const rows = await tx.integrationSyncRecord.findMany({
      where: {
        resourceId: input.resourceId,
        integrationCompanyMappingId: { not: input.integrationCompanyMappingId },
        externalId: { endsWith: suffix },
        companyMapping: { integrationId: input.integrationId },
      },
      select: { id: true, companyId: true },
      orderBy: { id: 'asc' },
      take: 2,
    });
    return rows.length > 0 ? { count: rows.length } : null;
  }

  async staleUnseen(
    tx: Prisma.TransactionClient,
    input: StaleSweepInput,
  ): Promise<{ stale: number; archived: number }> {
    const batchSize = Math.min(Math.max(input.batchSize ?? DEFAULT_STALE_BATCH, 1), 500);
    const maxRecords = Math.min(Math.max(input.maxRecords ?? DEFAULT_STALE_LIMIT, 1), 10_000);
    const rows: StaleBinding[] = [];
    let cursor: string | undefined;
    let scanned = 0;
    while (true) {
      const remaining = maxRecords - scanned;
      const page = await tx.integrationSyncRecord.findMany({
        where: {
          companyId: input.companyId,
          integrationCompanyMappingId: input.integrationCompanyMappingId,
          resourceId: input.resourceId,
          targetKind: input.targetKind,
          state: 'active',
          lastSeenAt: { lt: input.snapshotAt },
          provenance: { path: ['ownership'], equals: 'breeze' },
        },
        orderBy: { id: 'asc' },
        take: Math.min(batchSize, remaining) + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (page.length > remaining || (page.length > batchSize && rows.length + page.length > maxRecords)) {
        throw new BadRequestException('Full reconciliation stale sweep exceeded its bounded limit.');
      }
      const accepted = page.slice(0, Math.min(page.length, batchSize)) as StaleBinding[];
      scanned += accepted.length;
      rows.push(...accepted.filter((row) => {
        const provenance = integrationProvenanceSchema.safeParse(row.provenance);
        return provenance.success && provenance.data.ownership === 'breeze';
      }));
      if (page.length <= batchSize) break;
      cursor = accepted.at(-1)?.id;
      if (!cursor) break;
    }

    const protectedTargetIds = await findProtectedTargets(tx, input, rows);
    let archived = 0;
    archived += await archiveTargetGroup(
      tx, 'asset', input,
      targetIds(rows, 'asset').filter((id) => !protectedTargetIds.has(id)),
    );
    archived += await archiveTargetGroup(
      tx, 'article', input,
      targetIds(rows, 'article').filter((id) => !protectedTargetIds.has(id)),
    );
    archived += await archiveTargetGroup(
      tx, 'subnet', input,
      targetIds(rows, 'subnet').filter((id) => !protectedTargetIds.has(id)),
    );

    for (const row of rows) {
      const previous = integrationProvenanceSchema.safeParse(row.provenance);
      const provenance = previous.success
        ? { ...previous.data, state: 'stale' as const }
        : row.provenance;
      await tx.integrationSyncRecord.update({
        where: { id: row.id },
        data: {
          state: 'stale',
          staleSince: row.staleSince ?? input.snapshotAt,
          provenance: provenance as Prisma.InputJsonValue,
        },
      });
      if (this.audit?.logWithClient) {
        await this.audit.logWithClient(tx, {
          actorId: input.auditActorId,
          action: 'integration.reconstruction.stale',
          entityType: 'IntegrationSyncRecord',
          entityId: row.id,
          companyId: input.companyId,
          ip: '0.0.0.0',
          userAgent: 'weavestream-worker/integration-reconstruction',
          before: { state: 'active' },
          after: { state: 'stale', targetKind: row.targetKind },
        });
      }
    }
    return { stale: rows.length, archived };
  }
}

type StaleBinding = {
  id: string;
  targetKind: IntegrationTargetKind;
  assetId: string | null;
  subnetId: string | null;
  ipReservationId: string | null;
  articleId: string | null;
  relationId: string | null;
  staleSince: Date | null;
  provenance: unknown;
};

function safeGapMessage(kind: ReconstructionGapKind, message: string): string {
  if (message.length > 512 || scanSensitiveMaterial(message) !== 'safe') {
    return `A ${kind.replaceAll('_', ' ')} item requires operator review.`;
  }
  return message;
}

function safeGapExternalId(externalId: string | null): string | null {
  if (externalId === null || externalId.length > 512) return null;
  return scanSensitiveMaterial(externalId) === 'safe' ? externalId : null;
}

function gapDedupeKey(observation: {
  externalId: string | null;
  kind: ReconstructionGapKind;
  details: Record<string, unknown>;
}): string {
  const details = observation.details;
  const discriminator = {
    externalId: observation.externalId,
    kind: observation.kind,
    reasonCode: details['reasonCode'] ?? null,
    unsupportedCapability: details['unsupportedCapability'] ?? null,
    dependencyResourceKey: details['dependencyResourceKey'] ?? null,
    dependencyExternalId: details['dependencyExternalId'] ?? null,
    validationCodes: details['validationCodes'] ?? null,
  };
  return createHash('sha256').update(JSON.stringify(discriminator)).digest('hex');
}

function targetIds(
  rows: readonly StaleBinding[],
  kind: 'asset' | 'article' | 'subnet',
): string[] {
  const key = kind === 'asset' ? 'assetId' : kind === 'article' ? 'articleId' : 'subnetId';
  return rows
    .filter((row) => row.targetKind === kind)
    .map((row) => row[key])
    .filter((id): id is string => typeof id === 'string');
}

async function archiveTargetGroup(
  tx: Prisma.TransactionClient,
  kind: 'asset' | 'article' | 'subnet',
  input: StaleSweepInput,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const delegate = tx[kind] as unknown as {
    updateMany(args: unknown): Promise<{ count: number } | undefined>;
  };
  let archivedCount = 0;
  for (let offset = 0; offset < ids.length; offset += TARGET_MUTATION_BATCH) {
    const batch = ids.slice(offset, offset + TARGET_MUTATION_BATCH);
    const result = await delegate.updateMany({
      where: { id: { in: batch }, companyId: input.companyId, archivedAt: null },
      data: { archivedAt: input.snapshotAt, updatedBy: input.auditActorId },
    });
    const batchArchived = result?.count ?? batch.length;
    archivedCount += batchArchived;
    if (kind === 'asset' && batchArchived > 0) {
      await tx.searchIndex.updateMany({
        where: {
          entityType: 'Asset',
          entityId: { in: batch },
          companyId: input.companyId,
          archivedAt: null,
        },
        data: { archivedAt: input.snapshotAt },
      });
    }
  }
  return archivedCount;
}

async function findProtectedTargets(
  tx: Prisma.TransactionClient,
  input: StaleSweepInput,
  rows: readonly StaleBinding[],
): Promise<Set<string>> {
  if (!['asset', 'article', 'subnet'].includes(input.targetKind)) return new Set();
  const ids = targetIds(rows, input.targetKind as 'asset' | 'article' | 'subnet');
  if (ids.length === 0) return new Set();
  const targetField = input.targetKind === 'asset'
    ? 'assetId'
    : input.targetKind === 'article'
      ? 'articleId'
      : 'subnetId';
  const protectedIds = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += TARGET_MUTATION_BATCH) {
    const batch = ids.slice(offset, offset + TARGET_MUTATION_BATCH);
    const batchSet = new Set(batch);
    const staleRowIds = rows
      .filter((row) => batchSet.has(targetIdForKind(row, input.targetKind)))
      .map((row) => row.id);
    const active = await tx.integrationSyncRecord.findMany({
      where: {
        companyId: input.companyId,
        targetKind: input.targetKind,
        state: 'active',
        id: { notIn: staleRowIds },
        [targetField]: { in: batch },
      },
      select: { [targetField]: true },
      distinct: [targetField],
      take: batch.length + 1,
    } as never);
    if (active.length > batch.length) {
      throw new BadRequestException('Shared target ownership query exceeded its bounded limit.');
    }
    const selected = active as unknown as Array<Record<string, unknown>>;
    for (const row of selected) {
      const id = row[targetField];
      if (typeof id === 'string') protectedIds.add(id);
    }
  }
  return protectedIds;
}

function targetIdForKind(row: StaleBinding, kind: IntegrationTargetKind): string {
  if (kind === 'asset') return row.assetId ?? '';
  if (kind === 'article') return row.articleId ?? '';
  if (kind === 'subnet') return row.subnetId ?? '';
  if (kind === 'ip_reservation') return row.ipReservationId ?? '';
  return row.relationId ?? '';
}
