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
 *      `(companyMappingId, resourceId, externalId)` → reuse it. The
 *      link is durable.
 *   2. There is an asset whose `externalSource = integration.driver` and
 *      `externalId = externalId` (in the same company) → reuse it. This
 *      handles the case where an operator deleted the sync-record but
 *      the asset still carries the linkage.
 *   3. The mapping has `matchKeyFieldIds` configured → look for any
 *      asset in the same company whose stored values for those fields
 *      match the values the driver projected onto the same target
 *      fields, AND that does not already carry a sync record from THIS
 *      `(mapping, resource)` pair. Comparison is case-insensitive for
 *      TEXT/EMAIL/URL, strict otherwise.
 *      - Single match → "claim" the asset (an asset can be claimed by
 *        multiple integrations simultaneously — a UniFi client and an
 *        Action1 endpoint with the same IP both link to one Weavestream
 *        asset; only the FIRST integration to touch the asset writes
 *        `Asset.externalId` / `externalSource`).
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
    /** Phase 11.1 — sync-record namespace is per-resource. */
    resourceId: string;
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
        integrationCompanyMappingId_resourceId_externalId: {
          integrationCompanyMappingId: args.integrationCompanyMappingId,
          resourceId: args.resourceId,
          externalId: args.externalId,
        },
      },
      select: { assetId: true },
    });
    if (existing?.assetId) return { kind: 'reuse', assetId: existing.assetId };
    if (existing) {
      throw new Error('Asset matching encountered a non-asset integration binding');
    }

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
      integrationCompanyMappingId: args.integrationCompanyMappingId,
      resourceId: args.resourceId,
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
   * Searches for assets in the same company whose stored values for
   * every match-key field equal the projected source value.
   *
   * Eligible candidate = ANY non-archived asset that does NOT already
   * carry a sync record from THIS `(mapping, resource)` pair. Assets
   * owned by other integrations (or other resources of the same
   * integration) ARE eligible — that is the whole point of cross-
   * integration matching: an Action1 endpoint and a UniFi client with
   * the same IP should resolve to the SAME Weavestream asset.
   *
   * The exclusion guards against the only invariant the writer needs:
   * a single (mapping, resource) cannot bind two different external
   * ids to the same asset (the unique on
   * `(integrationCompanyMappingId, resourceId, externalId)` would
   * reject a colliding upsert anyway, but rejecting it here lets us
   * surface a clean "ambiguous" conflict instead of a 500).
   */
  private async matchByKey(args: {
    companyId: string;
    integrationCompanyMappingId: string;
    resourceId: string;
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
            // Cross-integration matching: the asset is eligible as
            // long as it does not already carry a sync record from
            // THIS (mapping, resource). Assets owned by other
            // integrations / other resources can still be claimed.
            integrationSyncRecords: {
              none: {
                integrationCompanyMappingId: args.integrationCompanyMappingId,
                resourceId: args.resourceId,
              },
            },
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
