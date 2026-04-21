import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { UserRole } from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  RelationPort,
  RelationReplaceCtx,
} from '../field-types/field-type-strategy.js';

export interface LinkInput {
  companyId: string;
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  relationType: string;
  actorId: string | null;
  tx?: Prisma.TransactionClient;
}

export interface UnlinkInput {
  companyId: string;
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  relationType: string;
  tx?: Prisma.TransactionClient;
}

export interface CleanupForAssetInput {
  companyId: string;
  assetId: string;
  tx: Prisma.TransactionClient;
}

/**
 * Canonical casing for the polymorphic endpoints persisted on Relation rows.
 * REST inputs use lowercase (`asset` / `article`) for consistency with
 * `/search/mentions`; we normalize at the boundary.
 */
export const RELATION_ENDPOINT_KINDS = ['asset', 'article'] as const;
export type RelationEndpointKind = (typeof RELATION_ENDPOINT_KINDS)[number];
export const RELATION_ENTITY_TYPE: Record<RelationEndpointKind, string> = {
  asset: 'Asset',
  article: 'Article',
};

export interface ListRelatedInput {
  actor: { id: string; role: UserRole };
  companyId: string;
  entityType: RelationEndpointKind;
  entityId: string;
}

export interface LinkedItem {
  /** The Relation row id — used as the delete key. */
  relationId: string;
  /** `'asset' | 'article'` — matches REST input casing. */
  kind: RelationEndpointKind;
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
  icon: string | null;
  color: string | null;
  relationType: string;
  /** `'outgoing'` = current entity is the source row. `'incoming'` = current entity is the target. */
  direction: 'outgoing' | 'incoming';
  /** True when the row was created by an ASSET_REFERENCE field write (non-`'manual'`). Clients render these as system-managed. */
  isFieldManaged: boolean;
  createdAt: Date;
}

export interface ListRelatedResult {
  items: LinkedItem[];
  groups: Record<RelationEndpointKind, LinkedItem[]>;
  totalCount: number;
}

/**
 * Default relationType for manually-created links. Kept distinct from
 * ASSET_REFERENCE-owned rows so `replaceForField` sweeps don't eat manual
 * links and the UI can badge them differently.
 */
export const MANUAL_RELATION_TYPE = 'manual';

const TYPE_TO_KIND: Record<string, RelationEndpointKind> = {
  Asset: 'asset',
  Article: 'article',
};

/**
 * Phase 3: polymorphic-link service. Shapes Relation rows on behalf of
 * field-type strategies (`ASSET_REFERENCE.onRelate`) and asset lifecycle
 * (hard delete). Same-company only; cross-company writes throw so an
 * ASSET_REFERENCE into another tenant's asset can never persist.
 *
 * No controller and no module-level export until Phase 5 (see DECISIONS.md
 * D-008 relation-scaffold-phase-3). Idempotent everywhere so duplicated
 * saves don't multiply rows — the schema has a unique index covering
 * `(sourceType, sourceId, targetType, targetId, relationType)`.
 */
@Injectable()
export class RelationsService implements RelationPort {
  constructor(private readonly prisma: PrismaService) {}

  async link(input: LinkInput): Promise<void> {
    this.guardSameCompany(input);
    const client = input.tx ?? this.prisma;
    await client.relation.upsert({
      where: {
        sourceType_sourceId_targetType_targetId_relationType: {
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          targetType: input.targetType,
          targetId: input.targetId,
          relationType: input.relationType,
        },
      },
      create: {
        companyId: input.companyId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        targetType: input.targetType,
        targetId: input.targetId,
        relationType: input.relationType,
        createdBy: input.actorId,
      },
      update: {}, // idempotent
    });
  }

  async unlink(input: UnlinkInput): Promise<void> {
    const client = input.tx ?? this.prisma;
    // `deleteMany` is idempotent — missing rows are a no-op.
    await client.relation.deleteMany({
      where: {
        companyId: input.companyId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        targetType: input.targetType,
        targetId: input.targetId,
        relationType: input.relationType,
      },
    });
  }

  /**
   * Replace the entire set of (source → *) rows of a given relationType
   * with the passed target id list. Used by ASSET_REFERENCE writes: one
   * field edit translates into a single idempotent sync of relation rows.
   * Same-company invariant enforced by spot-checking each target asset.
   */
  async replaceForField(ctx: RelationReplaceCtx): Promise<void> {
    const client = ctx.tx;
    const uniqueTargets = Array.from(new Set(ctx.targetIds));

    if (uniqueTargets.length > 0 && ctx.targetType === 'Asset') {
      const sameCompanyCount = await client.asset.count({
        where: { id: { in: uniqueTargets }, companyId: ctx.companyId },
      });
      if (sameCompanyCount !== uniqueTargets.length) {
        throw new BadRequestException(
          'ASSET_REFERENCE target must belong to the same company as the source asset.',
        );
      }
    }

    await client.relation.deleteMany({
      where: {
        companyId: ctx.companyId,
        sourceType: ctx.sourceType,
        sourceId: ctx.sourceId,
        relationType: ctx.relationType,
        ...(uniqueTargets.length > 0
          ? { NOT: { targetId: { in: uniqueTargets } } }
          : {}),
      },
    });

    if (uniqueTargets.length === 0) return;

    // upsert each to keep idempotency under the unique constraint. This is
    // O(n) SQL calls but n is bounded by the field's maxLength (100).
    for (const targetId of uniqueTargets) {
      await client.relation.upsert({
        where: {
          sourceType_sourceId_targetType_targetId_relationType: {
            sourceType: ctx.sourceType,
            sourceId: ctx.sourceId,
            targetType: ctx.targetType,
            targetId,
            relationType: ctx.relationType,
          },
        },
        create: {
          companyId: ctx.companyId,
          sourceType: ctx.sourceType,
          sourceId: ctx.sourceId,
          targetType: ctx.targetType,
          targetId,
          relationType: ctx.relationType,
          createdBy: ctx.actorId,
        },
        update: {},
      });
    }
  }

  /**
   * Called inside asset hard-delete transactions: Prisma can't cascade on
   * polymorphic FKs, so we delete any relation row that touches the asset
   * as source or target before the asset row itself goes away.
   */
  async cleanupForAsset(input: CleanupForAssetInput): Promise<void> {
    await input.tx.relation.deleteMany({
      where: {
        companyId: input.companyId,
        OR: [
          { sourceType: 'Asset', sourceId: input.assetId },
          { targetType: 'Asset', targetId: input.assetId },
        ],
      },
    });
  }

  // --------------------------------------------------------------
  // Phase 5 read/write surface (controller-backed)
  // --------------------------------------------------------------

  /**
   * Return every Relation row where the given entity sits on either end,
   * hydrated with enough detail for the Linked Items UI and filtered for
   * archived entities + client visibility. Polymorphic endpoints other
   * than `Asset` / `Article` are ignored so old rows (or future kinds not
   * yet mapped) don't leak through the API before the UI can render them.
   */
  async listRelated(input: ListRelatedInput): Promise<ListRelatedResult> {
    const entityTypeDb = RELATION_ENTITY_TYPE[input.entityType];
    const rows = await this.prisma.relation.findMany({
      where: {
        companyId: input.companyId,
        OR: [
          { sourceType: entityTypeDb, sourceId: input.entityId },
          { targetType: entityTypeDb, targetId: input.entityId },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });

    interface Counterpart {
      kind: RelationEndpointKind;
      id: string;
    }
    const counterparts: Array<{ row: (typeof rows)[number]; counterpart: Counterpart }> = [];
    for (const row of rows) {
      const isOutgoing = row.sourceType === entityTypeDb && row.sourceId === input.entityId;
      const otherType = isOutgoing ? row.targetType : row.sourceType;
      const otherId = isOutgoing ? row.targetId : row.sourceId;
      const kind = TYPE_TO_KIND[otherType];
      if (!kind) continue; // unknown polymorphic kind — skip silently.
      counterparts.push({ row, counterpart: { kind, id: otherId } });
    }

    const assetIds = counterparts
      .filter((c) => c.counterpart.kind === 'asset')
      .map((c) => c.counterpart.id);
    const articleIds = counterparts
      .filter((c) => c.counterpart.kind === 'article')
      .map((c) => c.counterpart.id);

    const [assetRows, articleRows] = await Promise.all([
      assetIds.length > 0
        ? this.prisma.asset.findMany({
            where: {
              companyId: input.companyId,
              id: { in: assetIds },
              archivedAt: null,
            },
            include: { assetLayout: true },
          })
        : [],
      articleIds.length > 0
        ? this.prisma.article.findMany({
            where: {
              companyId: input.companyId,
              id: { in: articleIds },
              archivedAt: null,
              ...(input.actor.role === 'CLIENT_USER' ? { visibleToClients: true } : {}),
            },
          })
        : [],
    ]);

    const assetById = new Map(assetRows.map((a) => [a.id, a]));
    const articleById = new Map(articleRows.map((a) => [a.id, a]));

    const items: LinkedItem[] = [];
    for (const { row, counterpart } of counterparts) {
      const isOutgoing = row.sourceType === entityTypeDb && row.sourceId === input.entityId;
      const isFieldManaged = row.relationType !== MANUAL_RELATION_TYPE;

      if (counterpart.kind === 'asset') {
        const asset = assetById.get(counterpart.id);
        if (!asset) continue; // archived or cross-company (defensive)
        items.push({
          relationId: row.id,
          kind: 'asset',
          id: asset.id,
          title: asset.name,
          subtitle: asset.assetLayout?.name ?? null,
          href: `/admin/companies/${asset.companyId}/assets/${asset.id}`,
          icon: asset.assetLayout?.icon ?? null,
          color: asset.assetLayout?.color ?? null,
          relationType: row.relationType,
          direction: isOutgoing ? 'outgoing' : 'incoming',
          isFieldManaged,
          createdAt: row.createdAt,
        });
      } else if (counterpart.kind === 'article') {
        const article = articleById.get(counterpart.id);
        if (!article) continue; // archived or hidden-to-client
        items.push({
          relationId: row.id,
          kind: 'article',
          id: article.id,
          title: article.title,
          subtitle: article.excerpt ?? null,
          href: `/admin/companies/${article.companyId}/articles/${article.id}`,
          icon: null,
          color: null,
          relationType: row.relationType,
          direction: isOutgoing ? 'outgoing' : 'incoming',
          isFieldManaged,
          createdAt: row.createdAt,
        });
      }
    }

    const groups: Record<RelationEndpointKind, LinkedItem[]> = {
      asset: items.filter((i) => i.kind === 'asset'),
      article: items.filter((i) => i.kind === 'article'),
    };

    return { items, groups, totalCount: items.length };
  }

  /**
   * Distinct relationType strings seen in this company, for the
   * `<datalist>` autocomplete in the Add-Link modal. Capped to 50.
   */
  async listRelationTypes(companyId: string, q?: string): Promise<string[]> {
    const needle = q?.trim();
    const rows = await this.prisma.relation.findMany({
      where: {
        companyId,
        ...(needle ? { relationType: { contains: needle, mode: 'insensitive' } } : {}),
      },
      select: { relationType: true },
      distinct: ['relationType'],
      orderBy: { relationType: 'asc' },
      take: 50,
    });
    return rows.map((r) => r.relationType);
  }

  /**
   * Delete a Relation by id. Scoped to company — returns `null` when the
   * row isn't found in this company so callers can 404 cleanly.
   */
  async deleteById(
    companyId: string,
    relationId: string,
  ): Promise<{
    sourceType: string;
    sourceId: string;
    targetType: string;
    targetId: string;
    relationType: string;
  } | null> {
    const existing = await this.prisma.relation.findFirst({
      where: { id: relationId, companyId },
    });
    if (!existing) return null;
    await this.prisma.relation.deleteMany({ where: { id: relationId, companyId } });
    return {
      sourceType: existing.sourceType,
      sourceId: existing.sourceId,
      targetType: existing.targetType,
      targetId: existing.targetId,
      relationType: existing.relationType,
    };
  }

  /**
   * Look up a relation by its polymorphic composite key — returns the id
   * or null. Used by the controller when the client doesn't yet know the
   * Relation.id (fresh link → redirect to listRelated).
   */
  async findByKey(input: UnlinkInput): Promise<{ id: string } | null> {
    const row = await this.prisma.relation.findFirst({
      where: {
        companyId: input.companyId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        targetType: input.targetType,
        targetId: input.targetId,
        relationType: input.relationType,
      },
      select: { id: true },
    });
    return row;
  }

  /**
   * Guard that both endpoints (Asset/Article) live in the same company as
   * the relation record. Called by the controller before `link()`.
   */
  async assertEndpointsInCompany(args: {
    companyId: string;
    sourceType: RelationEndpointKind;
    sourceId: string;
    targetType: RelationEndpointKind;
    targetId: string;
  }): Promise<void> {
    const checks: Array<Promise<unknown>> = [];
    const queue = [
      { kind: args.sourceType, id: args.sourceId, label: 'source' as const },
      { kind: args.targetType, id: args.targetId, label: 'target' as const },
    ];
    for (const endpoint of queue) {
      if (endpoint.kind === 'asset') {
        checks.push(
          this.prisma.asset
            .findFirst({
              where: {
                id: endpoint.id,
                companyId: args.companyId,
                archivedAt: null,
              },
              select: { id: true },
            })
            .then((row) => {
              if (!row) {
                throw new BadRequestException({
                  error: 'RelationEndpointNotFound',
                  endpoint: endpoint.label,
                  kind: endpoint.kind,
                  id: endpoint.id,
                  message: `${endpoint.label} asset does not exist in this company (or is archived).`,
                });
              }
            }),
        );
      } else {
        checks.push(
          this.prisma.article
            .findFirst({
              where: {
                id: endpoint.id,
                companyId: args.companyId,
                archivedAt: null,
              },
              select: { id: true },
            })
            .then((row) => {
              if (!row) {
                throw new BadRequestException({
                  error: 'RelationEndpointNotFound',
                  endpoint: endpoint.label,
                  kind: endpoint.kind,
                  id: endpoint.id,
                  message: `${endpoint.label} article does not exist in this company (or is archived).`,
                });
              }
            }),
        );
      }
    }
    await Promise.all(checks);
  }

  private guardSameCompany(input: {
    companyId: string;
    sourceType: string;
    sourceId: string;
    targetType: string;
    targetId: string;
  }) {
    if (input.sourceId === input.targetId && input.sourceType === input.targetType) {
      throw new BadRequestException('A relation cannot point at itself.');
    }
  }
}
