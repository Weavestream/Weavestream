import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  FindRelatedItemsToolInput,
  FindRelatedItemsToolOutput,
  SearchEntityKind,
} from '@weavestream/shared';
import { SearchService } from '../../search/search.service.js';
import { PermissionService } from '../../rbac/permission.service.js';
import { AI_TOOL_SPECS } from '../tool-specs.js';
import { GetRelatedItemsAiTool } from './get-related-items.tool.js';
import type { AiReadTool, AiToolExecutionContext } from '../tool-registry.js';

const RELATION_SOURCE_KINDS = new Set<SearchEntityKind>([
  'asset',
  'article',
  'password',
]);

/**
 * Resolves an explicit entity name and traverses its relationships in
 * one server-side tool call. This deliberately avoids trusting the
 * model to compose `search` → `get_related_items` without swapping in
 * the current page’s UUID between calls.
 */
@Injectable()
export class FindRelatedItemsAiTool implements AiReadTool {
  readonly spec = AI_TOOL_SPECS.find_related_items;

  constructor(
    private readonly search: SearchService,
    private readonly related: GetRelatedItemsAiTool,
    private readonly permissions: PermissionService,
  ) {}

  async resolveCompanyId(): Promise<'self-scoped'> {
    return 'self-scoped';
  }

  async execute(
    ctx: AiToolExecutionContext,
    args: Record<string, unknown>,
  ): Promise<FindRelatedItemsToolOutput> {
    const input = args as FindRelatedItemsToolInput;
    const result = await this.search.search(ctx.actor, {
      q: input.query,
      companyId: ctx.turnContext?.companyId,
      types: ['asset', 'article', 'password'],
      limit: 10,
    });
    const matches = result.items.filter(
      (item) =>
        RELATION_SOURCE_KINDS.has(item.kind) &&
        normalizeName(item.title) === normalizeName(input.query),
    );

    // Exact-one only: choosing among duplicate asset/article/password
    // names would recreate the same referent bug we are preventing.
    if (matches.length !== 1) throw new NotFoundException();
    const target = matches[0]!;

    const relationAccess = await this.permissions.can(ctx.actor, 'relation.read', {
      companyId: target.companyId,
    });
    if (!relationAccess.allowed) throw new ForbiddenException();

    return this.related.execute(
      ctx,
      {
        entity_type: target.kind,
        entity_id: target.id,
        entity_name: target.title,
      },
      target.companyId,
    );
  }
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}
