import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { FieldTypesRegistry } from '../field-types/field-types.registry.js';

/**
 * Phase 11 — match-by-key conflict resolution.
 *
 * When the worker pulls an external record it has to decide: which
 * Weavestream `Asset` (if any) does this row belong to?
 *
 * Decision tree (encoded in `resolve()`):
 *   1. There is already an `IntegrationSyncRecord` for this
 *      `(companyMappingId, externalId)` → reuse it. The link is durable.
 *   2. There is an asset whose `externalSource = integration.driver` and
 *      `externalId = externalId` (in the same company) → reuse it. This
 *      handles the case where an operator deleted the sync-record but
 *      the asset still carries the linkage.
 *   3. The mapping has `matchKeyFieldIds` configured → look for an
 *      unclaimed asset (no externalSource) whose stored values for those
 *      fields match the values the driver projected onto the same
 *      target fields. Comparison is case-insensitive for TEXT/EMAIL/URL,
 *      strict otherwise.
 *      - Single match → "claim" the asset.
 *      - Two or more matches → ambiguous; return a conflict so the run
 *        viewer can surface the candidates without auto-mutating.
 *      - Zero matches → fall through.
 *   4. Otherwise: create a new asset.
 *
 * The service is pure resolution — it does NOT mutate the asset or
 * write the sync record; the caller (`IntegrationSyncRunnerService`)
 * does that inside its own transaction so the per-record bookkeeping
 * is atomic with the field writes.
 */
export type MatchResolution =
  | { kind: 'reuse'; assetId: string }
  | { kind: 'claim'; assetId: string }
  | { kind: 'create' }
  | { kind: 'ambiguous'; candidateAssetIds: string[] };

@Injectable()
export class MatchResolverService {
  private readonly logger = new Logger(MatchResolverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fieldTypes: FieldTypesRegistry,
  ) {}

  async resolve(args: {
    companyId: string;
    integrationCompanyMappingId: string;
    integrationDriver: string;
    externalId: string;
    /** Raw source-field-keyed payload from the driver. */
    source: Record<string, unknown>;
    /**
     * Mapping rows used to project source fields onto target AssetFields.
     * Already filtered to `syncDirection != manual_only`.
     */
    fieldMappings: Array<{
      sourceField: string;
      targetField: {
        id: string;
        slug: string;
        fieldType: string;
        options: unknown;
      };
    }>;
    /** AssetField ids the operator chose as the match key (in order). */
    matchKeyFieldIds: string[];
  }): Promise<MatchResolution> {
    const existing = await this.prisma.integrationSyncRecord.findUnique({
      where: {
        integrationCompanyMappingId_externalId: {
          integrationCompanyMappingId: args.integrationCompanyMappingId,
          externalId: args.externalId,
        },
      },
      select: { assetId: true },
    });
    if (existing) return { kind: 'reuse', assetId: existing.assetId };

    const linked = await this.prisma.asset.findFirst({
      where: {
        companyId: args.companyId,
        externalId: args.externalId,
        externalSource: args.integrationDriver,
        archivedAt: null,
      },
      select: { id: true },
    });
    if (linked) return { kind: 'reuse', assetId: linked.id };

    if (args.matchKeyFieldIds.length === 0) {
      return { kind: 'create' };
    }

    const candidates = await this.matchByKey({
      companyId: args.companyId,
      integrationDriver: args.integrationDriver,
      source: args.source,
      fieldMappings: args.fieldMappings,
      matchKeyFieldIds: args.matchKeyFieldIds,
    });

    if (candidates.length === 0) return { kind: 'create' };
    if (candidates.length === 1) return { kind: 'claim', assetId: candidates[0]! };
    return {
      kind: 'ambiguous',
      candidateAssetIds: candidates.slice(0, 5),
    };
  }

  /**
   * Searches for unclaimed assets in the same company whose stored
   * values for every match-key field equal the projected source value.
   *
   * "Unclaimed" = `externalSource IS NULL` OR `externalSource =
   * integrationDriver` AND no IntegrationSyncRecord exists for the
   * asset. We exclude rows already pinned to a sync record because
   * those belong to a different externalId in the same integration
   * (claiming them would corrupt their existing sync linkage).
   */
  private async matchByKey(args: {
    companyId: string;
    integrationDriver: string;
    source: Record<string, unknown>;
    fieldMappings: Array<{
      sourceField: string;
      targetField: {
        id: string;
        slug: string;
        fieldType: string;
        options: unknown;
      };
    }>;
    matchKeyFieldIds: string[];
  }): Promise<string[]> {
    const projectedByFieldId: Record<string, unknown> = {};
    for (const fid of args.matchKeyFieldIds) {
      const fm = args.fieldMappings.find((m) => m.targetField.id === fid);
      if (!fm) continue;
      const raw = args.source[fm.sourceField];
      if (raw === null || raw === undefined || raw === '') continue;
      try {
        const strategy = this.fieldTypes.get(fm.targetField.fieldType as never);
        const options = (fm.targetField.options ?? {}) as Record<string, unknown>;
        projectedByFieldId[fid] = strategy.normalize(raw, options);
      } catch (err) {
        this.logger.debug(
          { err: (err as Error).message, sourceField: fm.sourceField },
          'matchByKey: failed to normalise candidate value, skipping field',
        );
      }
    }
    if (Object.keys(projectedByFieldId).length === 0) return [];

    const fieldRows = await this.prisma.assetField.findMany({
      where: { id: { in: Object.keys(projectedByFieldId) } },
      select: { id: true, fieldType: true },
    });
    const fieldTypeById = new Map(fieldRows.map((r) => [r.id, r.fieldType]));

    const candidatesPerField: string[][] = [];
    for (const [fieldId, normalised] of Object.entries(projectedByFieldId)) {
      const fieldType = fieldTypeById.get(fieldId);
      if (!fieldType) return [];

      const variants = expandVariants(fieldType, normalised);
      const rows = await this.prisma.assetFieldValue.findMany({
        where: {
          companyId: args.companyId,
          assetFieldId: fieldId,
          OR: variants.map((v) => ({ value: { equals: v as Prisma.InputJsonValue } })),
          asset: {
            archivedAt: null,
            integrationSyncRecord: { is: null },
            OR: [
              { externalSource: null },
              { externalSource: args.integrationDriver, externalId: null },
            ],
          },
        },
        select: { assetId: true },
      });
      if (rows.length === 0) return [];
      candidatesPerField.push(rows.map((r) => r.assetId));
    }

    return intersectAll(candidatesPerField);
  }
}

/**
 * Build the candidate list of values to compare against a stored
 * AssetFieldValue. We can't use Postgres's `LOWER()` in a Prisma JSONB
 * filter directly, so for case-insensitive types we OR over the
 * lowercased / uppercased / as-is variants of the normalised value.
 * Good enough in practice because match-key fields are short
 * identifier-style strings (hostnames, emails, urls); a future
 * optimisation can add a `lower(value)` expression index if it ever
 * becomes hot.
 */
function expandVariants(fieldType: string, normalised: unknown): unknown[] {
  const isCaseInsensitive =
    fieldType === 'TEXT' ||
    fieldType === 'EMAIL' ||
    fieldType === 'URL';
  if (typeof normalised !== 'string' || !isCaseInsensitive) {
    return [normalised];
  }
  return Array.from(new Set([
    normalised,
    normalised.toLowerCase(),
    normalised.toUpperCase(),
  ]));
}

function intersectAll(lists: string[][]): string[] {
  if (lists.length === 0) return [];
  let acc = new Set(lists[0]);
  for (let i = 1; i < lists.length; i += 1) {
    const next = new Set(lists[i]);
    acc = new Set([...acc].filter((id) => next.has(id)));
    if (acc.size === 0) return [];
  }
  return [...acc];
}
