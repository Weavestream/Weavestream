import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  Prisma,
  Asset,
  AssetField,
  AssetFieldValue,
  AssetLayout,
} from '@prisma/client';
import type {
  CreateAssetInput,
  UpdateAssetInput,
  UserRole,
} from '@weavestream/shared';
import { FILTERABLE_FIELD_TYPES } from '@weavestream/shared';
import type { FileFieldEntry } from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { FieldTypesRegistry } from '../field-types/field-types.registry.js';
import { RelationsService } from '../relations/relations.service.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { SearchIndexService } from '../search/search-index.service.js';
import { PasswordsService } from '../passwords/passwords.service.js';
import { buildAssetZodSchema } from './build-asset-schema.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

export interface AuditMeta {
  ip: string;
  userAgent: string;
}

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
    await this.hydrateActors(serialized);
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
    await this.hydrateFileFields(companyId, [serialized]);
    await this.hydrateAssetReferences(companyId, [serialized]);
    await this.hydrateActors([serialized]);
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
      const created = await tx.asset.create({
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

      await this.persistFieldValues(
        tx,
        layout,
        created.id,
        companyId,
        validated,
        actor.id,
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

    if (input.externalId !== undefined) {
      if (input.externalId !== null) {
        await this.assertExternalIdFree(
          companyId,
          input.externalId,
          input.externalSource ?? existing.externalSource,
          id,
        );
      }
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
      await this.persistFieldValues(tx, layout, id, companyId, validated, actor.id);
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
        fieldValues: validated,
      },
    });

    return this.get(actor, companyId, id);
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

  // --------------------------------------------------------------------
  // Validation + persistence
  // --------------------------------------------------------------------

  private async loadLayout(layoutId: string): Promise<LayoutWithFields> {
    const layout = await this.prisma.assetLayout.findUnique({
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
      normalized[slug] = strategy.normalize(value, (field.options ?? {}) as Record<string, unknown>);
    }
    return normalized;
  }

  private async assertUniqueValues(
    layout: LayoutWithFields,
    companyId: string,
    values: Record<string, unknown>,
    excludeAssetId: string | null,
  ): Promise<void> {
    for (const field of layout.fields) {
      if (field.archivedAt !== null) continue;
      if (!field.isUniquePerCompany) continue;
      const value = values[field.slug];
      if (value === null || value === undefined || value === '') continue;

      const clash = await this.prisma.assetFieldValue.findFirst({
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
  ): Promise<void> {
    const clash = await this.prisma.asset.findFirst({
      where: {
        companyId,
        externalId,
        externalSource,
        ...(excludeAssetId ? { NOT: { id: excludeAssetId } } : {}),
      },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException({
        error: 'ExternalIdTaken',
        externalId,
        externalSource,
        message: `Another asset already carries external id "${externalId}".`,
      });
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
  ): Promise<void> {
    for (const [slug, value] of Object.entries(values)) {
      const field = layout.fields.find((f) => f.slug === slug && f.archivedAt === null);
      if (!field) continue;
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

      const strategy = this.registry.get(field.fieldType);
      if (strategy.onRelate) {
        await strategy.onRelate(value, {
          companyId,
          assetId,
          field: {
            id: field.id,
            slug: field.slug,
            options: (field.options ?? {}) as Record<string, unknown>,
          },
          actorId,
          tx,
          relations: this.relations,
        });
      }
    }
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
   * include fresh presigned `thumbnailUrl` and `downloadUrl`. Batched in
   * a single `uploads` query per call so listing N assets with FILE
   * fields is one SELECT, not N. Mutates `assets` in place.
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
    };
  }
}
