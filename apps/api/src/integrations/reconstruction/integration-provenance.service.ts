import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  integrationProvenanceSchema,
  integrationReconstructionGapInputSchema,
  integrationTargetProvenanceSchema,
  type IntegrationTargetKind,
  type IntegrationTargetProvenance,
  type ReconstructionGapKind,
  type SafeIntegrationProvenance,
} from '@weavestream/shared';
import { AuditLogService, type AuditEntry } from '../../audit/audit.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { scanSensitiveMaterial } from '../sensitive-material.js';
import {
  integrationTargetAuditAction,
  integrationTargetAuditAfter,
} from '../../audit/audit-actions.js';
import { RECONSTRUCTION_RUNTIME_LIMITS } from './reconstruction-limits.js';

const DEFAULT_STALE_BATCH = 200;
const DEFAULT_STALE_LIMIT = 10_000;
const TARGET_MUTATION_BATCH = RECONSTRUCTION_RUNTIME_LIMITS.nativeMutationBatch;
const MAX_GAPS_PER_PAGE = 1_000;

export async function readTargetProvenance(
  prisma: Pick<PrismaService, 'integrationSyncRecord'>,
  input: { companyId: string; targetKind: IntegrationTargetKind; targetId: string },
): Promise<IntegrationTargetProvenance[]> {
  const targetField = {
    asset: 'assetId', subnet: 'subnetId', ip_reservation: 'ipReservationId',
    article: 'articleId', relation: 'relationId',
  }[input.targetKind];
  const rows = await prisma.integrationSyncRecord.findMany({
    where: { companyId: input.companyId, targetKind: input.targetKind, [targetField]: input.targetId },
    select: {
      integrationCompanyMappingId: true, resourceId: true, targetKind: true,
      assetId: true, subnetId: true, ipReservationId: true, articleId: true, relationId: true,
      state: true, staleSince: true, provenance: true,
      asset: { select: { name: true, companyId: true } },
      subnet: { select: { name: true, companyId: true } },
      ipReservation: {
        select: {
          label: true, subnetId: true, companyId: true,
          subnet: { select: { companyId: true } },
        },
      },
      article: { select: { title: true, companyId: true } },
      relation: { select: { companyId: true } },
      companyMapping: {
        select: {
          companyId: true,
          integration: { select: { id: true, name: true, driver: true } },
        },
      },
      resource: { select: { resourceKey: true, integrationId: true } },
    },
    orderBy: [{ lastSyncedAt: 'desc' }, { id: 'asc' }],
    take: 100,
  });
  return rows.flatMap((row) => {
    const provenance = integrationProvenanceSchema.safeParse(row.provenance);
    if (!provenance.success || provenance.data.state !== row.state) return [];
    if (
      row.companyMapping.companyId !== input.companyId ||
      row.resource.integrationId !== row.companyMapping.integration.id ||
      provenance.data.integrationId !== row.companyMapping.integration.id ||
      provenance.data.resourceKey !== row.resource.resourceKey
    ) return [];
    const target = safeProvenanceTarget(input.companyId, row);
    if (!target) return [];
    const dto = integrationTargetProvenanceSchema.safeParse({
      integrationId: row.companyMapping.integration.id,
      integrationName: row.companyMapping.integration.name,
      integrationCompanyMappingId: row.integrationCompanyMappingId,
      resourceId: row.resourceId,
      sourceLabel: row.companyMapping.integration.name,
      sourceResource: row.resource.resourceKey,
      ownership: provenance.data.ownership,
      state: row.state,
      firstSeenAt: provenance.data.firstSeenAt,
      lastSeenAt: provenance.data.lastSeenAt,
      lastSyncedAt: provenance.data.lastSyncedAt,
      staleSince: row.staleSince?.toISOString() ?? null,
      target,
    });
    return dto.success ? [dto.data] : [];
  });
}

/**
 * Applies a gap observation only when it is at least as recent as the
 * stored row. Concurrent evaluations of one scope commit in arbitrary
 * order, so the recency guard lives in the WHERE clause of the write:
 * an older run finishing later must not reopen a gap a newer run
 * resolved, move `lastSeenAt` backwards, or replace newer observation
 * content. A resolved gap keeps its old `lastSeenAt`, so recency for
 * resolved rows is carried by `resolvedAt` — hence the two guard arms.
 *
 * The insert path is a single raw statement because it needs two
 * things Prisma's client API cannot express together: `ON CONFLICT DO
 * NOTHING` (a thrown unique violation would abort the caller's
 * surrounding transaction) and a cross-row `WHERE NOT EXISTS` recency
 * predicate against the scope's summary row. The summary's
 * `evaluatedAt` is the durable per-scope watermark — advanced by every
 * terminal authoritative evaluation, participant or not (clears write
 * a tombstone, never delete) — so a first observation from a stale
 * snapshot cannot insert an open gap that a newer completed sweep
 * already disproved. Row predicates alone cannot cover this case: they
 * only protect keys that already exist. No summary row means no newer
 * sweep has ever completed, and the insert proceeds (with
 * `lockScopeWatermark` seeding the row on first touch, this branch is
 * effectively unreachable for provenance callers, but the predicate
 * stays correct without relying on that).
 *
 * The `NOT EXISTS` subquery reads committed rows only, which is why
 * every caller runs under the scope watermark lock (persistGaps and
 * resolveAbsentGaps take it via `lockScopeWatermark`; the completeness
 * paths' guarded summary update self-locks): overlapping transactions
 * queue on the summary row, so the watermark this predicate evaluates
 * is always committed and final, never a value a concurrent
 * uncommitted sweep is about to advance.
 *
 * The statement is fully parameterized via the tagged template. It
 * bypasses the tenant-scoping middleware like every other
 * service-layer reconstruction write; `company_id` is bound explicitly
 * from the caller-derived scope.
 *
 * When the insert loses a concurrent same-key race, the final guarded
 * update re-applies against the now-visible row (READ COMMITTED
 * re-snapshots per statement) so a newer observation is never silently
 * dropped.
 */
export async function upsertReconstructionGap(
  tx: Prisma.TransactionClient,
  input: {
    companyId: string;
    integrationCompanyMappingId: string;
    resourceId: string;
    dedupeKey: string;
    syncRecordId: string | null;
    kind: ReconstructionGapKind;
    message: string;
    details: Prisma.InputJsonValue;
    seenAt: Date;
  },
): Promise<void> {
  const where = {
    companyId: input.companyId,
    integrationCompanyMappingId: input.integrationCompanyMappingId,
    resourceId: input.resourceId,
    dedupeKey: input.dedupeKey,
    OR: [
      { resolvedAt: null, lastSeenAt: { lte: input.seenAt } },
      { resolvedAt: { lte: input.seenAt } },
    ],
  };
  const data = {
    syncRecordId: input.syncRecordId,
    kind: input.kind,
    message: input.message,
    details: input.details,
    lastSeenAt: input.seenAt,
    resolvedAt: null,
  };
  const updated = await tx.integrationReconstructionGap.updateMany({ where, data });
  if (updated.count > 0) return;
  const inserted = await tx.$executeRaw`
    INSERT INTO "integration_reconstruction_gaps" (
      "company_id", "integration_company_mapping_id", "resource_id",
      "sync_record_id", "dedupe_key", "kind", "message", "details",
      "first_seen_at", "last_seen_at", "resolved_at", "updated_at"
    )
    SELECT
      ${input.companyId}::uuid,
      ${input.integrationCompanyMappingId}::uuid,
      ${input.resourceId}::uuid,
      ${input.syncRecordId}::uuid,
      ${input.dedupeKey},
      ${input.kind}::"ReconstructionGapKind",
      ${input.message},
      ${JSON.stringify(input.details)}::jsonb,
      ${input.seenAt},
      ${input.seenAt},
      NULL,
      CURRENT_TIMESTAMP
    WHERE NOT EXISTS (
      SELECT 1 FROM "integration_reconstruction_summaries" AS summary
      WHERE summary."company_id" = ${input.companyId}::uuid
        AND summary."integration_company_mapping_id" = ${input.integrationCompanyMappingId}::uuid
        AND summary."summary_key" = ${input.resourceId}
        AND summary."evaluated_at" > ${input.seenAt}
    )
    ON CONFLICT ("integration_company_mapping_id", "resource_id", "dedupe_key")
    DO NOTHING
  `;
  if (inserted > 0) return;
  await tx.integrationReconstructionGap.updateMany({ where, data });
}

/**
 * Locks the scope's summary/watermark row (`FOR UPDATE`) for the rest
 * of the caller's transaction, creating it when absent. This is the
 * per-scope serialization point for all gap-state mutation: gap
 * observation (`persistGaps`), terminal resolution
 * (`resolveAbsentGaps`), and the completeness paths (whose guarded
 * summary UPDATE takes the same row lock implicitly). It must be
 * acquired BEFORE any gap row — the shared summary-first lock order —
 * so overlapping transactions queue here instead of deadlocking
 * across the two tables or interleaving a sweep with a mid-flight
 * stale insert.
 *
 * `FOR UPDATE` locks nothing when the row does not exist, which would
 * leave concurrent FIRST evaluations of a scope unserialized. The
 * absent case therefore seeds the row: a cleared tombstone (readers
 * filter `clearedAt`; `clearedAt` records the seed time for
 * observability) whose `evaluatedAt` is the NEUTRAL epoch, not the
 * caller's snapshot time. Only terminal authoritative evaluations may
 * advance the clock: this helper runs on non-terminal pages, and a
 * page transaction commits independently of its run — a seed carrying
 * the page's snapshot time would survive a failed run and then reject
 * every legitimate terminal evaluation with an older snapshot
 * (`writeSummary`'s `lte` guard), leaving the scope a hidden
 * tombstone and no scorecard. The epoch is inert on both guards: the
 * insert predicate is strict `>` so it never blocks a gap write, and
 * the terminal guard is `lte` so any real evaluation claims the row.
 * Existing rows are only ever locked here, never modified. The seed
 * insert uses `ON CONFLICT DO NOTHING`, which also arbitrates
 * concurrent seeders — the loser waits out the winner's commit inside
 * the insert, then the final `FOR UPDATE` sees the committed row
 * (READ COMMITTED re-snapshots per statement) and queues on it.
 *
 * All statements here are tenant-scoped (`company_id` in every
 * predicate — raw queries bypass the tenant middleware), the seed is
 * additionally gated on the mapping actually belonging to the
 * caller's company, and the post-conflict re-lock fails closed when
 * it cannot find exactly one row in the caller's scope.
 */
const WATERMARK_SEED_EVALUATED_AT = new Date(0);

async function lockScopeWatermark(
  tx: Prisma.TransactionClient,
  scope: Pick<
    ProvenanceScope,
    'companyId' | 'integrationCompanyMappingId' | 'resourceId' | 'observedAt'
  >,
): Promise<void> {
  // Every watermark statement carries the tenant predicate: these raw
  // queries bypass the tenant middleware, and locking or reading a row
  // outside the caller's company scope is never acceptable — even
  // under inconsistent scope input.
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "integration_reconstruction_summaries"
    WHERE "company_id" = ${scope.companyId}::uuid
      AND "integration_company_mapping_id" = ${scope.integrationCompanyMappingId}::uuid
      AND "summary_key" = ${scope.resourceId}
    FOR UPDATE
  `;
  if (locked.length > 0) return;
  // The seed only materializes when the mapping really belongs to the
  // caller's company — the binding is enforced in the write predicate,
  // so inconsistent scope input cannot create a cross-scope row.
  const seeded = await tx.$executeRaw`
    INSERT INTO "integration_reconstruction_summaries" (
      "company_id", "integration_company_mapping_id", "resource_id",
      "summary_key", "counts", "evaluated_at", "last_successful_sync_at",
      "cleared_at", "updated_at"
    )
    SELECT
      ${scope.companyId}::uuid,
      ${scope.integrationCompanyMappingId}::uuid,
      ${scope.resourceId}::uuid,
      ${scope.resourceId},
      '{}'::jsonb,
      ${WATERMARK_SEED_EVALUATED_AT},
      NULL,
      ${scope.observedAt},
      CURRENT_TIMESTAMP
    WHERE EXISTS (
      SELECT 1 FROM "integration_company_mappings" AS mapping
      WHERE mapping."id" = ${scope.integrationCompanyMappingId}::uuid
        AND mapping."company_id" = ${scope.companyId}::uuid
    )
    ON CONFLICT ("integration_company_mapping_id", "summary_key") DO NOTHING
  `;
  if (seeded > 0) return;
  const relocked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "integration_reconstruction_summaries"
    WHERE "company_id" = ${scope.companyId}::uuid
      AND "integration_company_mapping_id" = ${scope.integrationCompanyMappingId}::uuid
      AND "summary_key" = ${scope.resourceId}
    FOR UPDATE
  `;
  // A consistent caller that lost the seed race always finds the
  // winner's row here (the winner wrote the same company scope). Zero
  // rows means the scope pairing is inconsistent — the stored row (or
  // the mapping) belongs to another company — and proceeding would
  // mean running unserialized and writing cross-scope gap rows. Fail
  // closed instead.
  if (relocked.length !== 1) {
    throw new BadRequestException('Reconstruction watermark scope mismatch.');
  }
}

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
    if (observations.length === 0) return;
    // Serialization point, acquired BEFORE any gap row (the summary-first
    // lock order shared with recalculate/clearNonParticipant): the
    // insert path's watermark predicate reads committed rows only, so
    // without this lock an overlapping uncommitted sweep could advance
    // the watermark and resolve gaps while a stale observation still
    // saw the previous watermark and inserted. Queueing here means the
    // watermark is always committed and stable when the predicate runs.
    await lockScopeWatermark(tx, scope);
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
      await upsertReconstructionGap(tx, {
        companyId: scope.companyId,
        integrationCompanyMappingId: scope.integrationCompanyMappingId,
        resourceId: scope.resourceId,
        dedupeKey,
        syncRecordId: observation.syncRecordId,
        kind: parsed.kind,
        message: parsed.message,
        details: parsed.details as Prisma.InputJsonValue,
        seenAt: scope.observedAt,
      });
    }
  }

  async resolveAbsentGaps(
    tx: Prisma.TransactionClient,
    scope: ProvenanceScope,
  ): Promise<void> {
    // Same serialization point as persistGaps: the terminal sweep must
    // not scan while a concurrent stale observation is mid-insert, or
    // the sweep misses it and the stale gap survives open. Whichever
    // transaction queues second sees the other's committed writes.
    await lockScopeWatermark(tx, scope);
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
          state: { in: ['active', 'blocked'] },
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

    for (let offset = 0; offset < rows.length; offset += TARGET_MUTATION_BATCH) {
      const batch = rows.slice(offset, offset + TARGET_MUTATION_BATCH);
      await tx.$executeRaw(Prisma.sql`
        UPDATE "integration_sync_records"
        SET
          "state" = 'stale'::"IntegrationSyncState",
          "stale_since" = COALESCE("stale_since", ${input.snapshotAt}),
          "provenance" = jsonb_set("provenance", '{state}', '"stale"'::jsonb, true),
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" IN (${Prisma.join(batch.map((row) => Prisma.sql`${row.id}::uuid`))})
      `);
    }
    if (this.audit?.logManyWithClient) {
      const auditEntries: AuditEntry[] = rows.map((row) => {
        const targetId = targetIdForKind(row, row.targetKind);
        return {
          actorId: input.auditActorId,
          action: integrationTargetAuditAction('stale'),
          entityType: 'IntegrationTarget',
          entityId: targetId,
          companyId: input.companyId,
          ip: '0.0.0.0',
          userAgent: 'weavestream-worker/integration-reconstruction',
          after: integrationTargetAuditAfter({
            integrationId: input.integrationId,
            integrationCompanyMappingId: input.integrationCompanyMappingId,
            resourceId: input.resourceId,
            targetId,
            targetKind: row.targetKind,
            state: 'stale',
            counts: { records: 1, gaps: 0 },
          }),
        };
      });
      await this.audit.logManyWithClient(tx, auditEntries);
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
  state: 'active' | 'blocked' | 'stale';
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

function safeProvenanceTarget(
  companyId: string,
  row: {
    targetKind: string;
    assetId: string | null; subnetId: string | null; ipReservationId: string | null;
    articleId: string | null; relationId: string | null;
    asset: { name: string; companyId: string } | null;
    subnet: { name: string; companyId: string } | null;
    ipReservation: {
      label: string;
      subnetId: string;
      companyId: string;
      subnet: { companyId: string };
    } | null;
    article: { title: string; companyId: string } | null;
    relation: { companyId: string } | null;
  },
) {
  if (row.targetKind === 'asset' && row.assetId && row.asset?.companyId === companyId) return {
    targetKind: 'asset' as const, targetId: row.assetId, targetLabel: row.asset.name,
    targetHref: `/admin/companies/${companyId}/assets/${row.assetId}`,
  };
  if (row.targetKind === 'subnet' && row.subnetId && row.subnet?.companyId === companyId) return {
    targetKind: 'subnet' as const, targetId: row.subnetId, targetLabel: row.subnet.name,
    targetHref: `/admin/companies/${companyId}/ipam/${row.subnetId}`,
  };
  if (
    row.targetKind === 'ip_reservation' &&
    row.ipReservationId &&
    row.ipReservation?.companyId === companyId &&
    row.ipReservation.subnet.companyId === companyId
  ) return {
    targetKind: 'ip_reservation' as const, targetId: row.ipReservationId,
    targetLabel: row.ipReservation.label,
    targetHref: `/admin/companies/${companyId}/ipam/${row.ipReservation.subnetId}`,
  };
  if (row.targetKind === 'article' && row.articleId && row.article?.companyId === companyId) return {
    targetKind: 'article' as const, targetId: row.articleId, targetLabel: row.article.title,
    targetHref: `/admin/companies/${companyId}/articles/${row.articleId}`,
  };
  if (row.targetKind === 'relation' && row.relationId && row.relation?.companyId === companyId) return {
    targetKind: 'relation' as const, targetId: row.relationId, targetLabel: 'Relationship', targetHref: null,
  };
  return null;
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
        state: { in: ['active', 'blocked'] },
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
