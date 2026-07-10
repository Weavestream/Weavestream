import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  AiRelatedItem,
  GetRelatedItemsToolInput,
  GetRelatedItemsToolOutput,
} from '@weavestream/shared';
import { RelationsService } from '../../relations/relations.service.js';
import type { RelationEndpointKind } from '../../relations/relations.service.js';
import { PermissionService } from '../../rbac/permission.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { passwordReadWhereFor } from '../../passwords/password-access-policy.js';
import { entityHrefFor } from '../../search/entity-href.js';
import { AI_TOOL_SPECS } from '../tool-specs.js';
import { EntityScopeService } from '../entity-scope.js';
import type { AiReadTool, AiToolExecutionContext } from '../tool-registry.js';
import type { Action } from '../../rbac/permissions.js';

const SOURCE_READ_ACTION: Record<RelationEndpointKind, Action> = {
  asset: 'asset.read',
  article: 'article.read',
  password: 'password.read',
};

/**
 * `get_related_items` — the executor's `relation.read` entry gate is
 * necessary but not sufficient:
 *
 *  1. The SOURCE kind's own read permission must also hold (a user
 *     without `password.read` must not traverse from a password).
 *  2. A full source-row read runs BEFORE any relation query — archived
 *     rows, client-hidden articles, and restricted passwords must not
 *     leak their relationship graph through this tool
 *     (`RelationsService.listRelated` scans relation rows without
 *     validating the source).
 *  3. Every returned counterpart KIND is gated independently; an
 *     unauthorized kind's group is dropped entirely.
 *
 * `listRelated` itself additionally filters archived / client-hidden /
 * restricted counterparts — defense in depth.
 */
@Injectable()
export class GetRelatedItemsAiTool implements AiReadTool {
  readonly spec = AI_TOOL_SPECS.get_related_items;

  constructor(
    private readonly relations: RelationsService,
    private readonly permissions: PermissionService,
    private readonly prisma: PrismaService,
    private readonly entityScope: EntityScopeService,
  ) {}

  async resolveCompanyId(
    ctx: AiToolExecutionContext,
    args: Record<string, unknown>,
  ): Promise<string | null> {
    const input = args as GetRelatedItemsToolInput;
    return this.entityScope.resolveEntityCompany(
      ctx.tenant,
      input.entity_type,
      input.entity_id,
    );
  }

  async execute(
    ctx: AiToolExecutionContext,
    args: Record<string, unknown>,
    companyId: string | null,
  ): Promise<GetRelatedItemsToolOutput> {
    const input = args as GetRelatedItemsToolInput;
    if (companyId === null) throw new NotFoundException();

    // 1. Source-kind read permission.
    const sourceAction = SOURCE_READ_ACTION[input.entity_type];
    const decision = await this.permissions.can(ctx.actor, sourceAction, { companyId });
    if (!decision.allowed) throw new ForbiddenException();

    // 2. Standard source-row read: non-archived, article client
    // visibility, password restriction policy. Any miss → not found.
    const sourceTitle = await this.assertSourceReadable(
      ctx,
      input.entity_type,
      input.entity_id,
      companyId,
    );
    // The model has a UUID for the current page in its system context.
    // When a user explicitly names another entity, it can otherwise
    // accidentally reuse that current UUID and relabel the result in
    // prose. Bind the UUID to the displayed name the model supplied so
    // the server fails closed rather than returning relationships for a
    // different source.
    if (!sameEntityName(input.entity_name, sourceTitle)) {
      throw new NotFoundException();
    }

    // 3. Traverse, then gate every returned kind independently.
    const related = await this.relations.listRelated({
      actor: { id: ctx.actor.id, role: ctx.actor.role },
      companyId,
      entityType: input.entity_type,
      entityId: input.entity_id,
    });

    const kindAllowed: Record<RelationEndpointKind, boolean> = {
      asset: false,
      article: false,
      password: false,
    };
    for (const kind of ['asset', 'article', 'password'] as const) {
      if (related.groups[kind].length === 0) continue;
      const kindDecision = await this.permissions.can(
        ctx.actor,
        SOURCE_READ_ACTION[kind],
        { companyId },
      );
      kindAllowed[kind] = kindDecision.allowed;
    }
    const visible = related.items.filter((item) => kindAllowed[item.kind]);

    const items = await this.toOutputItems(ctx, companyId, visible);
    return { sourceTitle, items, totalCount: items.length };
  }

  private async assertSourceReadable(
    ctx: AiToolExecutionContext,
    kind: RelationEndpointKind,
    id: string,
    companyId: string,
  ): Promise<string> {
    const isClient = ctx.actor.role === 'CLIENT_USER';
    switch (kind) {
      case 'asset': {
        // Assets carry no client-visibility flag — archived is the only
        // per-row read gate beyond company scope.
        const found = await this.prisma.asset.findFirst({
          where: { id, companyId, archivedAt: null },
          select: { id: true, name: true },
        });
        if (!found) throw new NotFoundException();
        return found.name;
      }
      case 'article': {
        const found = await this.prisma.article.findFirst({
          where: {
            id,
            companyId,
            archivedAt: null,
            ...(isClient ? { visibleToClients: true } : {}),
          },
          select: { id: true, title: true },
        });
        if (!found) throw new NotFoundException();
        return found.title;
      }
      case 'password': {
        const found = await this.prisma.password.findFirst({
          where: {
            id,
            companyId,
            archivedAt: null,
            ...passwordReadWhereFor(ctx.actor),
          },
          select: { id: true, name: true },
        });
        if (!found) throw new NotFoundException();
        return found.name;
      }
    }
  }

  /**
   * Rebuild hrefs role-aware via the shared builder (the LinkedItem
   * href is admin-only). Slugs needed for client links are batch-
   * loaded per kind — one query each, only when items of that kind
   * survived the gates.
   */
  private async toOutputItems(
    ctx: AiToolExecutionContext,
    companyId: string,
    items: Array<{
      kind: RelationEndpointKind;
      id: string;
      title: string;
      relationType: string;
    }>,
  ): Promise<AiRelatedItem[]> {
    const isClient = ctx.actor.role === 'CLIENT_USER';
    const company = await this.prisma.company.findFirst({
      where: { id: companyId },
      select: { slug: true },
    });
    const companySlug = company?.slug ?? '';

    const articleIds = items.filter((i) => i.kind === 'article').map((i) => i.id);
    const assetIds = items.filter((i) => i.kind === 'asset').map((i) => i.id);
    const [articleSlugs, assetLayouts] = await Promise.all([
      isClient && articleIds.length > 0
        ? this.prisma.article.findMany({
            where: { id: { in: articleIds }, companyId },
            select: { id: true, slug: true },
          })
        : Promise.resolve([] as Array<{ id: string; slug: string }>),
      isClient && assetIds.length > 0
        ? this.prisma.asset.findMany({
            where: { id: { in: assetIds }, companyId },
            select: { id: true, assetLayout: { select: { slug: true } } },
          })
        : Promise.resolve(
            [] as Array<{ id: string; assetLayout: { slug: string } | null }>,
          ),
    ]);
    const articleSlugById = new Map(articleSlugs.map((a) => [a.id, a.slug]));
    const layoutSlugById = new Map(
      assetLayouts.map((a) => [a.id, a.assetLayout?.slug ?? null]),
    );

    return items.map((item) => ({
      kind: item.kind,
      id: item.id,
      title: item.title,
      href: entityHrefFor({
        kind: item.kind,
        entityId: item.id,
        companyId,
        companySlug,
        articleSlug: articleSlugById.get(item.id) ?? null,
        layoutSlug: layoutSlugById.get(item.id) ?? null,
        isClient,
      }),
      relationType: item.relationType,
    }));
  }
}

function sameEntityName(left: string, right: string): boolean {
  return normalizeEntityName(left) === normalizeEntityName(right);
}

function normalizeEntityName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}
