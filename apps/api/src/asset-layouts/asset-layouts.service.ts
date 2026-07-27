import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, AssetLayout, AssetField } from '@prisma/client';
import {
  type CreateAssetLayoutInput,
  type UpdateAssetLayoutInput,
  type SaveAssetFieldsInput,
  fieldOptionsSchemaFor,
  type FieldType,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { FieldTypesRegistry } from '../field-types/field-types.registry.js';
import { SearchIndexService } from '../search/search-index.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { assertStringIdList } from '../common/safe-id-list.js';

export interface AuditMeta {
  ip: string;
  userAgent: string;
}

export interface LayoutListOptions {
  q?: string;
  includeArchived?: boolean;
}

export interface LayoutStats {
  fieldCount: number;
  assetCount: number;
  companyCount: number;
}

export interface SerializedLayoutField {
  id: string;
  name: string;
  slug: string;
  fieldType: FieldType;
  position: number;
  isRequired: boolean;
  isUniquePerCompany: boolean;
  visibleToClients: boolean;
  isPrimary: boolean;
  showInTable: boolean;
  options: Record<string, unknown>;
  archivedAt: Date | null;
}

export interface SerializedLayout {
  id: string;
  name: string;
  slug: string;
  icon: string;
  color: string;
  isActive: boolean;
  version: number;
  position: number;
  archivedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  fields: SerializedLayoutField[];
}

@Injectable()
export class AssetLayoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly registry: FieldTypesRegistry,
    private readonly searchIndex: SearchIndexService,
  ) {}

  // --------------------------------------------------------------------
  // Read
  // --------------------------------------------------------------------

  /**
   * Phase 2c: CLIENT_USER actors receive only `visibleToClients` fields.
   * `AssetsService` already role-filters field *values*; without the
   * matching filter here the layout endpoints leak internal field
   * metadata (names/slugs of operator-only fields) to client users.
   * The filter is applied in the Prisma relation `WHERE` (CLAUDE.md §1 —
   * authorization at the query layer); `serialize` repeats it as
   * defense-in-depth only.
   */
  private fieldsInclude(role: AuthedUser['role']) {
    return {
      fields: {
        ...(role === 'CLIENT_USER' ? { where: { visibleToClients: true } } : {}),
        orderBy: { position: 'asc' as const },
      },
    };
  }

  async list(
    actor: AuthedUser,
    options: LayoutListOptions = {},
  ): Promise<SerializedLayout[]> {
    const where: Prisma.AssetLayoutWhereInput = {};
    if (!options.includeArchived) where.archivedAt = null;
    if (options.q) {
      where.OR = [
        { name: { contains: options.q, mode: 'insensitive' } },
        { slug: { contains: options.q.toLowerCase() } },
      ];
    }
    const layouts = await this.prisma.assetLayout.findMany({
      where,
      // Operator-curated position first; then alphabetical tiebreak so
      // layouts with the default position (0) fall back to a stable
      // ordering. Archived last so the UI can split them visually.
      orderBy: [
        { archivedAt: 'asc' },
        { position: 'asc' },
        { name: 'asc' },
      ],
      include: this.fieldsInclude(actor.role),
    });
    return layouts.map((l) => this.serialize(l, l.fields, actor.role));
  }

  async get(actor: AuthedUser, id: string): Promise<SerializedLayout> {
    const layout = await this.prisma.assetLayout.findUnique({
      where: { id },
      include: this.fieldsInclude(actor.role),
    });
    if (!layout) throw new NotFoundException();
    return this.serialize(layout, layout.fields, actor.role);
  }

  /**
   * Stats extension — populates the builder's meta subtitle
   * (`v13 · 13 fields · used by 483 assets in 8 companies`). Cheap on
   * small tables; a `(archivedAt, assetLayoutId)` Postgres aggregate
   * is fine until Phase 6 search.
   */
  async stats(id: string): Promise<LayoutStats> {
    const [fieldCount, assetAgg] = await Promise.all([
      this.prisma.assetField.count({ where: { assetLayoutId: id, archivedAt: null } }),
      this.prisma.asset.findMany({
        where: { assetLayoutId: id, archivedAt: null },
        distinct: ['companyId'],
        select: { companyId: true },
      }),
    ]);
    const assetCount = await this.prisma.asset.count({
      where: { assetLayoutId: id, archivedAt: null },
    });
    return { fieldCount, assetCount, companyCount: assetAgg.length };
  }

  // --------------------------------------------------------------------
  // Create / update meta / archive / restore
  // --------------------------------------------------------------------

  async create(
    actor: AuthedUser,
    input: CreateAssetLayoutInput,
    meta: AuditMeta,
  ): Promise<SerializedLayout> {
    const dupe = await this.prisma.assetLayout.findFirst({
      where: { slug: input.slug, archivedAt: null },
    });
    if (dupe) throw new ConflictException(`Layout slug "${input.slug}" is taken`);

    // Default new layouts to the end of the active-layout ordering so
    // they show up at the bottom of the sidebar until an operator drags
    // them into place. Callers can override via `input.position`.
    const position =
      input.position ??
      (await this.nextLayoutPosition());

    const layout = await this.prisma.assetLayout.create({
      data: {
        name: input.name,
        slug: input.slug,
        icon: input.icon,
        color: input.color,
        position,
        createdBy: actor.id,
      },
      include: { fields: true },
    });
    await this.audit.log({
      actorId: actor.id,
      action: 'layout.create',
      entityType: 'AssetLayout',
      entityId: layout.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: {
        name: layout.name,
        slug: layout.slug,
        icon: layout.icon,
        color: layout.color,
        position: layout.position,
        version: layout.version,
      },
    });
    return this.serialize(layout, layout.fields);
  }

  /**
   * Compute the next position for a new layout: max(position) + 1 over
   * active (non-archived) layouts, defaulting to 0 when the table is
   * empty. Kept as a method so the reorder endpoint can share it.
   */
  private async nextLayoutPosition(): Promise<number> {
    const last = await this.prisma.assetLayout.findFirst({
      where: { archivedAt: null },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    return last ? last.position + 1 : 0;
  }

  async update(
    actor: AuthedUser,
    id: string,
    input: UpdateAssetLayoutInput,
    meta: AuditMeta,
  ): Promise<SerializedLayout> {
    const before = await this.prisma.assetLayout.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();

    if (input.slug && input.slug !== before.slug) {
      const dupe = await this.prisma.assetLayout.findFirst({
        where: { slug: input.slug, archivedAt: null, NOT: { id } },
      });
      if (dupe) throw new ConflictException(`Layout slug "${input.slug}" is taken`);
    }

    const layout = await this.prisma.assetLayout.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        version: { increment: 1 },
      },
      include: { fields: { orderBy: { position: 'asc' } } },
    });
    await this.audit.log({
      actorId: actor.id,
      action: 'layout.update',
      entityType: 'AssetLayout',
      entityId: layout.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: {
        name: before.name,
        slug: before.slug,
        icon: before.icon,
        color: before.color,
        isActive: before.isActive,
        position: before.position,
        version: before.version,
      },
      after: {
        name: layout.name,
        slug: layout.slug,
        icon: layout.icon,
        color: layout.color,
        isActive: layout.isActive,
        position: layout.position,
        version: layout.version,
      },
    });
    return this.serialize(layout, layout.fields);
  }

  /**
   * Bulk re-assign `position` across the active layouts given an
   * ordered array of ids. Single transaction so the sidebar never
   * sees a partial apply. Out-of-scope ids (archived or unknown) are
   * rejected atomically; silent skipping would make the UI look like
   * it works but actually drop some layouts.
   */
  async reorder(
    actor: AuthedUser,
    orderedIds: string[],
    meta: AuditMeta,
  ): Promise<SerializedLayout[]> {
    const active = await this.prisma.assetLayout.findMany({
      where: { archivedAt: null },
      select: { id: true, position: true, name: true },
    });
    const activeIds = new Set(active.map((l) => l.id));
    const given = new Set(orderedIds);
    const missing = [...activeIds].filter((id) => !given.has(id));
    const unknown = orderedIds.filter((id) => !activeIds.has(id));
    if (missing.length > 0 || unknown.length > 0) {
      throw new BadRequestException({
        error: 'ReorderSetMismatch',
        message:
          'orderedIds must contain exactly every active layout id, no more and no less.',
        missing,
        unknown,
      });
    }

    const before = active.reduce<Record<string, number>>((acc, l) => {
      acc[l.id] = l.position;
      return acc;
    }, {});

    await this.prisma.$transaction(
      orderedIds.map((id, index) =>
        this.prisma.assetLayout.update({
          where: { id },
          data: { position: index },
        }),
      ),
    );

    const after = Object.fromEntries(
      orderedIds.map((id, index) => [id, index] as const),
    );
    await this.audit.log({
      actorId: actor.id,
      action: 'layout.reorder',
      entityType: 'AssetLayout',
      entityId: null,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before,
      after,
    });

    return this.list(actor);
  }

  async archive(
    actor: AuthedUser,
    id: string,
    meta: AuditMeta,
  ): Promise<SerializedLayout> {
    const before = await this.prisma.assetLayout.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();
    if (before.archivedAt) throw new BadRequestException('Already archived');

    const layout = await this.prisma.assetLayout.update({
      where: { id },
      data: { archivedAt: new Date(), isActive: false, version: { increment: 1 } },
      include: { fields: { orderBy: { position: 'asc' } } },
    });
    await this.audit.log({
      actorId: actor.id,
      action: 'layout.archive',
      entityType: 'AssetLayout',
      entityId: id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { archivedAt: null },
      after: { archivedAt: layout.archivedAt },
    });
    return this.serialize(layout, layout.fields);
  }

  async restore(
    actor: AuthedUser,
    id: string,
    meta: AuditMeta,
  ): Promise<SerializedLayout> {
    const before = await this.prisma.assetLayout.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();
    if (!before.archivedAt) throw new BadRequestException('Not archived');

    // Restoring a layout whose slug has been taken by another active
    // layout must be rejected — partial unique index would 500 otherwise.
    const clash = await this.prisma.assetLayout.findFirst({
      where: { slug: before.slug, archivedAt: null, NOT: { id } },
    });
    if (clash) {
      throw new ConflictException(
        `Another active layout already holds slug "${before.slug}"`,
      );
    }

    const layout = await this.prisma.assetLayout.update({
      where: { id },
      data: { archivedAt: null, isActive: true, version: { increment: 1 } },
      include: { fields: { orderBy: { position: 'asc' } } },
    });
    await this.audit.log({
      actorId: actor.id,
      action: 'layout.restore',
      entityType: 'AssetLayout',
      entityId: id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { archivedAt: before.archivedAt },
      after: { archivedAt: null },
    });
    return this.serialize(layout, layout.fields);
  }

  // --------------------------------------------------------------------
  // Field-list save
  // --------------------------------------------------------------------

  /**
   * Atomic diff-based save of the entire field list for a layout. Matches
   * the builder UI's save path: the client sends the authoritative ordered
   * list, the service diffs it against current rows and emits audit rows
   * per added/updated/removed field. Destructive removals (fields that
   * have values in any company) require `?force=true`; otherwise the
   * endpoint refuses and points the caller at force.
   */
  async saveFields(
    actor: AuthedUser,
    layoutId: string,
    input: SaveAssetFieldsInput,
    opts: { force?: boolean },
    meta: AuditMeta,
  ): Promise<SerializedLayout> {
    const before = await this.prisma.assetLayout.findUnique({
      where: { id: layoutId },
      include: { fields: true },
    });
    if (!before) throw new NotFoundException();
    if (before.archivedAt)
      throw new BadRequestException('Cannot edit fields on an archived layout');

    // Validate options per field type via the strategy registry.
    for (const f of input.fields) {
      const strategy = this.registry.get(f.fieldType);
      const res = strategy.optionsSchema.safeParse(
        fieldOptionsSchemaFor(f.fieldType).safeParse(f.options).success
          ? f.options
          : f.options,
      );
      if (!res.success) {
        throw new BadRequestException({
          error: 'InvalidFieldOptions',
          slug: f.slug,
          fieldType: f.fieldType,
          issues: res.error.issues,
        });
      }
    }

    // Diff by id.
    const incomingById = new Map(
      input.fields.filter((f) => f.id).map((f) => [f.id!, f] as const),
    );
    const existing = before.fields.filter((f) => f.archivedAt === null);
    const existingById = new Map(existing.map((f) => [f.id, f] as const));

    // Reject field-type changes on existing rows (D-009).
    for (const existingField of existing) {
      const incoming = incomingById.get(existingField.id);
      if (incoming && incoming.fieldType !== existingField.fieldType) {
        throw new BadRequestException({
          error: 'FieldTypeImmutable',
          slug: existingField.slug,
          message:
            'Field type is immutable after creation. Remove and add a new field with the desired type.',
        });
      }
    }

    // Detect destructive removals (field is no longer in the payload).
    const removedIds = existing
      .filter((f) => !incomingById.has(f.id))
      .map((f) => f.id);
    if (removedIds.length > 0 && !opts.force) {
      const withValues = await this.prisma.assetFieldValue.findMany({
        where: { assetFieldId: { in: removedIds } },
        select: {
          assetFieldId: true,
          asset: { select: { companyId: true } },
        },
      });
      if (withValues.length > 0) {
        const affectedFieldIds = Array.from(
          new Set(withValues.map((v) => v.assetFieldId)),
        );
        const affectedCompanyIds = Array.from(
          new Set(withValues.map((v) => v.asset.companyId)),
        );
        throw new BadRequestException({
          error: 'DestructiveFieldRemoval',
          message:
            'Removing fields that already have values requires ?force=true.',
          affectedFieldIds,
          affectedAssetCount: withValues.length,
          affectedCompanyIds,
        });
      }
    }

    const now = new Date();
    // Phase 9a: every audit entry carries the id + human-readable name
    // of the field it refers to so the admin audit page can render
    // "AssetField · <field name> on <layout>" without joining extra
    // tables. Previously these rows set `entityId: null`, which made
    // them impossible to trace back to a specific field.
    const addedAudits: Array<{ id: string; slug: string; name: string; fieldType: FieldType }> = [];
    const updatedAudits: Array<{
      id: string;
      slug: string;
      name: string;
      from: unknown;
      to: unknown;
    }> = [];

    const updatedLayout = await this.prisma.$transaction(async (tx) => {
      // Archive removed fields (soft). Destructive, but audit-friendly.
      if (removedIds.length > 0) {
        const safeRemovedIds = assertStringIdList(removedIds, 'removedIds');
        await tx.assetField.updateMany({
          where: { id: { in: safeRemovedIds } },
          data: { archivedAt: now },
        });
        if (opts.force) {
          // Tenant middleware requires a companyId filter on every write
          // to AssetFieldValue. Layouts/fields are global but their values
          // fan out across companies, so collect the distinct affected
          // tenants first and scope the delete to them.
          const affected = await tx.assetFieldValue.findMany({
            where: { assetFieldId: { in: safeRemovedIds } },
            select: { companyId: true },
            distinct: ['companyId'],
          });
          if (affected.length > 0) {
            await tx.assetFieldValue.deleteMany({
              where: {
                assetFieldId: { in: safeRemovedIds },
                companyId: { in: affected.map((a) => a.companyId) },
              },
            });
          }
        }
      }

      // Demote every current primary before the upsert loop runs.
      //
      // Postgres evaluates the partial unique index
      //   UNIQUE (asset_layout_id) WHERE is_primary = true AND archived_at IS NULL
      // at the end of each DML statement, not at commit time (Postgres
      // can't defer unique *indexes* — only unique *constraints* — and
      // partial uniques have to be indexes). So if the upsert loop
      // happens to visit the new primary before it visits the old one
      // to demote it, the write fails with P2002. Clearing all primaries
      // up-front guarantees 0-or-1 primaries after every subsequent
      // statement, regardless of the order the client sent fields in.
      await tx.assetField.updateMany({
        where: {
          assetLayoutId: layoutId,
          isPrimary: true,
          archivedAt: null,
        },
        data: { isPrimary: false },
      });

      // Upsert / create remaining rows in order.
      for (let i = 0; i < input.fields.length; i++) {
        const f = input.fields[i]!;
        const position = i;
        if (f.id && existingById.has(f.id)) {
          const old = existingById.get(f.id)!;
          await tx.assetField.update({
            where: { id: f.id },
            data: {
              name: f.name,
              slug: f.slug,
              position,
              isRequired: f.isRequired,
              isUniquePerCompany: f.isUniquePerCompany,
              visibleToClients: f.visibleToClients,
              isPrimary: f.isPrimary,
              showInTable: f.showInTable,
              options: f.options as Prisma.InputJsonValue,
            },
          });
          const diff = diffField(old, {
            name: f.name,
            slug: f.slug,
            position,
            isRequired: f.isRequired,
            isUniquePerCompany: f.isUniquePerCompany,
            visibleToClients: f.visibleToClients,
            isPrimary: f.isPrimary,
            showInTable: f.showInTable,
            options: f.options,
          });
          if (Object.keys(diff.before).length > 0) {
            updatedAudits.push({
              id: f.id,
              slug: f.slug,
              name: f.name,
              from: diff.before,
              to: diff.after,
            });
          }
        } else {
          const created = await tx.assetField.create({
            data: {
              assetLayoutId: layoutId,
              name: f.name,
              slug: f.slug,
              fieldType: f.fieldType,
              position,
              isRequired: f.isRequired,
              isUniquePerCompany: f.isUniquePerCompany,
              visibleToClients: f.visibleToClients,
              isPrimary: f.isPrimary,
              showInTable: f.showInTable,
              options: f.options as Prisma.InputJsonValue,
            },
          });
          addedAudits.push({
            id: created.id,
            slug: created.slug,
            name: created.name,
            fieldType: created.fieldType,
          });
        }
      }

      // Bump the layout version atomically.
      const layout = await tx.assetLayout.update({
        where: { id: layoutId },
        data: { version: { increment: 1 } },
        include: { fields: { where: { archivedAt: null }, orderBy: { position: 'asc' } } },
      });

      return layout;
    });

    // Emit audit rows outside the transaction but inside the same request.
    // Every entry points at the specific AssetField row it mutated and
    // embeds the layout + field name so the admin UI can render a
    // readable label without a JOIN.
    for (const a of addedAudits) {
      await this.audit.log({
        actorId: actor.id,
        action: 'layout.field.added',
        entityType: 'AssetField',
        entityId: a.id,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: {
          layoutId,
          layoutName: before.name,
          fieldId: a.id,
          fieldName: a.name,
          slug: a.slug,
          fieldType: a.fieldType,
        },
      });
    }
    for (const u of updatedAudits) {
      await this.audit.log({
        actorId: actor.id,
        action: 'layout.field.updated',
        entityType: 'AssetField',
        entityId: u.id,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: {
          layoutId,
          layoutName: before.name,
          fieldId: u.id,
          fieldName: u.name,
          slug: u.slug,
          ...((u.from as object) ?? {}),
        },
        after: {
          layoutId,
          layoutName: before.name,
          fieldId: u.id,
          fieldName: u.name,
          slug: u.slug,
          ...((u.to as object) ?? {}),
        },
      });
    }
    for (const rid of removedIds) {
      const removed = existingById.get(rid)!;
      await this.audit.log({
        actorId: actor.id,
        action: 'layout.field.removed',
        entityType: 'AssetField',
        entityId: rid,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: {
          layoutId,
          layoutName: before.name,
          fieldId: removed.id,
          fieldName: removed.name,
          slug: removed.slug,
          fieldType: removed.fieldType,
        },
        after: { forced: opts.force === true },
      });
    }

    // Phase 6: whenever field visibility flips or a field is removed,
    // every asset's denormalised `body_public` is stale. Rebuild the
    // search_index rows for the whole layout. Layout edits are
    // operator-only and low-frequency, so doing this synchronously in
    // the request is acceptable (batched in 200-row chunks by
    // `reindexLayout`). Field-value mutations have no impact on the
    // index beyond the per-asset path in AssetsService.
    const visibilityChanged = updatedAudits.some((u) =>
      Object.prototype.hasOwnProperty.call(u.from as object, 'visibleToClients'),
    );
    if (visibilityChanged || removedIds.length > 0) {
      await this.searchIndex.reindexLayout(layoutId);
    }

    return this.serialize(updatedLayout, updatedLayout.fields);
  }

  // --------------------------------------------------------------------
  // Serialization
  // --------------------------------------------------------------------

  private serialize(
    layout: AssetLayout,
    fields: AssetField[],
    role?: AuthedUser['role'],
  ): SerializedLayout {
    return {
      id: layout.id,
      name: layout.name,
      slug: layout.slug,
      icon: layout.icon,
      color: layout.color,
      isActive: layout.isActive,
      version: layout.version,
      position: layout.position,
      archivedAt: layout.archivedAt,
      createdBy: layout.createdBy,
      createdAt: layout.createdAt,
      updatedAt: layout.updatedAt,
      fields: fields
        .filter((f) => f.archivedAt === null)
        // Defense-in-depth only — the authoritative CLIENT_USER filter is
        // the relation `WHERE` in `fieldsInclude` (query layer, §1).
        .filter((f) => role !== 'CLIENT_USER' || f.visibleToClients)
        .sort((a, b) => a.position - b.position)
        .map((f) => ({
          id: f.id,
          name: f.name,
          slug: f.slug,
          fieldType: f.fieldType,
          position: f.position,
          isRequired: f.isRequired,
          isUniquePerCompany: f.isUniquePerCompany,
          visibleToClients: f.visibleToClients,
          isPrimary: f.isPrimary,
          showInTable: f.showInTable,
          options: (f.options ?? {}) as Record<string, unknown>,
          archivedAt: f.archivedAt,
        })),
    };
  }
}

type FieldShape = {
  name: string;
  slug: string;
  position: number;
  isRequired: boolean;
  isUniquePerCompany: boolean;
  visibleToClients: boolean;
  isPrimary: boolean;
  showInTable: boolean;
  options: unknown;
};

function diffField(
  before: AssetField,
  after: FieldShape,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  const keys: Array<keyof FieldShape> = [
    'name',
    'slug',
    'position',
    'isRequired',
    'isUniquePerCompany',
    'visibleToClients',
    'isPrimary',
    'showInTable',
    'options',
  ];
  for (const k of keys) {
    const bv = (before as unknown as Record<string, unknown>)[k as string];
    const av = (after as unknown as Record<string, unknown>)[k as string];
    if (JSON.stringify(bv) !== JSON.stringify(av)) {
      b[k as string] = bv;
      a[k as string] = av;
    }
  }
  return { before: b, after: a };
}
