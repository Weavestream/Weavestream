import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  Prisma,
  Asset,
  AssetField,
  AssetFieldValue,
  AssetLayout,
} from '@prisma/client';
import type {
  BulkAssetResult,
  CreateAssetInput,
  UpdateAssetInput,
  UserRole,
} from '@weavestream/shared';
import type { IntegrationTargetProvenance } from '@weavestream/shared';
import { readTargetProvenance } from '../integrations/reconstruction/integration-provenance.service.js';
import { FILTERABLE_FIELD_TYPES } from '@weavestream/shared';
import type { FileFieldEntry } from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { isUniqueConstraintError } from '../prisma/prisma-errors.js';
import { AuditLogService } from '../audit/audit.service.js';
import { FieldTypesRegistry } from '../field-types/field-types.registry.js';
import { RelationsService } from '../relations/relations.service.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { SearchIndexService } from '../search/search-index.service.js';
import { PasswordsService } from '../passwords/passwords.service.js';
import { StarsService } from '../stars/stars.service.js';
import { TagsService } from '../tags/tags.service.js';
import { buildAssetZodSchema } from './build-asset-schema.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { expandMatchValueVariants } from '../integrations/match-resolver.service.js';
import { hasEligibleNativeBinding } from '../integrations/reconstruction/native-binding-ownership.js';

export interface AuditMeta {
  ip: string;
  userAgent: string;
}

/**
 * Write-side field checksum recorded into
 * `IntegrationSyncRecord.lastSyncedFieldChecksums`. Exported so readers
 * (company export, WS-CR-019) can verify field-level integration
 * authorship against the exact algorithm the writer used.
 */
export function assetFieldChecksum(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

export function classifyIntegrationAssetChange(input: {
  exists: boolean;
  restored: boolean;
  identityChanged: boolean;
  fieldsChanged: boolean;
}): IntegrationAssetWriteResult['change'] {
  if (!input.exists) return 'created';
  if (input.restored) return 'restored';
  return input.identityChanged || input.fieldsChanged ? 'updated' : 'unchanged';
}

function integrationAssetBlocked(
  companyId: string,
  kind: 'missing_dependency' | 'validation' | 'ambiguous' | 'synchronization_error',
  message: string,
  reasonCode: string,
  targetId = '',
): IntegrationAssetWriteResult {
  return {
    targetId,
    companyId,
    change: 'blocked',
    gap: { kind, message, details: { reasonCode } },
  };
}

export interface IntegrationAssetWriteInput {
  tx?: Prisma.TransactionClient;
  companyId: string;
  integrationId: string;
  integrationCompanyMappingId: string;
  resourceId: string;
  auditActorId: string;
  dryRun: boolean;
  externalId: string;
  externalSource?: string;
  existingTargetId?: string | null;
  ownershipBinding?: { resourceId: string; externalId: string };
  name: string;
  assetLayoutId: string;
  matchKeyFieldIds: string[];
  fieldValues: Array<{
    targetFieldId: string;
    value: unknown;
    syncDirection: 'source_wins' | 'preserve_manual' | 'manual_only';
  }>;
  previousFieldChecksums: Readonly<Record<string, string>>;
}

function legacyIntegrationExternalSource(
  input: IntegrationAssetWriteInput,
): string | null {
  return input.externalSource === `breeze:${input.integrationId}`
    ? 'breeze'
    : null;
}

/**
 * Raised when one of the partial unique indexes on
 * (companyId, externalSource, externalId) — migration 0062 — rejects a
 * write that raced another identity claim past `assertExternalIdFree`.
 * Carries no payload; each catch site translates it for its write mode.
 */
class AssetExternalIdentityConflictError extends Error {
  constructor() {
    super('Another asset claimed this external identity concurrently.');
  }
}

/** The 409 payload shape shared by the pre-check and the index backstop. */
function externalIdTakenConflict(
  externalId: string,
  externalSource: string | null,
): ConflictException {
  return new ConflictException({
    error: 'ExternalIdTaken',
    externalId,
    externalSource,
    message: `Another asset already carries external id "${externalId}".`,
  });
}

/**
 * Outcome for an integration write that lost an identity race to a
 * concurrent writer. Under a caller-provided transaction the unique
 * violation has already aborted the surrounding page transaction, so a
 * re-read is impossible — report a retryable synchronization gap; the
 * runner rolls the page back and the next run resolves against the
 * winner (or lands on the pre-check's `manual_ownership`/409 block if
 * the conflict persists). Standalone writes retry from a fresh read.
 */
function integrationIdentityConflictResult(
  input: IntegrationAssetWriteInput,
): IntegrationAssetWriteResult | 'revision_conflict' {
  if (!input.tx) return 'revision_conflict';
  return integrationAssetBlocked(
    input.companyId,
    'synchronization_error',
    'Another asset claimed this external identity while reconstruction was writing.',
    'external_identity_conflict',
  );
}

export interface IntegrationAssetWriteResult {
  targetId: string;
  companyId: string;
  change: 'created' | 'updated' | 'unchanged' | 'restored' | 'blocked';
  fieldChecksums?: Record<string, string>;
  gap?: {
    kind: 'missing_dependency' | 'validation' | 'ambiguous' | 'synchronization_error';
    message: string;
    details?: { reasonCode?: string; candidateCount?: number };
  };
}

const INTEGRATION_AUDIT_META: AuditMeta = {
  ip: '0.0.0.0',
  userAgent: 'weavestream-worker/integration-reconstruction',
};

/**
 * Guarded-attempt budget for `writeFromIntegration` when a concurrent
 * operator write invalidates the observed asset snapshot. A retry
 * costs one re-read and re-merge; exhaustion is reported as a
 * `synchronization_error` gap so the next sync run tries again.
 */
const INTEGRATION_WRITE_MAX_ATTEMPTS = 3;

export interface AssetListOptions {
  layoutId?: string;
  q?: string;
  includeArchived?: boolean;
  /** Raw `field.<slug>=<value>` filters, parsed from `req.query`. */
  fieldFilters?: Record<string, string>;
  limit?: number;
  cursor?: string;
}

export interface ActorRef {
  id: string;
  name: string;
}

export interface SerializedAsset {
  id: string;
  companyId: string;
  assetLayoutId: string;
  layoutName: string;
  layoutSlug: string;
  layoutIcon: string;
  layoutColor: string;
  name: string;
  externalId: string | null;
  externalSource: string | null;
  archivedAt: Date | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdByUser: ActorRef | null;
  updatedByUser: ActorRef | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Phase 11 — sync provenance. Populated when an `IntegrationSyncRecord`
   * exists for this asset; null otherwise. The UI uses these fields to
   * render the subtle "synced from <driver>" indicators on lists, the
   * detail header, and the per-field labels in the edit form.
   */
  lastSyncedAt: Date | null;
  /**
   * Field ids the integration most recently wrote during a successful
   * sync. Drives the per-field label icon. Empty array when not synced.
   */
  syncedFieldIds: string[];
  /**
   * Phase 11.2 — every IntegrationSyncRecord currently linked to this
   * asset. An asset can be synced from many integrations at once (e.g.
   * Action1 endpoint + UniFi client representing the same physical
   * machine), so the UI surfaces all of them rather than just the
   * "primary" one stored on `Asset.externalSource`. Empty array when
   * the asset is unsynced.
   */
  syncSources: Array<{
    integrationId: string;
    integrationName: string;
    driver: string;
    resourceKey: string;
    lastSyncedAt: Date;
  }>;
  /** Safe, tenant-scoped reconstruction provenance for the exact native target. */
  provenance: IntegrationTargetProvenance[];
  fieldValues: Record<string, unknown>;
  fields: Array<{
    id: string;
    slug: string;
    name: string;
    fieldType: string;
    isPrimary: boolean;
    visibleToClients: boolean;
    options: Record<string, unknown>;
  }>;
  /**
   * Sidecar label map for ASSET_REFERENCE field values so the UI can
   * render the target asset's display name without a round trip. Keyed
   * by the referenced asset id. Missing entries indicate the reference
   * points at an asset the caller can't see (cross-tenant guard) or
   * that has been hard-deleted — renderers should fall back to the raw
   * uuid in that case.
   */
  references: Record<
    string,
    { id: string; name: string; archivedAt: Date | null }
  >;
  /**
   * True if the signed-in user has starred this asset.
   */
  isStarred: boolean;
}

type LayoutWithFields = AssetLayout & { fields: AssetField[] };

@Injectable()
export class AssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly registry: FieldTypesRegistry,
    private readonly relations: RelationsService,
    private readonly uploads: UploadsService,
    private readonly searchIndex: SearchIndexService,
    private readonly passwords: PasswordsService,
    private readonly stars: StarsService,
    private readonly tags: TagsService,
  ) {}

  // --------------------------------------------------------------------
  // Read
  // --------------------------------------------------------------------

  /**
   * List assets for a company with layout filter, name search, archive
   * filter, and `field.<slug>=<value>` filter DSL. Each `field.*` filter
   * is resolved against the layout's field definitions (filterable types
   * only — see `FILTERABLE_FIELD_TYPES`) and ANDed as separate nested
   * `fieldValues.some` predicates.
   */
  async list(
    actor: AuthedUser,
    companyId: string,
    options: AssetListOptions = {},
  ): Promise<{ items: SerializedAsset[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

    const where: Prisma.AssetWhereInput = { companyId };
    if (!options.includeArchived) where.archivedAt = null;
    if (options.layoutId) where.assetLayoutId = options.layoutId;
    if (options.q) {
      where.name = { contains: options.q, mode: 'insensitive' };
    }

    const filterClauses: Prisma.AssetWhereInput[] = [];
    const fieldFilters = options.fieldFilters ?? {};
    const filterSlugs = Object.keys(fieldFilters);

    if (filterSlugs.length > 0) {
      // Resolve slugs to field rows so the middle layer never has to do
      // its own string->id lookup.
      const layoutConstraint = options.layoutId
        ? { assetLayoutId: options.layoutId }
        : {};
      const fieldRows = await this.prisma.assetField.findMany({
        where: { ...layoutConstraint, slug: { in: filterSlugs }, archivedAt: null },
      });
      const fieldBySlug = new Map(fieldRows.map((f) => [f.slug, f]));

      for (const slug of filterSlugs) {
        const field = fieldBySlug.get(slug);
        if (!field) {
          throw new BadRequestException({
            error: 'UnknownFilterField',
            slug,
            message: `No field "${slug}" exists on the selected layout.`,
          });
        }
        if (!FILTERABLE_FIELD_TYPES.has(field.fieldType)) {
          throw new BadRequestException({
            error: 'UnfilterableField',
            slug,
            fieldType: field.fieldType,
            message: `Field "${slug}" (${field.fieldType}) is not filterable.`,
          });
        }

        const raw = fieldFilters[slug]!;
        const parsed = this.coerceFilterValue(field.fieldType, raw);

        filterClauses.push({
          fieldValues: {
            some: {
              assetFieldId: field.id,
              value: { equals: parsed as Prisma.InputJsonValue },
            },
          },
        });
      }
    }

    if (filterClauses.length > 0) {
      where.AND = filterClauses;
    }

    const items = await this.prisma.asset.findMany({
      where,
      orderBy: [{ archivedAt: 'asc' }, { name: 'asc' }],
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      include: {
        assetLayout: { include: { fields: { orderBy: { position: 'asc' } } } },
        fieldValues: true,
      },
    });
    const hasMore = items.length > limit;
    const slice = hasMore ? items.slice(0, limit) : items;

    const serialized = slice.map((a) =>
      this.serialize(a, a.assetLayout, a.fieldValues, actor.role),
    );
    await this.hydrateFileFields(companyId, serialized);
    await this.hydrateAssetReferences(companyId, serialized);
    await this.hydrateTagFields(serialized);
    await this.hydrateActors(serialized);
    await this.hydrateSyncMetadata(companyId, serialized);
    return {
      items: serialized,
      nextCursor: hasMore ? slice[slice.length - 1]!.id : null,
    };
  }

  /**
   * Returns a `{ layoutId -> count }` map of active (non-archived)
   * assets grouped by layout, scoped to a single company. Used by the
   * company-scoped sidebar to render `(n)` counts next to each layout
   * without issuing N separate `list` calls. Permission is enforced
   * at the controller via `asset.read` on the company — an empty map
   * is a perfectly valid answer (e.g. brand new company).
   */
  async countsByLayout(
    companyId: string,
  ): Promise<Record<string, number>> {
    const rows = await this.prisma.asset.groupBy({
      by: ['assetLayoutId'],
      where: { companyId, archivedAt: null },
      _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const r of rows) out[r.assetLayoutId] = r._count._all;
    return out;
  }

  async get(
    actor: AuthedUser,
    companyId: string,
    id: string,
  ): Promise<SerializedAsset> {
    const asset = await this.prisma.asset.findFirst({
      where: { id, companyId },
      include: {
        assetLayout: { include: { fields: { orderBy: { position: 'asc' } } } },
        fieldValues: true,
      },
    });
    if (!asset) throw new NotFoundException();
    const serialized = this.serialize(asset, asset.assetLayout, asset.fieldValues, actor.role);
    serialized.isStarred = await this.stars.isStarred(actor.id, 'asset', id);
    await this.hydrateFileFields(companyId, [serialized]);
    await this.hydrateAssetReferences(companyId, [serialized]);
    await this.hydrateTagFields([serialized]);
    await this.hydrateActors([serialized]);
    await this.hydrateSyncMetadata(companyId, [serialized]);
    serialized.provenance = await readTargetProvenance(this.prisma, {
      companyId,
      targetKind: 'asset',
      targetId: id,
    });
    return serialized;
  }

  // --------------------------------------------------------------------
  // Create / update
  // --------------------------------------------------------------------

  async create(
    actor: AuthedUser,
    companyId: string,
    input: CreateAssetInput,
    meta: AuditMeta,
  ): Promise<SerializedAsset> {
    const layout = await this.loadLayout(input.assetLayoutId);
    if (layout.archivedAt)
      throw new BadRequestException('Cannot create assets on an archived layout');

    const validated = this.validateValues(layout, input.fieldValues, actor.role, 'write');
    await this.assertUniqueValues(layout, companyId, validated, null);

    const primaryField = layout.fields.find((f) => f.isPrimary && f.archivedAt === null);
    const name = input.name?.trim() || this.derivePrimaryName(layout, primaryField, validated);

    if (input.externalId) {
      await this.assertExternalIdFree(companyId, input.externalId, input.externalSource ?? null, null);
    }

    const asset = await this.prisma.$transaction(async (tx) => {
      let created: Asset;
      try {
        created = await tx.asset.create({
          data: {
            companyId,
            assetLayoutId: layout.id,
            name,
            externalId: input.externalId ?? null,
            externalSource: input.externalSource ?? null,
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        });
      } catch (error) {
        // Backstop for the `assertExternalIdFree` pre-check above: the
        // 0062 partial identity indexes reject a concurrent claim of the
        // same external identity. Surface the same 409 as the pre-check
        // rather than a 500.
        if (input.externalId && isUniqueConstraintError(error)) {
          throw externalIdTakenConflict(input.externalId, input.externalSource ?? null);
        }
        throw error;
      }

      await this.persistFieldValues(
        tx,
        layout,
        created.id,
        companyId,
        validated,
        actor.id,
        meta,
      );
      await this.linkFileFieldUploadsToAsset(
        tx,
        companyId,
        created.id,
        layout,
        validated,
      );
      // Phase 6: rebuild search_index inside the same tx so the row
      // only becomes discoverable after its field values are visible
      // to the rest of the app.
      await this.searchIndex.upsertAsset(tx, created.id);

      return created;
    });

    await this.audit.log({
      actorId: actor.id,
      action: 'asset.create',
      entityType: 'Asset',
      entityId: asset.id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: {
        name: asset.name,
        assetLayoutId: layout.id,
        // Accepted plaintext copy (WS-004) — full field values incl. hidden
        // fields. Secondary store; see docs/security/data-retention.md.
        fieldValues: validated,
      },
    });
    return this.get(actor, companyId, asset.id);
  }

  async update(
    actor: AuthedUser,
    companyId: string,
    id: string,
    input: UpdateAssetInput,
    meta: AuditMeta,
  ): Promise<SerializedAsset> {
    const existing = await this.prisma.asset.findFirst({
      where: { id, companyId },
      include: {
        assetLayout: { include: { fields: { orderBy: { position: 'asc' } } } },
        fieldValues: true,
      },
    });
    if (!existing) throw new NotFoundException();
    if (existing.archivedAt)
      throw new BadRequestException('Cannot edit an archived asset — restore it first.');

    const layout = existing.assetLayout;
    const incoming = input.fieldValues ?? {};
    const validated = this.validateValues(layout, incoming, actor.role, 'update');

    await this.assertUniqueValues(layout, companyId, validated, id);

    // The identity pair this update would leave on the row. A
    // source-only change (external_source moves while external_id is
    // untouched) can collide just like an external_id change, so the
    // pre-check compares the resulting pair, not just the incoming id.
    const nextExternalId =
      input.externalId !== undefined ? input.externalId : existing.externalId;
    const nextExternalSource =
      input.externalSource !== undefined
        ? input.externalSource
        : existing.externalSource;
    if (
      nextExternalId !== null &&
      (input.externalId !== undefined || input.externalSource !== undefined)
    ) {
      await this.assertExternalIdFree(companyId, nextExternalId, nextExternalSource, id);
    }

    const primaryField = layout.fields.find((f) => f.isPrimary && f.archivedAt === null);
    const mergedForName: Record<string, unknown> = {
      ...this.currentValuesAsMap(layout, existing.fieldValues),
      ...validated,
    };
    const nextName =
      input.name?.trim() ||
      (primaryField && mergedForName[primaryField.slug] != null
        ? this.derivePrimaryName(layout, primaryField, mergedForName)
        : existing.name);

    const before = {
      name: existing.name,
      externalId: existing.externalId,
      externalSource: existing.externalSource,
      fieldValues: this.currentValuesAsMap(layout, existing.fieldValues),
    };

    await this.prisma.$transaction(async (tx) => {
      // `updateMany` lets us carry `companyId` in the `where` clause so
      // the tenant-scope middleware can verify the write is in-scope.
      // Plain `update` requires a unique `where`, which would only
      // contain `id` and therefore fail the "no companyId filter was
      // supplied" guard. The `{ id, companyId }` pair also defends
      // against a cross-tenant id collision (cheap belt-and-suspenders
      // on top of the `findFirst` pre-check above).
      try {
        await tx.asset.updateMany({
          where: { id, companyId },
          data: {
            name: nextName,
            ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
            ...(input.externalSource !== undefined
              ? { externalSource: input.externalSource }
              : {}),
            updatedBy: actor.id,
          },
        });
      } catch (error) {
        // Backstop for the `assertExternalIdFree` pre-check above — only
        // an update whose resulting identity pair is non-null can trip
        // the 0062 partial indexes.
        if (nextExternalId != null && isUniqueConstraintError(error)) {
          throw externalIdTakenConflict(nextExternalId, nextExternalSource);
        }
        throw error;
      }
      await this.persistFieldValues(tx, layout, id, companyId, validated, actor.id, meta);
      await this.linkFileFieldUploadsToAsset(tx, companyId, id, layout, validated);
      // Phase 6: rewrite the denormalised plaintext so the asset's
      // updated field values and name surface in the next search
      // query. Same-tx so a rollback cleans both sides up together.
      await this.searchIndex.upsertAsset(tx, id);
    });

    await this.audit.log({
      actorId: actor.id,
      action: 'asset.update',
      entityType: 'Asset',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before,
      after: {
        name: nextName,
        externalId: input.externalId ?? existing.externalId,
        externalSource:
          input.externalSource !== undefined
            ? input.externalSource
            : existing.externalSource,
        // Accepted plaintext copy (WS-004) — full field values incl. hidden
        // fields. Secondary store; see docs/security/data-retention.md.
        fieldValues: validated,
      },
    });

    return this.get(actor, companyId, id);
  }

  /**
   * Explicit non-request asset write used by reconstruction workers.
   * It shares layout/field validation and persistence with interactive
   * writes but receives a real audit actor and company scope directly.
   * Bound updates are optimistic: each attempt merges against the row
   * (and field values) it read and the UPDATE refuses (in its WHERE
   * clause) if the row moved, so a concurrent operator edit is never
   * overwritten or misclassified from a stale snapshot. External
   * identity is additionally backed by the 0062 partial unique indexes:
   * a create or identity adoption that races past `assertExternalIdFree`
   * surfaces as a retryable `external_identity_conflict` gap instead of
   * a duplicate row.
   */
  async writeFromIntegration(
    input: IntegrationAssetWriteInput,
  ): Promise<IntegrationAssetWriteResult> {
    const readClient = input.tx ?? this.prisma;
    await this.audit.assertIntegrationActor(input.auditActorId, input.companyId);
    const layout = await this.loadLayout(input.assetLayoutId, readClient);
    if (layout.archivedAt) {
      return integrationAssetBlocked(input.companyId, 'validation', 'The asset layout is archived.', 'layout_archived');
    }
    const fieldById = new Map(layout.fields.map((field) => [field.id, field]));
    if (
      input.matchKeyFieldIds.some((id) => !fieldById.has(id)) ||
      input.fieldValues.some((entry) => !fieldById.has(entry.targetFieldId))
    ) {
      return integrationAssetBlocked(input.companyId, 'validation', 'A configured asset field is not part of the target layout.', 'field_layout_mismatch');
    }

    const writableBySlug: Record<string, unknown> = {};
    const directionByFieldId = new Map<string, IntegrationAssetWriteInput['fieldValues'][number]>();
    for (const entry of input.fieldValues) {
      if (directionByFieldId.has(entry.targetFieldId)) {
        return integrationAssetBlocked(input.companyId, 'validation', 'An asset field is mapped more than once.', 'duplicate_target_field');
      }
      directionByFieldId.set(entry.targetFieldId, entry);
      if (entry.syncDirection !== 'manual_only') {
        writableBySlug[fieldById.get(entry.targetFieldId)!.slug] = entry.value;
      }
    }
    const normalizedForMatch = this.validateValues(
      layout,
      writableBySlug,
      'SUPER_ADMIN',
      'update',
    );

    for (let attempt = 0; attempt < INTEGRATION_WRITE_MAX_ATTEMPTS; attempt += 1) {
      let result: IntegrationAssetWriteResult | 'revision_conflict';
      try {
        result = await this.attemptIntegrationAssetWrite(input, {
          layout,
          fieldById,
          directionByFieldId,
          writableBySlug,
          normalizedForMatch,
        });
      } catch (error) {
        if (!(error instanceof AssetExternalIdentityConflictError)) throw error;
        const conflict = integrationIdentityConflictResult(input);
        // Terminal under a caller transaction (already aborted by the
        // unique violation — no further statements may run on it);
        // standalone attempts re-enter the loop against a fresh read.
        if (conflict !== 'revision_conflict') return conflict;
        continue;
      }
      if (result !== 'revision_conflict') return result;
    }
    return integrationAssetBlocked(
      input.companyId,
      'synchronization_error',
      'The asset was modified concurrently while reconstruction was writing it.',
      'target_revision_conflict',
      input.existingTargetId ?? '',
    );
  }

  /**
   * One guarded attempt of the integration asset write. The
   * `preserve_manual` checksum gate, the identity/restore diff, and the
   * per-field merge are computed from the `target` row (and its field
   * values) read here, and the UPDATE pins that observed snapshot
   * (`archivedAt`, `updatedAt`) in its WHERE clause.
   * `'revision_conflict'` reports a zero-row match — the asset changed
   * after the read (operator field edit, rename, archive, or restore) —
   * and `writeFromIntegration` retries from a fresh read. Identity
   * unique-violations (0062) throw `AssetExternalIdentityConflictError`
   * through the — now aborted — transaction; the attempt loop in
   * `writeFromIntegration` translates them per write mode.
   */
  private async attemptIntegrationAssetWrite(
    input: IntegrationAssetWriteInput,
    prepared: {
      layout: LayoutWithFields;
      fieldById: Map<string, AssetField>;
      directionByFieldId: Map<string, IntegrationAssetWriteInput['fieldValues'][number]>;
      writableBySlug: Record<string, unknown>;
      normalizedForMatch: Record<string, unknown>;
    },
  ): Promise<IntegrationAssetWriteResult | 'revision_conflict'> {
    const runTransaction = <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) =>
      input.tx ? callback(input.tx) : this.prisma.$transaction(callback);
    const readClient = input.tx ?? this.prisma;
    const { layout, fieldById, directionByFieldId, writableBySlug, normalizedForMatch } = prepared;
    const resolution = await this.resolveIntegrationAssetTarget(
      input,
      layout,
      normalizedForMatch,
      readClient,
    );
    if (resolution.ambiguous) {
      return integrationAssetBlocked(
        input.companyId,
        'ambiguous',
        'Multiple assets match the configured asset keys.',
        'ambiguous_match',
      );
    }
    const target = resolution.target;
    if (input.existingTargetId && !target) {
      return integrationAssetBlocked(
        input.companyId,
        'missing_dependency',
        'The bound asset no longer exists.',
        'target_not_found',
        input.existingTargetId,
      );
    }
    if (target?.companyId !== undefined && target.companyId !== input.companyId) {
      return { targetId: target.id, companyId: target.companyId, change: 'blocked' };
    }
    if (target && target.assetLayoutId !== input.assetLayoutId) {
      return integrationAssetBlocked(input.companyId, 'validation', 'The bound asset uses a different layout.', 'target_layout_mismatch', target.id);
    }

    const normalized = this.validateValues(
      layout,
      writableBySlug,
      'SUPER_ADMIN',
      target ? 'update' : 'write',
    );
    const fieldChecksums: Record<string, string> = {};
    const valuesToWrite: Record<string, unknown> = {};
    const existingValues = target
      ? this.currentValuesAsMap(layout, target.fieldValues)
      : {};
    for (const [fieldId, entry] of directionByFieldId) {
      const field = fieldById.get(fieldId)!;
      const stored = existingValues[field.slug];
      const storedChecksum = assetFieldChecksum(stored);
      if (entry.syncDirection === 'manual_only') continue;
      const previousChecksum = input.previousFieldChecksums[fieldId];
      if (
        entry.syncDirection === 'preserve_manual' &&
        stored !== null &&
        stored !== undefined &&
        previousChecksum !== undefined &&
        previousChecksum !== storedChecksum
      ) {
        // The recorded baseline stays the last integration-authored
        // checksum. Recording the manual value's checksum instead would
        // adopt the operator edit as "last synced", so the next run to
        // reach this path would see no edit and overwrite it —
        // preserve_manual retains the operator value until the operator
        // reverts the field to the last synced value themselves.
        fieldChecksums[fieldId] = previousChecksum;
        continue;
      }
      const value = normalized[field.slug];
      valuesToWrite[field.slug] = value;
      fieldChecksums[fieldId] = assetFieldChecksum(value);
    }
    await this.assertUniqueValues(
      layout,
      input.companyId,
      valuesToWrite,
      target?.id ?? null,
      readClient,
    );

    const legacyExternalSource = legacyIntegrationExternalSource(input);
    const sameIdentity =
      !target ||
      target.externalSource === null ||
      (target.externalId === input.externalId &&
        (target.externalSource === (input.externalSource ?? null) ||
          target.externalSource === legacyExternalSource));
    const identityChanged =
      !!target &&
      sameIdentity &&
      (target.name !== input.name ||
        target.externalId !== input.externalId ||
        target.externalSource !== (input.externalSource ?? null));
    const restored = target?.archivedAt != null;
    if (
      target &&
      sameIdentity &&
      (target.externalId !== input.externalId ||
        target.externalSource !== (input.externalSource ?? null))
    ) {
      await this.assertExternalIdFree(
        input.companyId,
        input.externalId,
        input.externalSource ?? null,
        target.id,
        readClient,
      );
    }
    // Classification must stay read-only until the optimistic guard has
    // matched. TAGS pre-resolution can create global Tag rows and audit
    // entries, so running the side-effecting canonicalizer before the guard
    // would commit orphan side effects when an attempt loses the race.
    const classificationValues =
      target || input.dryRun
        ? await this.canonicalizeFieldValuesForDryRun(
            layout,
            valuesToWrite,
            readClient,
          )
        : null;
    if (input.dryRun) {
      if (target && !(await this.hasEligibleAssetBinding(readClient, input, target.id))) {
        return integrationAssetBlocked(input.companyId, 'ambiguous', 'The existing asset is not owned by an eligible reconstruction binding.', 'manual_ownership', target.id);
      }
      const dryRunValues = classificationValues!;
      const fieldsChanged = Object.entries(dryRunValues).some(
        ([slug, value]) => assetFieldChecksum(existingValues[slug]) !== assetFieldChecksum(value),
      );
      this.updateIntegrationFieldChecksums(
        directionByFieldId,
        fieldById,
        valuesToWrite,
        dryRunValues,
        fieldChecksums,
      );
      return {
        targetId: target?.id ?? '',
        companyId: input.companyId,
        change: classifyIntegrationAssetChange({
          exists: !!target,
          restored,
          identityChanged,
          fieldsChanged,
        }),
        fieldChecksums,
      };
    }

    let change: IntegrationAssetWriteResult['change'];
    let targetId: string;
    if (!target) {
      await this.assertExternalIdFree(
        input.companyId,
        input.externalId,
        input.externalSource ?? null,
        null,
        readClient,
      );
      const created = await runTransaction(async (tx) => {
        const canonicalValues = await this.canonicalizeFieldValues(
          tx,
          layout,
          valuesToWrite,
          input.auditActorId,
          INTEGRATION_AUDIT_META,
        );
        let row: Asset;
        try {
          row = await tx.asset.create({
            data: {
              companyId: input.companyId,
              assetLayoutId: input.assetLayoutId,
              name: input.name,
              externalId: input.externalId,
              externalSource: input.externalSource ?? null,
              createdBy: input.auditActorId,
              updatedBy: input.auditActorId,
            },
          });
        } catch (error) {
          // The only unique constraints on `assets` are the uuid primary
          // key and the 0062 partial identity indexes, so a P2002 from
          // this statement is a lost identity race — not a tag or field
          // conflict from elsewhere in the transaction. Rethrown through
          // the (possibly caller-provided) transaction to the attempt
          // loop, which must not issue further statements on it.
          if (isUniqueConstraintError(error)) {
            throw new AssetExternalIdentityConflictError();
          }
          throw error;
        }
        await this.persistFieldValues(
          tx,
          layout,
          row.id,
          input.companyId,
          canonicalValues,
          input.auditActorId,
          INTEGRATION_AUDIT_META,
          true,
        );
        await this.linkFileFieldUploadsToAsset(tx, input.companyId, row.id, layout, canonicalValues);
        await this.searchIndex.upsertAsset(tx, row.id);
        await this.audit.logWithClient(tx, {
          actorId: input.auditActorId,
          action: 'integration.asset.created',
          entityType: 'Asset',
          entityId: row.id,
          companyId: input.companyId,
          ip: INTEGRATION_AUDIT_META.ip,
          userAgent: INTEGRATION_AUDIT_META.userAgent,
          after: { integrationId: input.integrationId, change: 'created' },
        });
        return { row, canonicalValues };
      });
      targetId = created.row.id;
      this.updateIntegrationFieldChecksums(
        directionByFieldId,
        fieldById,
        valuesToWrite,
        created.canonicalValues,
        fieldChecksums,
      );
      change = 'created';
    } else {
      targetId = target.id;
      const outcome = await runTransaction(async (tx) => {
        if (!(await this.hasEligibleAssetBinding(tx, input, target.id))) {
          return { status: 'blocked' as const };
        }
        let canonicalValues = classificationValues!;
        const fieldsChanged = Object.entries(canonicalValues).some(
          ([slug, value]) => assetFieldChecksum(existingValues[slug]) !== assetFieldChecksum(value),
        );
        const plannedChange = classifyIntegrationAssetChange({
          exists: true,
          restored,
          identityChanged,
          fieldsChanged,
        });
        if (plannedChange !== 'unchanged') {
          let guarded: Prisma.BatchPayload;
          try {
            guarded = await tx.asset.updateMany({
              where: {
                id: target!.id,
                companyId: input.companyId,
                // Optimistic-concurrency guard riding the WHERE clause —
                // the `update()` idiom. Asset has no `revision` column, so
                // the guard pins `updatedAt` (Prisma bumps it on every
                // client write, and interactive edits always touch the
                // asset row even for field-only saves) plus `archivedAt`
                // for the restore classification. Zero rows means the
                // `preserve_manual` checksum gate and the identity/field
                // diff above were derived from a stale snapshot; the
                // caller re-reads instead of overwriting a newer operator
                // edit.
                archivedAt: target!.archivedAt,
                updatedAt: target!.updatedAt,
              },
              data: {
                ...(restored ? { archivedAt: null } : {}),
                ...(sameIdentity
                  ? {
                      name: input.name,
                      externalId: input.externalId,
                      externalSource: input.externalSource ?? null,
                    }
                  : {}),
                updatedBy: input.auditActorId,
              },
            });
          } catch (error) {
            // A `sameIdentity` write may adopt an (externalId,
            // externalSource) pair another asset claimed after
            // `assertExternalIdFree` ran — the 0062 partial indexes
            // reject the stale adoption. Rethrown to the attempt loop;
            // the transaction is aborted and must not be reused.
            if (sameIdentity && isUniqueConstraintError(error)) {
              throw new AssetExternalIdentityConflictError();
            }
            throw error;
          }
          if (guarded.count === 0) {
            return { status: 'conflict' as const };
          }
          // Side-effecting field resolution is safe only after the guarded
          // row update succeeds. If this creates a global Tag, the tag, its
          // audit row, and the asset field write now share the successful
          // transaction outcome.
          canonicalValues = await this.canonicalizeFieldValues(
            tx,
            layout,
            valuesToWrite,
            input.auditActorId,
            INTEGRATION_AUDIT_META,
          );
          await this.persistFieldValues(
            tx,
            layout,
            target!.id,
            input.companyId,
            canonicalValues,
            input.auditActorId,
            INTEGRATION_AUDIT_META,
            true,
          );
          await this.linkFileFieldUploadsToAsset(tx, input.companyId, target!.id, layout, canonicalValues);
          await this.searchIndex.upsertAsset(tx, target!.id);
          await this.audit.logWithClient(tx, {
            actorId: input.auditActorId,
            action: 'integration.asset.updated',
            entityType: 'Asset',
            entityId: target!.id,
            companyId: input.companyId,
            ip: INTEGRATION_AUDIT_META.ip,
            userAgent: INTEGRATION_AUDIT_META.userAgent,
            after: { integrationId: input.integrationId, change: plannedChange },
          });
        }
        return { status: 'written' as const, change: plannedChange, canonicalValues };
      });
      if (outcome.status === 'blocked') {
        return integrationAssetBlocked(input.companyId, 'ambiguous', 'The existing asset is not owned by an eligible reconstruction binding.', 'manual_ownership', target.id);
      }
      if (outcome.status === 'conflict') {
        return 'revision_conflict';
      }
      this.updateIntegrationFieldChecksums(
        directionByFieldId,
        fieldById,
        valuesToWrite,
        outcome.canonicalValues,
        fieldChecksums,
      );
      change = outcome.change;
    }

    return { targetId, companyId: input.companyId, change, fieldChecksums };
  }

  private async hasEligibleAssetBinding(
    client: Parameters<typeof hasEligibleNativeBinding>[0],
    input: IntegrationAssetWriteInput,
    targetId: string,
  ): Promise<boolean> {
    const exact = await hasEligibleNativeBinding(client, {
      integrationCompanyMappingId: input.integrationCompanyMappingId,
      resourceId: input.resourceId,
      externalId: input.externalId,
      integrationId: input.integrationId,
      companyId: input.companyId,
      targetKind: 'asset',
      targetId,
    });
    if (exact || !input.ownershipBinding) return exact;
    return hasEligibleNativeBinding(client, {
      integrationCompanyMappingId: input.integrationCompanyMappingId,
      resourceId: input.ownershipBinding.resourceId,
      externalId: input.ownershipBinding.externalId,
      integrationId: input.integrationId,
      companyId: input.companyId,
      targetKind: 'asset',
      targetId,
    });
  }

  // --------------------------------------------------------------------
  // Archive / restore
  // --------------------------------------------------------------------

  async archive(
    actor: AuthedUser,
    companyId: string,
    id: string,
    meta: AuditMeta,
  ): Promise<SerializedAsset> {
    const existing = await this.prisma.asset.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundException();
    if (existing.archivedAt) throw new BadRequestException('Already archived');

    const archivedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.asset.updateMany({
        where: { id, companyId },
        data: { archivedAt, updatedBy: actor.id },
      });
      // Phase 6: mirror `archived_at` into `search_index` so the default
      // query filter (`archived_at IS NULL`) hides the row immediately.
      await this.searchIndex.upsertAsset(tx, id);
    });

    // Phase 10: cascade archive to embedded credentials. Runs outside
    // the asset transaction so a partial password write doesn't roll
    // back the asset archive — the cascade is purely additive (sets
    // `archivedAt` on passwords that were active) and is safe to retry.
    const cascade = await this.passwords.cascadeArchiveFromAsset(
      companyId,
      id,
      archivedAt,
    );

    await this.audit.log({
      actorId: actor.id,
      action: 'asset.archive',
      entityType: 'Asset',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { archivedAt: null },
      after: { archivedAt, cascadedPasswords: cascade.archived },
    });
    return this.get(actor, companyId, id);
  }

  async restore(
    actor: AuthedUser,
    companyId: string,
    id: string,
    meta: AuditMeta,
  ): Promise<SerializedAsset> {
    const existing = await this.prisma.asset.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundException();
    if (!existing.archivedAt) throw new BadRequestException('Not archived');

    await this.prisma.$transaction(async (tx) => {
      await tx.asset.updateMany({
        where: { id, companyId },
        data: { archivedAt: null, updatedBy: actor.id },
      });
      await this.searchIndex.upsertAsset(tx, id);
    });

    // Phase 10: mirror the restore onto embedded credentials the asset
    // cascade previously archived. Only archived rows flip — any
    // password that was archived on its own remains archived.
    const cascade = await this.passwords.cascadeRestoreFromAsset(companyId, id);

    await this.audit.log({
      actorId: actor.id,
      action: 'asset.restore',
      entityType: 'Asset',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { archivedAt: existing.archivedAt },
      after: { archivedAt: null, cascadedPasswords: cascade.restored },
    });
    return this.get(actor, companyId, id);
  }

  /**
   * Hard-deletes an asset row. Required so operators can expunge
   * duplicates created by integration matching mistakes — archive
   * alone is insufficient because a sync run will keep refreshing the
   * archived shell as long as its IntegrationSyncRecord still resolves
   * to it on the next pass.
   *
   * Guarded:
   *   - The asset must already be archived. The two-step
   *     archive → purge gate forces the operator to look at the row
   *     once more (and lets the UI surface a Restore escape hatch up
   *     until the purge confirmation).
   *   - Caller must hold `asset.purge` (FULL access).
   *
   * Cascade:
   *   - `AssetFieldValue`, `IntegrationSyncRecord`, `StarredAsset`
   *     drop with the row (FK ON DELETE CASCADE).
   *   - `Password.assetId` is SET NULL (credentials survive the asset
   *     so the operator can re-link them).
   *   - `Relation` is polymorphic (no FK) → cleaned manually here.
   *   - `SearchIndex` is denormalised (no FK) → cleaned manually.
   *
   * After deletion the next integration sync that *would* have
   * landed on this row falls through to a fresh `create` (or matches
   * a different existing asset via the configured match keys).
   */
  async purge(
    actor: AuthedUser,
    companyId: string,
    id: string,
    meta: AuditMeta,
  ): Promise<{ id: string }> {
    const existing = await this.prisma.asset.findFirst({
      where: { id, companyId },
      select: {
        id: true,
        name: true,
        assetLayoutId: true,
        archivedAt: true,
        externalId: true,
        externalSource: true,
      },
    });
    if (!existing) throw new NotFoundException();
    // Archive-first is a server-side invariant for every purge path,
    // single and bulk alike (WS-015). Client confirmation dialogs are UX,
    // not a security control.
    if (!existing.archivedAt) {
      throw new BadRequestException(
        'Archive the asset before permanently deleting it.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await this.relations.cleanupForAsset({ tx, companyId, assetId: id });
      await this.searchIndex.removeAsset(tx, id);
      // `archivedAt: { not: null }` re-asserts the archive-first invariant
      // at the delete statement itself, closing the read→delete window in
      // which a concurrent restore could reactivate the asset.
      const result = await tx.asset.deleteMany({
        where: { id, companyId, archivedAt: { not: null } },
      });
      if (result.count === 0) {
        // Nothing matched the guarded predicate: either a concurrent
        // request already purged the row (gone → 404) or a concurrent
        // restore cleared `archivedAt` (still present → archive gate, so
        // bulk callers classify it `not_archived`). Distinguish the two
        // so API clients and bulk retry UX see the right failure.
        const still = await tx.asset.findFirst({
          where: { id, companyId },
          select: { id: true },
        });
        if (!still) throw new NotFoundException();
        throw new BadRequestException(
          'Archive the asset before permanently deleting it.',
        );
      }
    });

    await this.audit.log({
      actorId: actor.id,
      action: 'asset.purge',
      entityType: 'Asset',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: {
        name: existing.name,
        assetLayoutId: existing.assetLayoutId,
        archivedAt: existing.archivedAt,
        externalId: existing.externalId,
        externalSource: existing.externalSource,
      },
      after: null,
    });

    return { id };
  }

  // --------------------------------------------------------------------
  // Bulk archive / restore / purge
  // --------------------------------------------------------------------

  /**
   * Bulk-archive assets. Iterates the input ids and reuses the per-item
   * `archive` path so that side-effects (search index, password cascade,
   * audit log) stay identical to single-item operations. Each id succeeds
   * or fails independently — no transaction across the batch — and the
   * caller receives a structured `{ ok, failed }` report so the UI can
   * surface partial successes.
   *
   * Already-archived ids are reported as `code: "already_archived"`
   * failures rather than throwing; the bulk caller usually has a mixed
   * selection and treating "no-op" as a soft failure is the most useful
   * UX (lets us count "8 archived, 2 already archived").
   */
  async archiveMany(
    actor: AuthedUser,
    companyId: string,
    ids: string[],
    meta: AuditMeta,
  ): Promise<BulkAssetResult> {
    return this.runBulk(ids, (id) => this.archive(actor, companyId, id, meta));
  }

  async restoreMany(
    actor: AuthedUser,
    companyId: string,
    ids: string[],
    meta: AuditMeta,
  ): Promise<BulkAssetResult> {
    return this.runBulk(ids, (id) => this.restore(actor, companyId, id, meta));
  }

  /**
   * Bulk-purge. Enforces the same per-item "archive first" safety as the
   * single-item path (WS-015) — permanent deletion must never rely on a
   * client-side confirmation dialog. Ids that are still active are
   * reported as `code: "not_archived"` soft failures rather than
   * throwing, so the caller sees "8 deleted, 2 not archived" and can
   * archive the rest before retrying.
   */
  async purgeMany(
    actor: AuthedUser,
    companyId: string,
    ids: string[],
    meta: AuditMeta,
  ): Promise<BulkAssetResult> {
    return this.runBulk(ids, (id) => this.purge(actor, companyId, id, meta));
  }

  /**
   * Internal helper: dedupe ids, run `op(id)` per item, and bucket the
   * results into `{ ok, failed }`. Errors are converted to a stable
   * `{ code, reason }` shape so the client can branch on the outcome
   * (e.g. show "X were already archived" vs a generic failure).
   */
  private async runBulk(
    ids: string[],
    op: (id: string) => Promise<unknown>,
  ): Promise<BulkAssetResult> {
    const ok: string[] = [];
    const failed: BulkAssetResult['failed'] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        await op(id);
        ok.push(id);
      } catch (err) {
        failed.push({ id, ...classifyBulkError(err) });
      }
    }
    return { ok, failed };
  }

  // --------------------------------------------------------------------
  // Validation + persistence
  // --------------------------------------------------------------------

  private async resolveIntegrationAssetTarget(
    input: IntegrationAssetWriteInput,
    layout: LayoutWithFields,
    values: Record<string, unknown>,
    client: Pick<Prisma.TransactionClient, 'asset' | 'integrationSyncRecord'> | PrismaService = this.prisma,
  ): Promise<{
    target: (Asset & { fieldValues: AssetFieldValue[] }) | null;
    ambiguous: boolean;
  }> {
    const byId = async (id: string) =>
      client.asset.findUnique({ where: { id }, include: { fieldValues: true } });

    if (input.existingTargetId) {
      return { target: await byId(input.existingTargetId), ambiguous: false };
    }

    const bound = await client.integrationSyncRecord.findUnique({
      where: {
        integrationCompanyMappingId_resourceId_externalId: {
          integrationCompanyMappingId: input.integrationCompanyMappingId,
          resourceId: input.resourceId,
          externalId: input.externalId,
        },
      },
      select: { assetId: true },
    });
    if (bound?.assetId) {
      return { target: await byId(bound.assetId), ambiguous: false };
    }

    if (input.externalSource) {
      const identity = await client.asset.findFirst({
        where: {
          companyId: input.companyId,
          externalSource: input.externalSource,
          externalId: input.externalId,
          archivedAt: null,
        },
        include: { fieldValues: true },
      });
      if (identity) return { target: identity, ambiguous: false };
    }

    if (input.matchKeyFieldIds.length === 0) return { target: null, ambiguous: false };
    const clauses: Prisma.AssetWhereInput[] = [];
    for (const fieldId of input.matchKeyFieldIds) {
      const field = layout.fields.find((candidate) => candidate.id === fieldId);
      const value = field ? values[field.slug] : undefined;
      if (!field || value === null || value === undefined || value === '') {
        return { target: null, ambiguous: false };
      }
      clauses.push({
        fieldValues: {
          some: {
            companyId: input.companyId,
            assetFieldId: fieldId,
            OR: expandMatchValueVariants(field.fieldType, value).map((variant) => ({
              value: { equals: variant as Prisma.InputJsonValue },
            })),
          },
        },
      });
    }
    const candidates = await client.asset.findMany({
      where: {
        companyId: input.companyId,
        assetLayoutId: input.assetLayoutId,
        archivedAt: null,
        AND: clauses,
        integrationSyncRecords: {
          none: {
            integrationCompanyMappingId: input.integrationCompanyMappingId,
            resourceId: input.resourceId,
          },
        },
      },
      include: { fieldValues: true },
      take: 2,
    });
    const compatible = candidates.filter(
      (candidate) =>
        candidate.externalSource !== null &&
        candidate.externalSource === (input.externalSource ?? null) &&
        candidate.externalId === input.externalId,
    );
    return {
      target: compatible.length === 1 ? compatible[0]! : null,
      ambiguous: candidates.length > 1,
    };
  }

  private async loadLayout(
    layoutId: string,
    client: Pick<Prisma.TransactionClient, 'assetLayout'> | PrismaService = this.prisma,
  ): Promise<LayoutWithFields> {
    const layout = await client.assetLayout.findUnique({
      where: { id: layoutId },
      include: { fields: { orderBy: { position: 'asc' } } },
    });
    if (!layout) throw new NotFoundException(`Layout ${layoutId} not found`);
    return layout;
  }

  private validateValues(
    layout: LayoutWithFields,
    incoming: Record<string, unknown>,
    role: UserRole,
    mode: 'write' | 'update',
  ): Record<string, unknown> {
    // CLIENT_* must not write to invisible fields — reject as unknown slug.
    if (role === 'CLIENT_USER') {
      for (const slug of Object.keys(incoming)) {
        const field = layout.fields.find((f) => f.slug === slug && f.archivedAt === null);
        if (!field) continue;
        if (!field.visibleToClients) {
          throw new ForbiddenException({
            error: 'ClientVisibilityViolation',
            slug,
            message: `Field "${slug}" is not writable by client users.`,
          });
        }
      }
    }

    const schema = buildAssetZodSchema(layout.fields, this.registry, { mode, role });
    const parsed = schema.safeParse(incoming);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'ValidationError',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    const normalized: Record<string, unknown> = {};
    for (const [slug, value] of Object.entries(parsed.data as Record<string, unknown>)) {
      const field = layout.fields.find((f) => f.slug === slug && f.archivedAt === null);
      if (!field) continue;
      if (value === null || value === undefined) {
        normalized[slug] = null;
        continue;
      }
      const strategy = this.registry.get(field.fieldType);
      // Strategies with `preResolve` (currently TAGS) do their canonicalisation
      // inside the asset-write transaction in `persistFieldValues`, where they
      // can upsert global rows alongside the asset write. Skip the sync
      // `normalize` here and pass the validated wire shape through; the tx
      // step will run preResolve + normalize before upsert.
      if (strategy.preResolve) {
        normalized[slug] = value;
        continue;
      }
      normalized[slug] = strategy.normalize(value, (field.options ?? {}) as Record<string, unknown>);
    }
    return normalized;
  }

  private async assertUniqueValues(
    layout: LayoutWithFields,
    companyId: string,
    values: Record<string, unknown>,
    excludeAssetId: string | null,
    client: Pick<Prisma.TransactionClient, 'assetFieldValue'> | PrismaService = this.prisma,
  ): Promise<void> {
    for (const field of layout.fields) {
      if (field.archivedAt !== null) continue;
      if (!field.isUniquePerCompany) continue;
      const value = values[field.slug];
      if (value === null || value === undefined || value === '') continue;

      const clash = await client.assetFieldValue.findFirst({
        where: {
          companyId,
          assetFieldId: field.id,
          value: { equals: value as Prisma.InputJsonValue },
          asset: {
            archivedAt: null,
            ...(excludeAssetId ? { NOT: { id: excludeAssetId } } : {}),
          },
        },
        select: { asset: { select: { id: true, name: true } } },
      });
      if (clash) {
        throw new ConflictException({
          error: 'UniqueFieldViolation',
          slug: field.slug,
          conflictingAssetId: clash.asset.id,
          conflictingAssetName: clash.asset.name,
          message: `Field "${field.slug}" must be unique within the company.`,
        });
      }
    }
  }

  private async assertExternalIdFree(
    companyId: string,
    externalId: string,
    externalSource: string | null,
    excludeAssetId: string | null,
    client: Pick<Prisma.TransactionClient, 'asset'> | PrismaService = this.prisma,
  ): Promise<void> {
    const clash = await client.asset.findFirst({
      where: {
        companyId,
        externalId,
        externalSource,
        ...(excludeAssetId ? { NOT: { id: excludeAssetId } } : {}),
      },
      select: { id: true },
    });
    if (clash) {
      throw externalIdTakenConflict(externalId, externalSource);
    }
  }

  private derivePrimaryName(
    layout: LayoutWithFields,
    primary: AssetField | undefined,
    values: Record<string, unknown>,
  ): string {
    const v = primary ? values[primary.slug] : undefined;
    if (v === null || v === undefined) return `Untitled ${layout.name}`;
    if (typeof v === 'string') return v.slice(0, 200);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return `Untitled ${layout.name}`;
  }

  private currentValuesAsMap(
    layout: LayoutWithFields,
    rows: AssetFieldValue[],
  ): Record<string, unknown> {
    const bySlug: Record<string, unknown> = {};
    const fieldById = new Map(layout.fields.map((f) => [f.id, f]));
    for (const row of rows) {
      const field = fieldById.get(row.assetFieldId);
      if (!field) continue;
      bySlug[field.slug] = row.value;
    }
    return bySlug;
  }

  private updateIntegrationFieldChecksums(
    directionByFieldId: Map<string, IntegrationAssetWriteInput['fieldValues'][number]>,
    fieldById: Map<string, AssetField>,
    requestedValues: Record<string, unknown>,
    canonicalValues: Record<string, unknown>,
    checksums: Record<string, string>,
  ): void {
    for (const [fieldId] of directionByFieldId) {
      const field = fieldById.get(fieldId);
      if (!field || !Object.prototype.hasOwnProperty.call(requestedValues, field.slug)) continue;
      checksums[fieldId] = assetFieldChecksum(canonicalValues[field.slug]);
    }
  }

  private async canonicalizeFieldValues(
    tx: Prisma.TransactionClient,
    layout: LayoutWithFields,
    values: Record<string, unknown>,
    actorId: string | null,
    meta: AuditMeta | null,
  ): Promise<Record<string, unknown>> {
    const canonical: Record<string, unknown> = {};
    for (const [slug, rawValue] of Object.entries(values)) {
      const field = layout.fields.find((candidate) => candidate.slug === slug && candidate.archivedAt === null);
      if (!field || rawValue === null || rawValue === undefined) {
        canonical[slug] = rawValue;
        continue;
      }
      const strategy = this.registry.get(field.fieldType);
      const options = (field.options ?? {}) as Record<string, unknown>;
      let value: unknown = rawValue;
      if (strategy.preResolve) {
        value = await strategy.preResolve(value, options, {
          tx,
          tags: this.tags,
          actorId,
          audit: meta
            ? { actorId, ip: meta.ip, userAgent: meta.userAgent }
            : null,
        });
        if (value !== null && value !== undefined) {
          value = strategy.normalize(value, options);
        }
      }
      canonical[slug] = value;
    }
    return canonical;
  }

  private async canonicalizeFieldValuesForDryRun(
    layout: LayoutWithFields,
    values: Record<string, unknown>,
    client: Pick<Prisma.TransactionClient, 'tag'> | PrismaService = this.prisma,
  ): Promise<Record<string, unknown>> {
    const canonical: Record<string, unknown> = {};
    for (const [slug, rawValue] of Object.entries(values)) {
      const field = layout.fields.find((candidate) => candidate.slug === slug && candidate.archivedAt === null);
      if (!field || rawValue === null || rawValue === undefined) {
        canonical[slug] = rawValue;
        continue;
      }
      const strategy = this.registry.get(field.fieldType);
      if (!strategy.preResolve) {
        canonical[slug] = rawValue;
        continue;
      }
      if (field.fieldType !== 'TAGS' || !Array.isArray(rawValue)) {
        canonical[slug] = rawValue;
        continue;
      }
      const names = rawValue
        .filter((entry): entry is { name: string } =>
          !!entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string',
        )
        .map((entry) => entry.name.trim().toLowerCase());
      const rows = names.length === 0
        ? []
        : await client.tag.findMany({
            where: { nameLower: { in: Array.from(new Set(names)) } },
            select: { id: true, nameLower: true },
          });
      const byName = new Map(rows.map((row) => [row.nameLower, row.id]));
      const resolved = rawValue.map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
          const name = (entry as { name: string }).name.trim().toLowerCase();
          return byName.get(name) ?? `pending-tag:${name}`;
        }
        return entry;
      });
      canonical[slug] = strategy.normalize(resolved, (field.options ?? {}) as Record<string, unknown>);
    }
    return canonical;
  }

  /**
   * Upsert / delete AssetFieldValue rows, then call per-field onRelate
   * hooks (ASSET_REFERENCE → Relation sync) inside the same transaction.
   * `values` is keyed by slug; missing slugs are left alone on update,
   * `null` writes remove the stored row.
   */
  private async persistFieldValues(
    tx: Prisma.TransactionClient,
    layout: LayoutWithFields,
    assetId: string,
    companyId: string,
    values: Record<string, unknown>,
    actorId: string | null,
    meta: AuditMeta | null,
    preResolved = false,
  ): Promise<void> {
    const canonical = preResolved
      ? values
      : await this.canonicalizeFieldValues(tx, layout, values, actorId, meta);
    for (const [slug, value] of Object.entries(canonical)) {
      const field = layout.fields.find((f) => f.slug === slug && f.archivedAt === null);
      if (!field) continue;

      const strategy = this.registry.get(field.fieldType);
      const options = (field.options ?? {}) as Record<string, unknown>;

      if (value === null || value === undefined) {
        await tx.assetFieldValue.deleteMany({
          where: { companyId, assetId, assetFieldId: field.id },
        });
      } else {
        // `companyId` is denormalized from the parent Asset so the tenant
        // middleware can enforce scope on an upsert keyed by the
        // (assetId, assetFieldId) composite — neither `where` nor the
        // composite can carry a relational filter.
        await tx.assetFieldValue.upsert({
          where: { assetId_assetFieldId: { assetId, assetFieldId: field.id } },
          create: {
            companyId,
            assetId,
            assetFieldId: field.id,
            value: value as Prisma.InputJsonValue,
          },
          update: { companyId, value: value as Prisma.InputJsonValue },
        });
      }

      if (strategy.onRelate) {
        await strategy.onRelate(value, {
          companyId,
          assetId,
          field: {
            id: field.id,
            slug: field.slug,
            options,
          },
          actorId,
          tx,
          relations: this.relations,
        });
      }
    }
  }

  /**
   * Backfill `Upload.attachedToId` for FILE-field uploads that were
   * confirmed before the owning asset existed.
   *
   * The dropzone on the new-asset form (see `asset-form.tsx`) has no
   * `assetId` yet, so it calls `upload.init` with
   * `{ type: 'asset' }` and no id. Once the asset save lands, the
   * upload id ends up inside `asset_field_values.value` but the
   * `Upload` row's `attachedToId` is still null — which means the
   * photos gallery's `resolveSourceLink` can't build an Open link
   * back to the asset.
   *
   * This step runs in the same Prisma transaction as the asset write
   * so a rollback cleans both sides up together. The `where` clause
   * pins `companyId` so we never patch a cross-tenant row, and pins
   * `attachedToId: null` so we never reattach an upload that already
   * belongs to a different asset (single-ownership wins on first
   * write).
   */
  private async linkFileFieldUploadsToAsset(
    tx: Prisma.TransactionClient,
    companyId: string,
    assetId: string,
    layout: LayoutWithFields,
    values: Record<string, unknown>,
  ): Promise<void> {
    const ids = new Set<string>();
    for (const field of layout.fields) {
      if (field.fieldType !== 'FILE') continue;
      const value = values[field.slug];
      if (!Array.isArray(value)) continue;
      for (const entry of value as FileFieldEntry[]) {
        if (entry && typeof entry === 'object' && entry.uploadId) {
          ids.add(entry.uploadId);
        }
      }
    }
    if (ids.size === 0) return;
    await tx.upload.updateMany({
      where: {
        id: { in: Array.from(ids) },
        companyId,
        attachedToType: 'asset',
        attachedToId: null,
        deletedAt: null,
      },
      data: { attachedToId: assetId },
    });
  }

  private coerceFilterValue(fieldType: string, raw: string): unknown {
    switch (fieldType) {
      case 'NUMBER': {
        const n = Number(raw);
        if (Number.isNaN(n)) {
          throw new BadRequestException({
            error: 'InvalidFilterValue',
            fieldType,
            message: `"${raw}" is not a valid number.`,
          });
        }
        return n;
      }
      case 'BOOLEAN':
        if (raw === 'true') return true;
        if (raw === 'false') return false;
        throw new BadRequestException({
          error: 'InvalidFilterValue',
          fieldType,
          message: `Boolean filters accept "true" or "false".`,
        });
      case 'EMAIL':
        return raw.trim().toLowerCase();
      default:
        return raw;
    }
  }

  // --------------------------------------------------------------------
  // Serialization
  // --------------------------------------------------------------------

  /**
   * Replace every FILE field's raw entries with hydrated entries that
   * include same-origin API `thumbnailUrl` and `downloadUrl`. Batched
   * in a single `uploads` query per call so listing N assets with
   * FILE fields is one SELECT, not N. Mutates `assets` in place.
   */
  private async hydrateFileFields(
    companyId: string,
    assets: SerializedAsset[],
  ): Promise<void> {
    type Slot = { asset: SerializedAsset; slug: string; entries: FileFieldEntry[] };
    const slots: Slot[] = [];
    for (const asset of assets) {
      for (const f of asset.fields) {
        if (f.fieldType !== 'FILE') continue;
        const value = asset.fieldValues[f.slug];
        if (!Array.isArray(value) || value.length === 0) continue;
        slots.push({ asset, slug: f.slug, entries: value as FileFieldEntry[] });
      }
    }
    if (slots.length === 0) return;

    const allEntries = slots.flatMap((s) => s.entries);
    const hydrated = await this.uploads.hydrateFileFieldEntries(companyId, allEntries);
    let cursor = 0;
    for (const slot of slots) {
      const take = slot.entries.length;
      slot.asset.fieldValues[slot.slug] = hydrated.slice(cursor, cursor + take);
      cursor += take;
    }
  }

  /**
   * Resolve every ASSET_REFERENCE value into a `{ id, name, archivedAt }`
   * entry on each asset's `references` sidecar. One batched `IN (...)`
   * query per call regardless of how many rows are being serialized.
   * Scoped to the calling company so stale or cross-tenant ids silently
   * drop out of the map — the frontend is expected to fall back to the
   * raw uuid in that case so broken data is visible rather than hidden.
   */
  private async hydrateAssetReferences(
    companyId: string,
    assets: SerializedAsset[],
  ): Promise<void> {
    const ids = new Set<string>();
    for (const asset of assets) {
      for (const f of asset.fields) {
        if (f.fieldType !== 'ASSET_REFERENCE') continue;
        const value = asset.fieldValues[f.slug];
        const list = Array.isArray(value) ? value : value != null ? [value] : [];
        for (const v of list) {
          if (typeof v === 'string' && v.length > 0) ids.add(v);
        }
      }
    }
    if (ids.size === 0) return;

    const rows = await this.prisma.asset.findMany({
      where: { companyId, id: { in: Array.from(ids) } },
      select: { id: true, name: true, archivedAt: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const asset of assets) {
      for (const f of asset.fields) {
        if (f.fieldType !== 'ASSET_REFERENCE') continue;
        const value = asset.fieldValues[f.slug];
        const list = Array.isArray(value) ? value : value != null ? [value] : [];
        for (const v of list) {
          if (typeof v !== 'string' || v.length === 0) continue;
          const hit = byId.get(v);
          if (hit) asset.references[v] = hit;
        }
      }
    }
  }

  /**
   * Resolve every TAGS UUID into a `{ id, name }` snapshot so the form can
   * render a chip with the canonical display name without holding a tag
   * cache. One batched `IN (...)` lookup covers any number of assets.
   * Dangling ids (tag was deleted) silently drop out — the read-side
   * dereferencing is what makes hard-deletes safe even though the JSON
   * arrays in `AssetFieldValue.value` are never rewritten.
   */
  private async hydrateTagFields(assets: SerializedAsset[]): Promise<void> {
    const ids = new Set<string>();
    for (const asset of assets) {
      for (const f of asset.fields) {
        if (f.fieldType !== 'TAGS') continue;
        const value = asset.fieldValues[f.slug];
        if (!Array.isArray(value)) continue;
        for (const v of value) {
          if (typeof v === 'string' && v.length > 0) ids.add(v);
        }
      }
    }
    if (ids.size === 0) return;

    const tagsById = await this.tags.getMany(Array.from(ids));
    for (const asset of assets) {
      for (const f of asset.fields) {
        if (f.fieldType !== 'TAGS') continue;
        const value = asset.fieldValues[f.slug];
        if (!Array.isArray(value)) continue;
        const hydrated: Array<{ id: string; name: string }> = [];
        for (const v of value) {
          if (typeof v !== 'string' || v.length === 0) continue;
          const tag = tagsById.get(v);
          if (tag) hydrated.push({ id: tag.id, name: tag.name });
        }
        asset.fieldValues[f.slug] = hydrated;
      }
    }
  }

  /**
   * Phase 11 — populate `lastSyncedAt` + `syncedFieldIds` from the
   * matching `IntegrationSyncRecord` rows. `Asset.externalSource` and
   * `Asset.externalId` already ride on the row itself; this hydrator
   * supplies the bookkeeping that drives the per-asset / per-field
   * "synced" indicators in the UI without exposing checksums or run
   * ids that operators don't need.
   *
   * Phase 11.2 — an asset can be linked to multiple integrations
   * simultaneously. For each asset we pick the MOST RECENT sync
   * record's `lastSyncedAt` and union every record's per-field
   * checksum keys, so the UI's "synced" badge accurately reflects
   * every field touched by any active integration.
   */
  private async hydrateSyncMetadata(
    companyId: string,
    assets: SerializedAsset[],
  ): Promise<void> {
    if (assets.length === 0) return;
    // Probe every asset, not just rows whose `externalSource` is set.
    // A multi-owned asset only carries the *primary* integration on
    // its denormalised columns; the second / third owners live purely
    // as IntegrationSyncRecord rows and would otherwise be invisible
    // to the UI (which is what surfaced the "shows action1 only when
    // unifi also owns it" bug).
    const ids = assets.map((a) => a.id);
    const rows = await this.prisma.integrationSyncRecord.findMany({
      where: { companyId, assetId: { in: ids } },
      select: {
        assetId: true,
        lastSyncedAt: true,
        lastSyncedFieldChecksums: true,
        resource: { select: { resourceKey: true } },
        companyMapping: {
          select: {
            integration: {
              select: { id: true, driver: true, name: true },
            },
          },
        },
      },
      orderBy: { lastSyncedAt: 'desc' },
    });
    const aggregated = new Map<
      string,
      {
        lastSyncedAt: Date;
        syncedFieldIds: Set<string>;
        syncSources: SerializedAsset['syncSources'];
      }
    >();
    for (const r of rows) {
      if (!r.assetId) continue;
      const checksums = (r.lastSyncedFieldChecksums ?? {}) as Record<
        string,
        unknown
      >;
      const source = {
        integrationId: r.companyMapping.integration.id,
        integrationName: r.companyMapping.integration.name,
        driver: r.companyMapping.integration.driver,
        resourceKey: r.resource.resourceKey,
        lastSyncedAt: r.lastSyncedAt,
      };
      const entry = aggregated.get(r.assetId);
      if (!entry) {
        aggregated.set(r.assetId, {
          lastSyncedAt: r.lastSyncedAt,
          syncedFieldIds: new Set(Object.keys(checksums)),
          syncSources: [source],
        });
      } else {
        if (r.lastSyncedAt > entry.lastSyncedAt) {
          entry.lastSyncedAt = r.lastSyncedAt;
        }
        for (const k of Object.keys(checksums)) entry.syncedFieldIds.add(k);
        entry.syncSources.push(source);
      }
    }
    for (const a of assets) {
      const entry = aggregated.get(a.id);
      if (!entry) continue;
      a.lastSyncedAt = entry.lastSyncedAt;
      a.syncedFieldIds = Array.from(entry.syncedFieldIds);
      a.syncSources = entry.syncSources;
    }
  }

  /**
   * Resolve `createdBy` / `updatedBy` user ids into `{ id, name }` stubs
   * so the UI can render "updated by Jane" without the caller having to
   * hold `membership.manage`. This is a post-pass over already-serialized
   * rows so the sync `serialize()` path stays simple; one Prisma query
   * covers any number of assets in a list.
   */
  private async hydrateActors(assets: SerializedAsset[]): Promise<void> {
    if (assets.length === 0) return;
    const ids = new Set<string>();
    for (const a of assets) {
      if (a.createdBy) ids.add(a.createdBy);
      if (a.updatedBy) ids.add(a.updatedBy);
    }
    if (ids.size === 0) return;
    const users = await this.prisma.user.findMany({
      where: { id: { in: Array.from(ids) } },
      select: { id: true, name: true, email: true },
    });
    const byId = new Map(
      users.map((u) => [u.id, { id: u.id, name: u.name || u.email }] as const),
    );
    for (const a of assets) {
      if (a.createdBy) a.createdByUser = byId.get(a.createdBy) ?? null;
      if (a.updatedBy) a.updatedByUser = byId.get(a.updatedBy) ?? null;
    }
  }

  private serialize(
    asset: Asset,
    layout: LayoutWithFields,
    rows: AssetFieldValue[],
    role: UserRole,
  ): SerializedAsset {
    const visibleFields = layout.fields.filter(
      (f) => f.archivedAt === null && (role !== 'CLIENT_USER' || f.visibleToClients),
    );
    const fieldById = new Map(visibleFields.map((f) => [f.id, f]));
    const fieldValues: Record<string, unknown> = {};
    for (const row of rows) {
      const field = fieldById.get(row.assetFieldId);
      if (!field) continue;
      fieldValues[field.slug] = row.value;
    }
    return {
      id: asset.id,
      companyId: asset.companyId,
      assetLayoutId: asset.assetLayoutId,
      layoutName: layout.name,
      layoutSlug: layout.slug,
      layoutIcon: layout.icon,
      layoutColor: layout.color,
      name: asset.name,
      externalId: asset.externalId,
      externalSource: asset.externalSource,
      archivedAt: asset.archivedAt,
      createdBy: asset.createdBy,
      updatedBy: asset.updatedBy,
      createdByUser: null,
      updatedByUser: null,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
      lastSyncedAt: null,
      syncedFieldIds: [],
      syncSources: [],
      provenance: [],
      fieldValues,
      fields: visibleFields
        .sort((a, b) => a.position - b.position)
        .map((f) => ({
          id: f.id,
          slug: f.slug,
          name: f.name,
          fieldType: f.fieldType,
          isPrimary: f.isPrimary,
          visibleToClients: f.visibleToClients,
          options: (f.options ?? {}) as Record<string, unknown>,
        })),
      references: {},
      isStarred: false, // populated separately for detail
    };
  }
}

/**
 * Translate exceptions raised inside a bulk operation into a stable
 * `{ code, reason }` shape. The codes are part of the public contract
 * with the web client (see `BulkAssetFailure` in
 * `packages/shared/src/schemas/asset.ts`); add new codes here rather
 * than letting raw error messages leak through.
 */
function classifyBulkError(err: unknown): { code: string; reason: string } {
  if (err instanceof NotFoundException) {
    return { code: 'not_found', reason: 'Asset not found.' };
  }
  if (err instanceof ForbiddenException) {
    return { code: 'forbidden', reason: 'Permission denied.' };
  }
  if (err instanceof BadRequestException) {
    const msg = (err.getResponse() as { message?: string } | string) ?? err.message;
    const reason =
      typeof msg === 'string'
        ? msg
        : (msg.message ?? err.message);
    if (/already archived/i.test(reason)) {
      return { code: 'already_archived', reason };
    }
    if (/not archived/i.test(reason)) {
      return { code: 'not_archived', reason };
    }
    if (/archive the asset before/i.test(reason)) {
      return { code: 'not_archived', reason };
    }
    return { code: 'invalid', reason };
  }
  if (err instanceof ConflictException) {
    return { code: 'conflict', reason: err.message };
  }
  if (err instanceof Error) {
    return { code: 'error', reason: err.message };
  }
  return { code: 'error', reason: 'Unknown error.' };
}
